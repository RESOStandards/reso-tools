/**
 * Unit tests for the Variations Service client (src/sdk/variations-service.ts):
 * the two auth paths (passed session bearer vs minted CLI token) and the
 * loud-failure cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { computeVariationsViaService } from '../../src/sdk/variations-service.js';

const report = {
  description: 'Data Dictionary Variations Report',
  version: '2.1',
  fuzziness: 0.25,
  variations: { fields: [] },
};

const gzipB64 = (o: unknown): string => gzipSync(JSON.stringify(o)).toString('base64');

const origEnv = { ...process.env };

const mockFetch = (): ReturnType<typeof vi.fn> => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

type FetchCall = readonly [string, { headers: Record<string, string> }];

beforeEach(() => {
  process.env = { ...origEnv, RESO_SERVICES_URL: 'https://services.example.org' };
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  process.env = { ...origEnv };
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('computeVariationsViaService', () => {
  it('POSTs to /compute with a passed session bearer (no mint) and returns the report', async () => {
    mockFetch().mockResolvedValue({ ok: true, text: async () => gzipB64(report) });

    const result = await computeVariationsViaService({
      metadataReportJson: { fields: [], lookups: [] },
      version: '2.1',
      bearerToken: 'sess-123',
    });

    expect(result.variations).toEqual({ fields: [] });
    expect(mockFetch()).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch().mock.calls[0] as FetchCall;
    expect(url).toContain('/v2/certification/variations/compute');
    expect(opts.headers.Authorization).toBe('Bearer sess-123');
  });

  it('mints a provider token from env creds when no bearer is passed (CLI path)', async () => {
    process.env.CERT_AUTH_API_BASE_URL = 'https://auth.example.org';
    process.env.CERT_AUTH_API_USERNAME = 'user';
    process.env.CERTIFICATION_API_KEY = 'key';
    process.env.CURRENT_PROVIDER_UOI = 'UOI1';
    mockFetch().mockImplementation(async (url: string) =>
      url.includes('auth.example.org')
        ? { ok: true, json: async () => ({ token: 'minted-tok' }) }
        : { ok: true, text: async () => gzipB64(report) },
    );

    const result = await computeVariationsViaService({ metadataReportJson: { fields: [], lookups: [] }, version: '2.1' });

    expect(result.version).toBe('2.1');
    const computeCall = (mockFetch().mock.calls as ReadonlyArray<FetchCall>).find(([u]) => u.includes('/compute'));
    expect(computeCall?.[1].headers.Authorization).toBe('Bearer minted-tok');
  });

  it('throws when there is no bearer and no env credentials (no silent degrade)', async () => {
    await expect(computeVariationsViaService({ metadataReportJson: {}, version: '2.1' })).rejects.toThrow(/no provider token/);
  });

  it('throws when RESO_SERVICES_URL is unset', async () => {
    delete process.env.RESO_SERVICES_URL;
    await expect(
      computeVariationsViaService({ metadataReportJson: {}, version: '2.1', bearerToken: 't' }),
    ).rejects.toThrow(/RESO_SERVICES_URL/);
  });

  it('throws on a non-OK response from /compute', async () => {
    mockFetch().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    await expect(
      computeVariationsViaService({ metadataReportJson: {}, version: '2.1', bearerToken: 't' }),
    ).rejects.toThrow(/503/);
  });
});
