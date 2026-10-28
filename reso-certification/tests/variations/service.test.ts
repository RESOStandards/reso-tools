/**
 * Unit tests for the Variations Service client (src/variations/service.ts):
 * the two auth paths (passed session bearer vs minted CLI token), the
 * client-aware coded auth errors, and the loud-failure cases.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VARIATIONS_HANDLER_ENV, computeVariationsViaService, isVariationsAuthError } from '../../src/variations/index.js';

const report = {
  description: 'Data Dictionary Variations Report',
  version: '2.1',
  fuzziness: 0.25,
  variations: { fields: [] }
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
      bearerToken: 'sess-123'
    });

    expect(result.variations).toEqual({ fields: [] });
    expect(mockFetch()).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch().mock.calls[0] as unknown as FetchCall;
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
        : { ok: true, status: 200, text: async () => gzipB64(report) }
    );

    const result = await computeVariationsViaService({ metadataReportJson: { fields: [], lookups: [] }, version: '2.1', fromCli: true });

    expect(result.version).toBe('2.1');
    const computeCall = (mockFetch().mock.calls as unknown as ReadonlyArray<FetchCall>).find(([u]) => u.includes('/compute'));
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
    // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
    // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
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
      bearerToken: 't'
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

describe("computeVariationsViaService — a host's handler module", () => {
  // Real modules on disk, loaded the way a host's would be. Each records what it was handed on globalThis.
  const dir = { path: '' };
  const handlerModule = (name: string, source: string): string => {
    const path = join(dir.path, name);
    writeFileSync(path, source);
    return path;
  };
  const seen = (): unknown => (globalThis as Record<string, unknown>).__variationsHandlerSeen;

  beforeAll(() => {
    dir.path = mkdtempSync(join(tmpdir(), 'variations-handler-'));
  });
  afterAll(() => {
    rmSync(dir.path, { recursive: true, force: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__variationsHandlerSeen');
  });

  it('calls the module the host names with the /compute body, and needs no services address and no token', async () => {
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    delete process.env.RESO_SERVICES_URL;
    process.env[VARIATIONS_HANDLER_ENV] = handlerModule(
      'ok.mjs',
      `export const computeVariations = async request => {
        globalThis.__variationsHandlerSeen = request;
        return { description: 'Data Dictionary Variations Report', version: request.version, fuzziness: 0.25, variations: { fields: ['from-handler'] } };
      };`
    );

    const result = await computeVariationsViaService({
      metadataReportJson: { fields: [], lookups: [] },
      version: '2.1',
      fuzziness: 0.3,
      bearerToken: 'sess-123'
    });

    expect(result.variations).toEqual({ fields: ['from-handler'] });
    expect(mockFetch()).not.toHaveBeenCalled();
    // The /compute body, exactly. A bearer passed in is not handed on.
    expect(seen()).toEqual({ metadataReportJson: { fields: [], lookups: [] }, version: '2.1', fuzziness: 0.3 });
  });

  it('refuses a module that exports no computeVariations, naming the variable', async () => {
    process.env[VARIATIONS_HANDLER_ENV] = handlerModule('empty.mjs', 'export const somethingElse = 1;');

    const error = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1' }).catch((e: unknown) => e);

    expect(codeOf(error)).toBe('SERVICE_ERROR');
    expect((error as Error).message).toContain(VARIATIONS_HANDLER_ENV);
    expect((error as Error).message).toContain('no computeVariations function');
  });

  it('refuses a module that cannot be loaded', async () => {
    process.env[VARIATIONS_HANDLER_ENV] = join(dir.path, 'missing.mjs');

    const error = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1' }).catch((e: unknown) => e);

    expect(codeOf(error)).toBe('SERVICE_ERROR');
    expect((error as Error).message).toContain('could not be loaded');
  });

  it('reports a module that fails as a service error, with its reason', async () => {
    process.env[VARIATIONS_HANDLER_ENV] = handlerModule(
      'throws.mjs',
      `export const computeVariations = async () => { throw new Error('the backend refused this job'); };`
    );

    const error = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1' }).catch((e: unknown) => e);

    expect(codeOf(error)).toBe('SERVICE_ERROR');
    expect((error as Error).message).toContain('the backend refused this job');
  });

  it('refuses an answer that is not a variations report', async () => {
    process.env[VARIATIONS_HANDLER_ENV] = handlerModule('wrong.mjs', 'export const computeVariations = async () => ({ nope: true });');

    const error = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1' }).catch((e: unknown) => e);

    expect(codeOf(error)).toBe('SERVICE_ERROR');
    expect((error as Error).message).toContain('answered without a variations report');
  });

  it('treats a blank variable as unset, so the HTTP path runs as before', async () => {
    process.env[VARIATIONS_HANDLER_ENV] = '   ';
    mockFetch().mockResolvedValue({ ok: true, status: 200, text: async () => gzipB64(report) });

    const result = await computeVariationsViaService({ metadataReportJson: {}, version: '2.1', bearerToken: 'sess-123' });

    expect(result.variations).toEqual({ fields: [] });
    expect(mockFetch()).toHaveBeenCalledTimes(1);
  });
});

describe('computeVariationsViaService — RESO Common Format', () => {
  const deprecation = {
    level: 'lookup',
    reason: 'legacy-odata-form',
    resourceName: 'Property',
    fieldName: 'StandardStatus',
    lookupValue: 'ComingSoon',
    standardLookupValue: 'Coming Soon',
    deprecatedInVersion: '3.0'
  } as const;

  /** The /compute body the client sent, decoded from the compressed request. */
  const sentBody = (): Record<string, unknown> => {
    const [, opts] = mockFetch().mock.calls[0] as unknown as readonly [string, { body: string }];
    return JSON.parse(gunzipSync(Buffer.from(opts.body, 'base64')).toString('utf8')) as Record<string, unknown>;
  };

  it('sends isRCF only when the caller says the report came from RCF', async () => {
    for (const [extra, expected] of [
      [{ isRCF: true }, true],
      [{}, undefined],
      [{ isRCF: false }, undefined]
    ] as const) {
      mockFetch().mockReset();
      mockFetch().mockResolvedValue({ ok: true, status: 200, text: async () => gzipB64(report) });
      await computeVariationsViaService({
        metadataReportJson: { fields: [], lookups: [] },
        version: '2.1',
        bearerToken: 'sess-1',
        ...extra
      });
      expect(sentBody().isRCF, JSON.stringify(extra)).toBe(expected);
    }
  });

  it('returns the deprecations the service lists, and none when it lists none', async () => {
    mockFetch().mockResolvedValue({ ok: true, status: 200, text: async () => gzipB64({ ...report, deprecations: [deprecation] }) });
    const listed = await computeVariationsViaService({
      metadataReportJson: { fields: [], lookups: [] },
      version: '2.1',
      bearerToken: 'sess-1',
      isRCF: true
    });
    expect(listed.deprecations).toEqual([deprecation]);

    mockFetch().mockResolvedValue({ ok: true, status: 200, text: async () => gzipB64(report) });
    const none = await computeVariationsViaService({
      metadataReportJson: { fields: [], lookups: [] },
      version: '2.1',
      bearerToken: 'sess-1'
    });
    expect(none.deprecations).toBeUndefined();
  });

  it("hands isRCF to a host's handler module with the rest of the /compute body", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'variations-handler-rcf-'));
    try {
      const path = join(dir, 'rcf.mjs');
      writeFileSync(
        path,
        `export const computeVariations = async request => {
          globalThis.__variationsHandlerSeenRcf = request;
          return { description: 'Data Dictionary Variations Report', version: request.version, fuzziness: 0.25, variations: {} };
        };`
      );
      process.env[VARIATIONS_HANDLER_ENV] = path;
      await computeVariationsViaService({ metadataReportJson: { fields: [], lookups: [] }, version: '2.1', isRCF: true });
      expect((globalThis as Record<string, unknown>).__variationsHandlerSeenRcf).toEqual({
        metadataReportJson: { fields: [], lookups: [] },
        version: '2.1',
        isRCF: true
      });
    } finally {
      Reflect.deleteProperty(globalThis, '__variationsHandlerSeenRcf');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
