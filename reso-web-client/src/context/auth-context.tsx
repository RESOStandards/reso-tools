/**
 * RESO Cert authentication context.
 *
 * Holds the signed-in user, the Cert API key, and the OAuth2 provider token
 * for services.reso.org. Performs the two-step login (account/login then
 * oauth2/token) atomically and schedules a refresh for the provider token
 * before it expires.
 *
 * Storage strategy:
 * - User profile + Cert API key persist via the secure storage adapter
 *   (Electron `safeStorage` → OS keychain when running in the desktop
 *   client; localStorage fallback when running in a plain browser).
 * - Credentials (username + password) ALSO persist via secure storage so
 *   the desktop client can refresh the provider token transparently
 *   across app restarts without re-prompting the user. In a plain browser
 *   the credentials end up in localStorage — explicitly less secure, but
 *   the dev/non-Electron path is for development only.
 * - The provider token itself is NOT persisted; it's short-lived and we
 *   can always re-derive it from the credentials at startup.
 *
 * "Always remember": every successful sign-in persists the credentials.
 * The user opts out by signing out (which removes all persisted keys).
 */

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  CertApiAuthError,
  login as certApiLogin,
  requestProviderToken,
  type LoginResponse,
  type ProviderToken
} from '../api/cert-client';
import {
  isSecure,
  secureGetJson,
  secureRemove,
  secureSetJson
} from '../api/secure-storage';

const USER_STORAGE_KEY = 'reso-cert-user-v1';
const CREDS_STORAGE_KEY = 'reso-cert-credentials-v1';
/** Refresh the provider token this many ms before it expires. */
const REFRESH_LEAD_MS = 5 * 60 * 1000; // 5 minutes

interface PersistedCredentials {
  readonly username: string;
  readonly password: string;
  /** Cert API token — used as OAuth2 client_secret for provider token requests. */
  readonly apiToken: string;
}

export interface AuthContextValue {
  readonly user: LoginResponse | null;
  readonly isAuthenticated: boolean;
  readonly isAdmin: boolean;
  readonly isSigningIn: boolean;
  readonly isHydrating: boolean;
  readonly error: string | null;
  /** True when running inside Electron with OS-encrypted storage available. */
  readonly hasSecureStorage: boolean;

  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;

  /** `Authorization: ApiKey <token>` for Cert API endpoints, or null if not signed in. */
  getCertApiHeader: () => { Authorization: string } | null;

  /** `Authorization: Bearer <token>` for services.reso.org, or null if no provider token. */
  getProviderHeader: () => { Authorization: string } | null;

  /**
   * Returns a fresh provider token, refreshing it if it's near expiry.
   * Throws if credentials are no longer available and a refresh is needed.
   */
  ensureFreshProviderToken: () => Promise<string>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextValue | null>(null);

interface CredentialsRef {
  username: string;
  password: string;
  apiToken: string;
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<LoginResponse | null>(null);
  const [providerToken, setProviderToken] = useState<ProviderToken | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isHydrating, setIsHydrating] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Credentials and refresh timer kept outside React state — they don't
  // affect rendering and we don't want them in DevTools.
  const credentialsRef = useRef<CredentialsRef | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSecureStorage = isSecure();

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback(
    (token: ProviderToken) => {
      clearRefreshTimer();
      const expiresAtMs = new Date(token.expiresAt).getTime();
      const refreshAt = expiresAtMs - REFRESH_LEAD_MS;
      const delay = Math.max(0, refreshAt - Date.now());
      refreshTimerRef.current = setTimeout(() => {
        void refreshProviderToken();
      }, delay);
    },
    // refreshProviderToken is defined below; it's stable via useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearRefreshTimer]
  );

  const refreshProviderToken = useCallback(async (): Promise<string> => {
    const creds = credentialsRef.current;
    if (!creds) {
      throw new Error(
        'Cannot refresh provider token: credentials are not available. Please sign in again.'
      );
    }
    const fresh = await requestProviderToken(creds.username, creds.apiToken);
    setProviderToken(fresh);
    scheduleRefresh(fresh);
    return fresh.accessToken;
  }, [scheduleRefresh]);

  const signIn = useCallback(
    async (username: string, password: string): Promise<void> => {
      setIsSigningIn(true);
      setError(null);
      try {
        // Step 1: Cert API login → API key + identity
        const loginResponse = await certApiLogin(username, password);

        // Step 2: OAuth2 client_credentials → provider token.
        // Use the server-normalized username (not what the user typed) as client_id.
        const normalizedUsername = loginResponse.username ?? username;
        const token = await requestProviderToken(normalizedUsername, loginResponse.token);

        credentialsRef.current = { username: normalizedUsername, password, apiToken: loginResponse.token };
        setUser(loginResponse);
        setProviderToken(token);
        await secureSetJson(USER_STORAGE_KEY, loginResponse);
        await secureSetJson<PersistedCredentials>(CREDS_STORAGE_KEY, {
          username,
          password,
          apiToken: loginResponse.token
        });
        scheduleRefresh(token);
      } catch (err) {
        const message =
          err instanceof CertApiAuthError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Sign in failed';
        setError(message);
        throw err;
      } finally {
        setIsSigningIn(false);
      }
    },
    [scheduleRefresh]
  );

  const signOut = useCallback(() => {
    clearRefreshTimer();
    credentialsRef.current = null;
    setUser(null);
    setProviderToken(null);
    setError(null);
    void secureRemove(USER_STORAGE_KEY);
    void secureRemove(CREDS_STORAGE_KEY);
  }, [clearRefreshTimer]);

  // Hydrate from secure storage on mount. If we find credentials, we also
  // immediately request a fresh provider token so the user is fully signed
  // in by the time the app renders past the hydrating state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const persistedUser = await secureGetJson<LoginResponse>(USER_STORAGE_KEY);
      const persistedCreds =
        await secureGetJson<PersistedCredentials>(CREDS_STORAGE_KEY);

      if (cancelled) return;

      if (persistedUser) {
        setUser(persistedUser);
      }

      if (persistedCreds) {
        credentialsRef.current = persistedCreds;
        try {
          const token = await requestProviderToken(
            persistedCreds.username,
            persistedCreds.apiToken ?? persistedCreds.password
          );
          if (cancelled) return;
          setProviderToken(token);
          scheduleRefresh(token);
        } catch {
          // Credentials are stale or invalid. Clear everything so the user
          // gets a clean login prompt. Stale credentials (e.g., missing
          // apiToken from a previous format) would keep 400'ing on every restart.
          if (!cancelled) {
            setUser(null);
            credentialsRef.current = null;
            void secureRemove(USER_STORAGE_KEY);
            void secureRemove(CREDS_STORAGE_KEY);
          }
        }
      }

      if (!cancelled) setIsHydrating(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [scheduleRefresh]);

  // Clean up the refresh timer on unmount
  useEffect(() => {
    return () => clearRefreshTimer();
  }, [clearRefreshTimer]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isAdmin: user?.isAdmin ?? false,
      isSigningIn,
      isHydrating,
      error,
      hasSecureStorage,
      signIn,
      signOut,
      getCertApiHeader: () =>
        user ? { Authorization: `ApiKey ${user.token}` } : null,
      getProviderHeader: () =>
        providerToken
          ? { Authorization: `Bearer ${providerToken.accessToken}` }
          : null,
      ensureFreshProviderToken: async () => {
        if (!providerToken) {
          return refreshProviderToken();
        }
        const expiresAtMs = new Date(providerToken.expiresAt).getTime();
        if (expiresAtMs - Date.now() <= REFRESH_LEAD_MS) {
          return refreshProviderToken();
        }
        return providerToken.accessToken;
      }
    }),
    [
      user,
      providerToken,
      isSigningIn,
      isHydrating,
      error,
      hasSecureStorage,
      signIn,
      signOut,
      refreshProviderToken
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
