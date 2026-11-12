import { afterEach, describe, expect, it, vi } from 'vitest';

import { MISSING_CERT_API_CREDENTIAL, registerCertApiSecrets, resolveCertApiAuthorization } from '../../src/cli/cert-api-credential.js';
import { __clearSecretsForTest, maskSecrets } from '../../src/cli/secrets.js';

const ORIGIN = 'https://cert-api.example.org';
const TOKEN_URI = `${ORIGIN}/api/v1/oauth/token`;
const SECRET = 'SENTINEL-client-secret-for-tests';
const MINTED = 'minted-access-token';

const clientCredentials = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  TOKEN_URI,
  CLIENT_ID: 'client-for-tests',
  CLIENT_SECRET: SECRET,
  ...overrides
});

afterEach(() => {
  vi.unstubAllGlobals();
  __clearSecretsForTest();
});

describe('resolveCertApiAuthorization', () => {
  it('uses a bearer token given directly, and mints nothing', async () => {
    const exchange = vi.fn();
    const header = await resolveCertApiAuthorization({
      env: clientCredentials({ CERT_API_TOKEN: 'given-token' }),
      origin: ORIGIN,
      exchange
    });
    expect(header).toBe('Bearer given-token');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('mints a token from the credentials file and presents the token, never the secret', async () => {
    const exchange = vi.fn(async () => MINTED);
    const header = await resolveCertApiAuthorization({ env: clientCredentials(), origin: ORIGIN, exchange });
    expect(header).toBe(`Bearer ${MINTED}`);
    expect(header).not.toContain(SECRET);
    expect(exchange).toHaveBeenCalledWith({ tokenUri: TOKEN_URI, clientId: 'client-for-tests', clientSecret: SECRET });
  });

  it('sends CLIENT_SECRET to the token endpoint and nowhere else (the real exchange, every request recorded)', async () => {
    const requests: { readonly url: string; readonly body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, body: String(init.body ?? '') });
        return { ok: true, status: 200, statusText: '', json: async () => ({ access_token: MINTED }) };
      })
    );
    const header = await resolveCertApiAuthorization({ env: clientCredentials(), origin: ORIGIN });
    expect(header).toBe(`Bearer ${MINTED}`);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(TOKEN_URI);
    expect(requests[0]?.body).toContain('grant_type=client_credentials');
    expect(requests.filter(r => r.body.includes(SECRET) || r.url.includes(SECRET)).map(r => r.url)).toEqual([TOKEN_URI]);
  });

  it('refuses a TOKEN_URI on another origin than the API, before any request', async () => {
    const exchange = vi.fn();
    const elsewhere = clientCredentials({ TOKEN_URI: 'https://elsewhere.example.org/api/v1/oauth/token' });
    const error: unknown = await resolveCertApiAuthorization({ env: elsewhere, origin: ORIGIN, exchange }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not the token endpoint of https:\/\/cert-api\.example\.org/);
    expect((error as Error).message).not.toContain(SECRET);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('never presents CLIENT_SECRET on its own, without TOKEN_URI and CLIENT_ID to exchange it with', async () => {
    const exchange = vi.fn();
    await expect(resolveCertApiAuthorization({ env: { CLIENT_SECRET: SECRET }, origin: ORIGIN, exchange })).rejects.toThrow(
      /only ever exchanged/
    );
    await expect(resolveCertApiAuthorization({ env: { CLIENT_SECRET: SECRET, TOKEN_URI }, origin: ORIGIN, exchange })).rejects.toThrow(
      /CLIENT_ID/
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it('stops when the token endpoint refuses, rather than falling back to anything', async () => {
    const exchange = vi.fn(async () => undefined);
    await expect(
      resolveCertApiAuthorization({ env: clientCredentials({ CERTIFICATION_API_KEY: 'older' }), origin: ORIGIN, exchange })
    ).rejects.toThrow(/did not issue a token/);
  });

  it('still accepts the older environment key', async () => {
    expect(await resolveCertApiAuthorization({ env: { CERTIFICATION_API_KEY: 'older' }, origin: ORIGIN })).toBe('Bearer older');
  });

  it('reads an empty or blank value as absent, so none reaches a request as a bare Bearer', async () => {
    expect(await resolveCertApiAuthorization({ env: { CERT_API_TOKEN: '  ', CERTIFICATION_API_KEY: 'older' }, origin: ORIGIN })).toBe(
      'Bearer older'
    );
    await expect(resolveCertApiAuthorization({ env: { CLIENT_SECRET: '', CERTIFICATION_API_KEY: '' }, origin: ORIGIN })).rejects.toThrow(
      MISSING_CERT_API_CREDENTIAL
    );
  });
});

describe('registerCertApiSecrets', () => {
  it('masks every secret the environment carries before anything is resolved', () => {
    registerCertApiSecrets({ CLIENT_SECRET: SECRET, CERT_API_TOKEN: 'given-token', CERTIFICATION_API_KEY: 'older-key' });
    expect(maskSecrets(`a ${SECRET} b given-token c older-key`)).not.toMatch(/SENTINEL|given-token|older-key/);
  });
});
