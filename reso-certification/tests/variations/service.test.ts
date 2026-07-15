/**
 * Unit tests for the Variations Service client (src/variations/service.ts):
 * the two auth paths (passed session bearer vs minted CLI token), the
 * client-aware coded auth errors, and the loud-failure cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { computeVariationsViaService, isVariationsAuthError } from '../../src/variations/index.js';

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

const codeOf = (error: unknown): string | undefined => (error as Error & { code?: string }).code;

beforeEach(() => {
  process.env = { ...origEnv, RESO_SERVICES_URL: 'https://services.example.org' };
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  process.env = { ...origEnv };
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('computeVariationsViaService — auth paths', () => {
  it('POSTs to /compute with a passed session bearer (no mint) and returns the report', async () => {
    mockFetch().mockResolvedValue({ ok: true, status: 200, text: async () => gzipB64(report) });

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

  it('CLI path: mints a provider token from env creds when no bearer is passed', async () => {
    process.env.CERT_AUTH_API_BASE_URL = 'https://auth.example.org';
    process.env.CERT_AUTH_API_USERNAME = 'user';
    process.env.CERTIFICATION_API_KEY = 'key';
    process.env.CURRENT_PROVIDER_UOI = 'UOI1';
    mockFetch().mockImplementation(async (url: string) =>
      url.includes('auth.example.org')
        ? { ok: true, status: 200, json: async () => ({ token: 'minted-tok' }) }
        : { ok: true, status: 200, text: async () => gzipB64(report) },
    );

    const result = await computeVariationsViaService({ metadataReportJson: { fields: [], lookups: [] }, version: '2.1', fromCli: true });

    expect(result.version).toBe('2.1');
    const computeCall = (mockFetch().mock.calls as ReadonlyArray<FetchCall>).find(([u]) => u.includes('/compute'));
    expect(computeCall?.[1].headers.Authorization).toBe('Bearer minted-tok');
  });
});

describe('computeVariationsViaService — coded auth errors', () => {
  it('CLI with no token: AUTH_REQUIRED pointing at .env credentials', async () => {
    const err = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1', fromCli: true }).catch(e => e);
    expect(codeOf(err)).toBe('AUTH_REQUIRED');
    expect((err as Error).message).toMatch(/\.env/);
  });

  it('SDK (not CLI) with no token: AUTH_REQUIRED pointing at passing a provider token', async () => {
    const err = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1' }).catch(e => e);
    expect(codeOf(err)).toBe('AUTH_REQUIRED');
    expect((err as Error).message).toMatch(/provider token/);
  });

  it('a 401/403 from /compute: AUTH_REJECTED (UI catches this to prompt re-login)', async () => {
    mockFetch().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const err = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1', bearerToken: 'stale' }).catch(e => e);
    expect(codeOf(err)).toBe('AUTH_REJECTED');
  });

  it('isVariationsAuthError is true for the auth codes, false otherwise', async () => {
    const authErr = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1', fromCli: true }).catch(e => e);
    expect(isVariationsAuthError(authErr)).toBe(true);
    expect(isVariationsAuthError(new Error('plain'))).toBe(false);
    expect(isVariationsAuthError('nope')).toBe(false);
  });
});

describe('computeVariationsViaService — service failures', () => {
  it('throws SERVICE_ERROR when RESO_SERVICES_URL is unset', async () => {
    delete process.env.RESO_SERVICES_URL;
    const err = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1', bearerToken: 't' }).catch(e => e);
    expect(codeOf(err)).toBe('SERVICE_ERROR');
    expect((err as Error).message).toMatch(/RESO_SERVICES_URL/);
  });

  it('throws SERVICE_ERROR on a non-OK response from /compute', async () => {
    mockFetch().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    const err = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1', bearerToken: 't' }).catch(e => e);
    expect(codeOf(err)).toBe('SERVICE_ERROR');
    expect((err as Error).message).toMatch(/503/);
  });

  it('guards the compressed-payload ceiling: SERVICE_ERROR at dev@reso.org, before any POST', async () => {
    // ~6 MB of random data → incompressible → base64(gzip) clears the 6 MB Lambda ceiling.
    const oversized = randomBytes(6 * 1024 * 1024).toString('base64');
    const err = await computeVariationsViaService({
      metadataReportJson: { fields: [], _pad: oversized },
      version: '2.1',
      bearerToken: 't',
    }).catch(e => e);
    expect(codeOf(err)).toBe('SERVICE_ERROR');
    expect((err as Error).message).toMatch(/too large/i);
    expect((err as Error).message).toMatch(/dev@reso\.org/);
    expect(mockFetch()).not.toHaveBeenCalled();
  });

  it('a 413 from /compute: SERVICE_ERROR with the same graceful too-large message', async () => {
    mockFetch().mockResolvedValue({ ok: false, status: 413, statusText: 'Payload Too Large' });
    const err = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1', bearerToken: 't' }).catch(e => e);
    expect(codeOf(err)).toBe('SERVICE_ERROR');
    expect((err as Error).message).toMatch(/too large/i);
    expect((err as Error).message).toMatch(/dev@reso\.org/);
  });
});
