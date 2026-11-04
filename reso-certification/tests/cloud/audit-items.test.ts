import { afterEach, describe, expect, it, vi } from 'vitest';
import { __clearSecretsForTest, registerSecret } from '../../src/cli/secrets.js';
import { mintProviderToken } from '../../src/sdk/common.js';

/** The two informational items of the 0.12.0 audit that live in this code. Credentials here are placeholders. */

const PROVIDER_TOKEN_ENV = ['CERT_AUTH_API_BASE_URL', 'CERT_AUTH_API_USERNAME', 'CERTIFICATION_API_KEY', 'CURRENT_PROVIDER_UOI'] as const;

describe('mintProviderToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of PROVIDER_TOKEN_ENV) vi.stubEnv(name, '');
    vi.unstubAllEnvs();
  });

  it('sends the API key only over https, upgrading a bare or http address as every service address is', async () => {
    vi.stubEnv('CERT_AUTH_API_BASE_URL', 'http://cert-auth.example.test/api');
    vi.stubEnv('CERT_AUTH_API_USERNAME', 'someone');
    vi.stubEnv('CERTIFICATION_API_KEY', '<sentinel_api_key>');
    vi.stubEnv('CURRENT_PROVIDER_UOI', 'T00000000');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 'minted' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(mintProviderToken()).resolves.toBe('minted');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cert-auth.example.test/api/T00000000?username=someone');
  });
});

describe('a stopped entry', () => {
  afterEach(() => {
    __clearSecretsForTest();
    vi.restoreAllMocks();
    vi.doUnmock('../../src/sdk/index.js');
  });

  it('is reported with the secret in its error masked', async () => {
    registerSecret('sentinel-secret-9c1d');
    vi.doMock('../../src/sdk/index.js', () => ({
      runComplianceTests: vi.fn(async () => {
        throw new Error('token sentinel-secret-9c1d was rejected');
      })
    }));
    const { runConfigEntries } = await import('../../src/cli/render.js');
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const outcomes = await runConfigEntries(
      [
        {
          label: 'Feed one',
          config: { endorsement: 'core', server: { url: 'https://api.example.com/odata', auth: { mode: 'token', authToken: 'x' } } }
        }
      ],
      'silent'
    );
    expect(outcomes).toEqual([{ label: 'Feed one', error: 'token sentinel-secret-9c1d was rejected' }]);
    const stopped = lines.find(line => line.includes('Feed one'));
    expect(stopped).toBeDefined();
    expect(stopped).not.toContain('sentinel-secret-9c1d');
  });
});
