/**
 * Auth service — singleton, multi-provider, storage-backed token store
 * with lazy refresh.
 *
 * Why this exists
 * ───────────────
 * The previous React-context-based provider auth had two compounding loops:
 *
 *   1. A scheduled refresh timer with a `Math.max(0, …)` floor would fire
 *      with a 0ms delay any time the issued token's TTL was shorter than
 *      the 5-min refresh-lead, pumping endless POSTs to the token endpoint.
 *   2. Every `setProviderToken` rebuilt a `useMemo` value, flipping the
 *      identity of `ensureFreshProviderToken`, which any consumer
 *      `useEffect` listing it as a dep would re-run, kicking off another
 *      `searchVariations` request before the previous resolved.
 *
 * This service kills both classes by construction:
 *
 *   - Lazy refresh on read (no timers exist; nothing can pump them).
 *   - Module-scoped state with stable function exports (no `useMemo` /
 *     `useCallback` involved; identity never changes for the lifetime
 *     of the module).
 *   - Single-flight refresh per provider so concurrent callers dedup
 *     onto one inflight promise.
 *   - Storage-backed so a reload doesn't force a re-fetch and the user
 *     doesn't see a brief unauthenticated state on app start.
 *
 * Multi-tenancy
 * ─────────────
 * State is keyed by an opaque `ProviderKey` (string). Today's callers all
 * pass nothing and behave as single-tenant under `'default'`. When the
 * connection-manager work lands, callers will pass the active provider's
 * UOI as the key, and tokens for different providers won't fight.
 *
 * Components shouldn't handle auth logic
 * ──────────────────────────────────────
 * The service exposes `authedFetch(input, init?, key?)` — domain network
 * code calls it directly and never sees a token. UI components that need
 * to render based on auth state subscribe via `useAuth()` (a thin
 * `useSyncExternalStore` wrapper, in `hooks/use-auth.ts`).
 */

import { requestProviderToken, type ProviderToken } from '../api/cert-client';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Treat a token as expired this many seconds early. Covers clock skew
 * between client and server and avoids the "still valid for 100ms" race
 * where a request goes out with a token that expires mid-flight.
 */
const EXPIRATION_DRIFT_S = 30;

/**
 * Fallback TTL when the token endpoint omits or returns an invalid
 * `expires_in`. 15 min matches the legacy `reso-certification-utils`
 * oauth2.js default.
 */
const DEFAULT_EXPIRATION_S = 15 * 60;

/** Default `ProviderKey` for callers that don't multi-tenant. */
const DEFAULT_KEY: ProviderKey = 'default';

/** Storage key prefix for persisted state. */
const STORAGE_PREFIX = 'auth:provider:';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Opaque identifier for a provider's auth state. Conventional values:
 * - `'default'` — single-tenant callers (today's path)
 * - a provider UOI — when the connection manager wires multi-provider
 */
export type ProviderKey = string;

/** Credentials issued by the cert API user-login flow. */
export interface ProviderCredentials {
  readonly username: string;
  /** The cert API token returned by /api/v1/sessions; doubles as the OAuth2 client_secret. */
  readonly apiToken: string;
}

/**
 * Abstracted storage for credentials and tokens. Implementations:
 *   - Electron: safeStorage-backed via window.electronStorage (encrypted by OS keychain)
 *   - Browser:  sessionStorage (per-tab, cleared on close, unencrypted but not durable)
 *
 * The service picks an implementation at module init based on
 * `window.electronStorage` presence.
 */
export interface AuthStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

interface ProviderState {
  credentials: ProviderCredentials | null;
  token: ProviderToken | null;
  /** Single-flight refresh — concurrent callers await this same promise. */
  inflight: Promise<string> | null;
  /** True once we've attempted to hydrate from storage; prevents double-hydration. */
  hydrated: boolean;
}

// ── Storage adapter selection ────────────────────────────────────────

interface ElectronStorageBridge {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const getElectronStorage = (): ElectronStorageBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronStorage?: ElectronStorageBridge }).electronStorage;
};

const electronStorage = (): AuthStorage => {
  const bridge = getElectronStorage();
  if (!bridge) throw new Error('electronStorage bridge missing');
  return bridge;
};

const browserSessionStorage = (): AuthStorage => ({
  get: async (key) => {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage.getItem(key);
  },
  set: async (key, value) => {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(key, value);
  },
  remove: async (key) => {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.removeItem(key);
  },
});

const inMemoryStorage = (): AuthStorage => {
  const store = new Map<string, string>();
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); },
    remove: async (k) => { store.delete(k); },
  };
};

const chooseStorage = (): AuthStorage => {
  if (getElectronStorage()) return electronStorage();
  if (typeof sessionStorage !== 'undefined') return browserSessionStorage();
  return inMemoryStorage();
};

// ── Module-scoped state ──────────────────────────────────────────────

let _storage: AuthStorage = chooseStorage();
const _providers = new Map<ProviderKey, ProviderState>();
const _subscribers = new Set<() => void>();

const notify = (): void => {
  for (const fn of _subscribers) fn();
};

const ensureProviderState = (key: ProviderKey): ProviderState => {
  let state = _providers.get(key);
  if (!state) {
    state = { credentials: null, token: null, inflight: null, hydrated: false };
    _providers.set(key, state);
  }
  return state;
};

// ── Storage helpers ──────────────────────────────────────────────────

const credKey = (key: ProviderKey): string => `${STORAGE_PREFIX}${key}:credentials`;
const tokenKey = (key: ProviderKey): string => `${STORAGE_PREFIX}${key}:token`;

const persistCredentials = async (key: ProviderKey, creds: ProviderCredentials | null): Promise<void> => {
  if (creds) await _storage.set(credKey(key), JSON.stringify(creds));
  else await _storage.remove(credKey(key));
};

const persistToken = async (key: ProviderKey, token: ProviderToken | null): Promise<void> => {
  if (token) await _storage.set(tokenKey(key), JSON.stringify(token));
  else await _storage.remove(tokenKey(key));
};

const hydrateProvider = async (key: ProviderKey, state: ProviderState): Promise<void> => {
  if (state.hydrated) return;
  state.hydrated = true;
  try {
    const credRaw = await _storage.get(credKey(key));
    if (credRaw) state.credentials = JSON.parse(credRaw) as ProviderCredentials;
    const tokenRaw = await _storage.get(tokenKey(key));
    if (tokenRaw) state.token = JSON.parse(tokenRaw) as ProviderToken;
  } catch {
    // Corrupt storage is recoverable — treat as unauthenticated and
    // force a fresh sign-in. Don't crash the app.
    state.credentials = null;
    state.token = null;
  }
};

// ── Token validity ───────────────────────────────────────────────────

const isTokenValid = (token: ProviderToken | null): boolean => {
  if (!token) return false;
  const expiresAtMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs - Date.now() > EXPIRATION_DRIFT_S * 1000;
};

const computeFallbackExpiry = (): string =>
  new Date(Date.now() + DEFAULT_EXPIRATION_S * 1000).toISOString();

const sanitizeToken = (token: ProviderToken): ProviderToken => {
  // requestProviderToken already computes expiresAt from server's
  // expires_in, but defensively handle a missing/garbage value by
  // falling back to DEFAULT_EXPIRATION_S so we never persist a token
  // that's "always expired" or "never expires."
  if (!token.expiresAt || !Number.isFinite(Date.parse(token.expiresAt))) {
    return { ...token, expiresAt: computeFallbackExpiry() };
  }
  return token;
};

// ── Refresh (single-flight per key) ──────────────────────────────────

const fetchFreshToken = async (key: ProviderKey): Promise<string> => {
  const state = ensureProviderState(key);
  if (!state.credentials) {
    throw new AuthError(
      `No credentials available for provider "${key}". Sign in or call setCredentials() before requesting a token.`,
      'no-credentials',
    );
  }
  const fresh = sanitizeToken(
    await requestProviderToken(state.credentials.username, state.credentials.apiToken),
  );
  state.token = fresh;
  await persistToken(key, fresh);
  notify();
  return fresh.accessToken;
};

const refresh = (key: ProviderKey): Promise<string> => {
  const state = ensureProviderState(key);
  // Single-flight: if a refresh is already in progress for this key,
  // every concurrent caller waits on the same promise. Cleared in
  // .finally() so the next call after settlement starts fresh.
  if (state.inflight) return state.inflight;
  state.inflight = fetchFreshToken(key).finally(() => {
    state.inflight = null;
  });
  return state.inflight;
};

// ── Public API ───────────────────────────────────────────────────────

export class AuthError extends Error {
  constructor(message: string, public readonly code: 'no-credentials' | 'token-fetch-failed' | 'unauthorized') {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Set credentials for a provider. Persists to storage. Does NOT eagerly
 * fetch a token — the next `getBearerToken()` / `authedFetch()` call
 * triggers the refresh lazily.
 *
 * Idempotent: calling with the same credentials is a cheap no-op write.
 */
export const setCredentials = async (
  credentials: ProviderCredentials,
  key: ProviderKey = DEFAULT_KEY,
): Promise<void> => {
  const state = ensureProviderState(key);
  await hydrateProvider(key, state);
  state.credentials = credentials;
  // New credentials invalidate any existing token for this key.
  state.token = null;
  await Promise.all([persistCredentials(key, credentials), persistToken(key, null)]);
  notify();
};

/**
 * Drop all state for a provider — credentials, cached token, in-flight
 * refresh. Persisted entries are removed too. Use on sign-out or when
 * a connection is removed.
 */
export const clearProvider = async (key: ProviderKey = DEFAULT_KEY): Promise<void> => {
  const state = ensureProviderState(key);
  state.credentials = null;
  state.token = null;
  state.inflight = null;
  await Promise.all([persistCredentials(key, null), persistToken(key, null)]);
  notify();
};

/**
 * Return a valid bearer token for the given provider. Refreshes lazily
 * if the cached token is expired or missing. Concurrent callers for the
 * same key share one in-flight refresh.
 */
export const getBearerToken = async (key: ProviderKey = DEFAULT_KEY): Promise<string> => {
  const state = ensureProviderState(key);
  await hydrateProvider(key, state);
  if (isTokenValid(state.token)) return state.token!.accessToken;
  return refresh(key);
};

/** Build an `Authorization: Bearer …` header. */
export const getAuthHeader = async (
  key: ProviderKey = DEFAULT_KEY,
): Promise<{ Authorization: string }> => {
  const accessToken = await getBearerToken(key);
  return { Authorization: `Bearer ${accessToken}` };
};

/**
 * Fetch wrapper that injects the right Authorization header and retries
 * once on a 401 (single-flight refresh — concurrent 401s dedup onto one
 * fresh-token fetch). Call sites pass the URL and init exactly as they
 * would to `fetch`; the service handles auth.
 *
 * On a 401 after retry, throws AuthError so callers can surface the
 * failure (typical UX: prompt the user to re-authenticate).
 */
export const authedFetch = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  key: ProviderKey = DEFAULT_KEY,
): Promise<Response> => {
  const attempt = async (forceRefresh: boolean): Promise<Response> => {
    if (forceRefresh) {
      // 401 retry path: drop the cached token and refresh.
      const state = ensureProviderState(key);
      state.token = null;
      await persistToken(key, null);
    }
    const header = await getAuthHeader(key);
    const headers = new Headers(init.headers);
    headers.set('Authorization', header.Authorization);
    return fetch(input, { ...init, headers });
  };

  const first = await attempt(false);
  if (first.status !== 401) return first;
  const second = await attempt(true);
  if (second.status === 401) {
    throw new AuthError(
      `Authorization rejected after refresh for provider "${key}".`,
      'unauthorized',
    );
  }
  return second;
};

// ── Read-only state for UI hooks ─────────────────────────────────────

/**
 * Snapshot of provider auth state for reactive UI (`useAuth()`). Only
 * exposes safe-to-render-with fields — never the raw token. Components
 * that need network behavior call `authedFetch` instead.
 */
export interface AuthSnapshot {
  readonly hasCredentials: (key?: ProviderKey) => boolean;
  readonly hasValidToken: (key?: ProviderKey) => boolean;
  readonly username: (key?: ProviderKey) => string | null;
}

export const getSnapshot = (): AuthSnapshot => ({
  hasCredentials: (key = DEFAULT_KEY) => !!_providers.get(key)?.credentials,
  hasValidToken: (key = DEFAULT_KEY) => isTokenValid(_providers.get(key)?.token ?? null),
  username: (key = DEFAULT_KEY) => _providers.get(key)?.credentials?.username ?? null,
});

/**
 * Subscribe to auth-state changes. Returns an unsubscribe function.
 * Used by `useAuth()` (`useSyncExternalStore`) to drive UI re-renders
 * on sign-in / sign-out / token-refresh events.
 */
export const subscribe = (fn: () => void): (() => void) => {
  _subscribers.add(fn);
  return () => { _subscribers.delete(fn); };
};

// ── Test hooks ───────────────────────────────────────────────────────

/** Reset all state. For test setup only. */
export const __resetForTesting = (): void => {
  _providers.clear();
  _subscribers.clear();
  _storage = chooseStorage();
};

/** Override the storage adapter. For test setup only. */
export const __setStorageForTesting = (storage: AuthStorage): void => {
  _storage = storage;
};
