import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerTokenProvider, cliCredentialsTokenProvider, sessionTokenProvider } from '../../src/cloud/update-tokens.js';

/**
 * The token providers for live updates, one per kind of caller: a signed-in session, the CLI's credentials and a
 * bearer the caller holds. Each is asked again on every connect, so what it returns then is what is used.
 *
 * Credentials here are synthetic.
 */

const OAUTH = ['TOKEN_URI', 'CLIENT_ID', 'CLIENT_SECRET'] as const;
const PROVIDER = ['CERT_AUTH_API_BASE_URL', 'CERT_AUTH_API_USERNAME', 'CERTIFICATION_API_KEY', 'CURRENT_PROVIDER_UOI'] as const;

const saved = Object.fromEntries([...OAUTH, ...PROVIDER].map(name => [name, process.env[name]]));

const unset = (name: string): void => {
  // `process.env.X = undefined` stores the string "undefined". Only `delete` unsets.
  delete process.env[name];
};

const reply = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });

beforeEach(() => {
  for (const name of [...OAUTH, ...PROVIDER]) unset(name);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) unset(name);
    else process.env[name] = value;
  }
});

describe('sessionTokenProvider', () => {
  it("asks the session for its current token on every connect, so the session's own refresh is used", async () => {
    const tokens = ['session-token-one', 'session-token-two'];
    const getAccessToken = vi.fn(async () => tokens.shift());
    const provider = sessionTokenProvider(getAccessToken);

    await expect(provider()).resolves.toBe('session-token-one');
    await expect(provider()).resolves.toBe('session-token-two');
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });
});

describe('bearerTokenProvider', () => {
  it('hands back the bearer the caller passed in, every time', async () => {
    const provider = bearerTokenProvider('desktop-bearer-for-tests');
    await expect(provider()).resolves.toBe('desktop-bearer-for-tests');
    await expect(provider()).resolves.toBe('desktop-bearer-for-tests');
  });

  it('has no token for a blank bearer, rather than sending one', async () => {
    await expect(bearerTokenProvider('  ')()).resolves.toBeUndefined();
  });
});

describe('cliCredentialsTokenProvider', () => {
  it('mints a fresh client-credentials token on every connect, as the cloud commands do', async () => {
    process.env.TOKEN_URI = 'https://cert.example.org/api/v1/oauth/token';
    process.env.CLIENT_ID = 'client-id-for-tests';
    process.env.CLIENT_SECRET = 'reso-example-client-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ access_token: 'mock-token' }))
      .mockResolvedValueOnce(reply({ access_token: 'test-token' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = cliCredentialsTokenProvider();

    await expect(provider()).resolves.toBe('mock-token');
    await expect(provider()).resolves.toBe('test-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cert.example.org/api/v1/oauth/token');
    expect(String(init.body)).toContain('grant_type=client_credentials');
  });

  it('falls back to the CERT_AUTH_API_* provider-token mint when the OAuth2 variables are absent', async () => {
    process.env.CERT_AUTH_API_BASE_URL = 'https://auth.example.org/provider-tokens';
    process.env.CERT_AUTH_API_USERNAME = 'user-for-tests';
    process.env.CERTIFICATION_API_KEY = 'api-key-for-tests';
    process.env.CURRENT_PROVIDER_UOI = 'T00000000';
    const fetchMock = vi.fn().mockResolvedValue(reply({ token: 'reso-example-provider-token' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cliCredentialsTokenProvider()()).resolves.toBe('reso-example-provider-token');
    expect(fetchMock.mock.calls[0][0]).toBe('https://auth.example.org/provider-tokens/T00000000?username=user-for-tests');
  });

  it('has no token, and calls nothing, when neither set of credentials is there', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(cliCredentialsTokenProvider()()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
