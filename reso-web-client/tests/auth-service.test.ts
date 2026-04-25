/**
 * Auth service — unit tests covering lazy refresh, single-flight,
 * multi-tenant isolation, storage round-trip, and authedFetch retry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock requestProviderToken at the module boundary. We control what
// the "remote" returns per test by stubbing this between assertions.
vi.mock('../src/api/cert-client', () => ({
  requestProviderToken: vi.fn(),
}));

import { requestProviderToken } from '../src/api/cert-client';
import {
  setCredentials,
  clearProvider,
  getBearerToken,
  getAuthHeader,
  authedFetch,
  getSnapshot,
  subscribe,
  AuthError,
  __resetForTesting,
  __setStorageForTesting,
  type AuthStorage,
} from '../src/services/auth-service';

const mockRequest = requestProviderToken as ReturnType<typeof vi.fn>;

const futureIso = (secondsFromNow: number): string =>
  new Date(Date.now() + secondsFromNow * 1000).toISOString();

const makeMockStorage = (): { store: Map<string, string>; adapter: AuthStorage } => {
  const store = new Map<string, string>();
  return {
    store,
    adapter: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
    },
  };
};

describe('auth-service', () => {
  let storage: { store: Map<string, string>; adapter: AuthStorage };

  beforeEach(() => {
    __resetForTesting();
    storage = makeMockStorage();
    __setStorageForTesting(storage.adapter);
    mockRequest.mockReset();
  });

  describe('setCredentials + storage', () => {
    it('persists credentials under the per-key storage path', async () => {
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      expect(storage.store.get('auth:provider:default:credentials')).toBe(
        JSON.stringify({ username: 'alice', apiToken: 'tok-a' }),
      );
    });

    it('isolates credentials between providers', async () => {
      await setCredentials({ username: 'alice', apiToken: 'tok-a' }, 'org-a');
      await setCredentials({ username: 'bob', apiToken: 'tok-b' }, 'org-b');

      expect(storage.store.get('auth:provider:org-a:credentials')).toContain('alice');
      expect(storage.store.get('auth:provider:org-b:credentials')).toContain('bob');
    });

    it('invalidates any cached token when credentials change', async () => {
      mockRequest.mockResolvedValueOnce({
        accessToken: 'first', tokenType: 'Bearer', expiresAt: futureIso(3600),
      });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });
      await getBearerToken();
      expect(storage.store.get('auth:provider:default:token')).toContain('first');

      // New credentials wipe the token.
      await setCredentials({ username: 'alice', apiToken: 'tok-rotated' });
      expect(storage.store.get('auth:provider:default:token')).toBeUndefined();
    });
  });

  describe('getBearerToken', () => {
    it('throws AuthError(no-credentials) when never set up', async () => {
      await expect(getBearerToken()).rejects.toBeInstanceOf(AuthError);
      await expect(getBearerToken()).rejects.toMatchObject({ code: 'no-credentials' });
    });

    it('fetches a fresh token on first call', async () => {
      mockRequest.mockResolvedValueOnce({
        accessToken: 'fresh', tokenType: 'Bearer', expiresAt: futureIso(3600),
      });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      const token = await getBearerToken();

      expect(token).toBe('fresh');
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('alice', 'tok-a');
    });

    it('returns the cached token without re-fetching when still valid', async () => {
      mockRequest.mockResolvedValueOnce({
        accessToken: 'cached', tokenType: 'Bearer', expiresAt: futureIso(3600),
      });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      await getBearerToken();
      await getBearerToken();
      await getBearerToken();

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('refreshes when the cached token is past its drift-adjusted expiry', async () => {
      // Within drift window — treated as expired even though not yet absolute-expired.
      mockRequest
        .mockResolvedValueOnce({ accessToken: 't1', tokenType: 'Bearer', expiresAt: futureIso(10) })
        .mockResolvedValueOnce({ accessToken: 't2', tokenType: 'Bearer', expiresAt: futureIso(3600) });

      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      const first = await getBearerToken();
      const second = await getBearerToken();

      expect(first).toBe('t1');
      expect(second).toBe('t2');
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('single-flights concurrent refreshes for the same key', async () => {
      let resolveRequest: (v: unknown) => void;
      mockRequest.mockReturnValueOnce(new Promise((res) => { resolveRequest = res; }));

      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      // Start three concurrent calls. They each pass through hydrateProvider
      // (which awaits even on the no-op fast path) before reaching refresh(),
      // so the underlying `requestProviderToken` call lands on a microtask
      // tick after all three have started.
      const a = getBearerToken();
      const b = getBearerToken();
      const c = getBearerToken();

      resolveRequest!({ accessToken: 'shared', tokenType: 'Bearer', expiresAt: futureIso(3600) });

      const [ra, rb, rc] = await Promise.all([a, b, c]);

      // The single-flight invariant: 3 concurrent callers produced exactly
      // one underlying fetch, and they all observed the same access token.
      expect([ra, rb, rc]).toEqual(['shared', 'shared', 'shared']);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('does NOT single-flight across different provider keys', async () => {
      mockRequest
        .mockResolvedValueOnce({ accessToken: 'a', tokenType: 'Bearer', expiresAt: futureIso(3600) })
        .mockResolvedValueOnce({ accessToken: 'b', tokenType: 'Bearer', expiresAt: futureIso(3600) });

      await setCredentials({ username: 'alice', apiToken: 'tok-a' }, 'org-a');
      await setCredentials({ username: 'bob', apiToken: 'tok-b' }, 'org-b');

      const [ra, rb] = await Promise.all([getBearerToken('org-a'), getBearerToken('org-b')]);

      expect(ra).toBe('a');
      expect(rb).toBe('b');
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('falls back to a sensible TTL when the server omits expires_in', async () => {
      // Server returned an unparseable expiresAt (simulating a missing/bad expires_in
      // upstream); the service should still cache, not refresh on every call.
      mockRequest.mockResolvedValueOnce({
        accessToken: 'tok', tokenType: 'Bearer', expiresAt: 'not-a-date',
      });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      await getBearerToken();
      await getBearerToken();

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAuthHeader', () => {
    it('returns a Bearer Authorization header', async () => {
      mockRequest.mockResolvedValueOnce({
        accessToken: 'abc', tokenType: 'Bearer', expiresAt: futureIso(3600),
      });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      const header = await getAuthHeader();

      expect(header).toEqual({ Authorization: 'Bearer abc' });
    });
  });

  describe('authedFetch', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    it('attaches the Authorization header on each call', async () => {
      mockRequest.mockResolvedValueOnce({
        accessToken: 'x', tokenType: 'Bearer', expiresAt: futureIso(3600),
      });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await authedFetch('https://example.test/data');

      const [, init] = mockFetch.mock.calls[0];
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer x');
    });

    it('retries once on 401 with a fresh token', async () => {
      mockRequest
        .mockResolvedValueOnce({ accessToken: 'stale', tokenType: 'Bearer', expiresAt: futureIso(3600) })
        .mockResolvedValueOnce({ accessToken: 'fresh', tokenType: 'Bearer', expiresAt: futureIso(3600) });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch
        .mockResolvedValueOnce(new Response('nope', { status: 401 }))
        .mockResolvedValueOnce(new Response('yes', { status: 200 }));

      const res = await authedFetch('https://example.test/data');

      expect(res.status).toBe(200);
      expect(mockRequest).toHaveBeenCalledTimes(2); // initial + post-401 refresh
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, secondInit] = mockFetch.mock.calls[1];
      expect(new Headers(secondInit.headers).get('Authorization')).toBe('Bearer fresh');
    });

    it('throws AuthError(unauthorized) if 401 persists after refresh', async () => {
      mockRequest
        .mockResolvedValueOnce({ accessToken: 'a', tokenType: 'Bearer', expiresAt: futureIso(3600) })
        .mockResolvedValueOnce({ accessToken: 'b', tokenType: 'Bearer', expiresAt: futureIso(3600) });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch
        .mockResolvedValueOnce(new Response('nope', { status: 401 }))
        .mockResolvedValueOnce(new Response('still nope', { status: 401 }));

      await expect(authedFetch('https://example.test/data')).rejects.toMatchObject({
        code: 'unauthorized',
      });
    });

    it('does not retry on 4xx responses other than 401', async () => {
      mockRequest.mockResolvedValueOnce({
        accessToken: 'x', tokenType: 'Bearer', expiresAt: futureIso(3600),
      });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });

      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

      const res = await authedFetch('https://example.test/data');

      expect(res.status).toBe(403);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearProvider', () => {
    it('removes credentials, token, and persisted entries', async () => {
      mockRequest.mockResolvedValueOnce({
        accessToken: 't', tokenType: 'Bearer', expiresAt: futureIso(3600),
      });
      await setCredentials({ username: 'alice', apiToken: 'tok-a' });
      await getBearerToken();

      expect(storage.store.size).toBeGreaterThan(0);

      await clearProvider();

      expect(storage.store.size).toBe(0);
      expect(getSnapshot().hasCredentials()).toBe(false);
      expect(getSnapshot().hasValidToken()).toBe(false);
    });
  });

  describe('hydration', () => {
    it('loads credentials from storage on first access', async () => {
      // Pre-populate storage as if a previous session had signed in.
      storage.store.set(
        'auth:provider:default:credentials',
        JSON.stringify({ username: 'persisted', apiToken: 'tok-p' }),
      );

      mockRequest.mockResolvedValueOnce({
        accessToken: 'tok', tokenType: 'Bearer', expiresAt: futureIso(3600),
      });

      // No setCredentials call — we expect hydration to find them.
      await getBearerToken();

      expect(mockRequest).toHaveBeenCalledWith('persisted', 'tok-p');
    });

    it('skips refresh when a valid cached token is in storage', async () => {
      storage.store.set(
        'auth:provider:default:credentials',
        JSON.stringify({ username: 'alice', apiToken: 'tok-a' }),
      );
      storage.store.set(
        'auth:provider:default:token',
        JSON.stringify({ accessToken: 'persisted-token', tokenType: 'Bearer', expiresAt: futureIso(3600) }),
      );

      const result = await getBearerToken();

      expect(result).toBe('persisted-token');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('recovers from corrupt storage by treating provider as unauthenticated', async () => {
      storage.store.set('auth:provider:default:credentials', 'not-json{');
      storage.store.set('auth:provider:default:token', 'also-bad');

      await expect(getBearerToken()).rejects.toMatchObject({ code: 'no-credentials' });
    });
  });

  describe('subscribe', () => {
    it('notifies on credentials change and clear', async () => {
      const fn = vi.fn();
      const unsubscribe = subscribe(fn);

      await setCredentials({ username: 'alice', apiToken: 'tok-a' });
      await clearProvider();

      expect(fn).toHaveBeenCalledTimes(2);

      unsubscribe();
      await setCredentials({ username: 'bob', apiToken: 'tok-b' });

      expect(fn).toHaveBeenCalledTimes(2); // unsubscribed; no further calls
    });
  });
});
