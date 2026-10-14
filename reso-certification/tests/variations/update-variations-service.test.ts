import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isVariationsAuthError, updateVariationsViaService } from '../../src/variations/service.js';

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const items = [{ resourceName: 'Property', fieldName: 'Foo', suggestedFieldName: 'Bar' }];

describe('updateVariationsViaService', () => {
  beforeEach(() => {
    process.env.RESO_SERVICES_URL = 'https://services.example.org';
    // Keep the .env mint path deterministic (no CERT_AUTH_* → mint returns undefined).
    // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
    // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    delete process.env.CERT_AUTH_API_BASE_URL;
    // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
    // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    delete process.env.CERT_AUTH_API_USERNAME;
    // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
    // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    delete process.env.CERTIFICATION_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
    // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    delete process.env.RESO_SERVICES_URL;
  });

  it('POSTs to the v2 endpoint with auth, admin, and flag headers, and aggregates stats', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ updatedFields: 1, ignoredFields: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateVariationsViaService({
      items,
      bearerToken: 'tok',
      adminSecret: 'sekret',
      adminReview: true,
      overwrite: true
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://services.example.org/v2/certification/variations');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['x-ft-admin-secret']).toBe('sekret');
    expect(opts.headers.isAdminReview).toBe('true');
    expect(opts.headers.Overwrite).toBe('true');
    expect(opts.headers.isFastTrack).toBeUndefined();
    expect(JSON.parse(opts.body)).toEqual(items);
    expect(result).toEqual({
      submitted: 1,
      chunks: 1,
      stats: { updatedFields: 1, ignoredFields: 0 },
      permissionDenied: 0,
      permissionDeniedReasons: {},
      overwriteRequired: 0,
      validationFailed: 0,
      corrections: 0
    });
  });

  it('surfaces permission-denied, validation-failed, and correction counts from the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          updatedFields: 0,
          permissionDenied: [{ items: [1, 2, 3] }],
          validationFailed: [{ reason: 'x' }, { reason: 'y' }],
          corrections: [{ a: 1 }]
        })
      )
    );
    const result = await updateVariationsViaService({ items, bearerToken: 'tok' });
    expect(result.permissionDenied).toBe(3);
    expect(result.validationFailed).toBe(2);
    expect(result.corrections).toBe(1);
  });

  it('names how many chunks already committed when a later chunk fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({}))
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error', text: async () => '', json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const many = Array.from({ length: 3 }, (_, i) => ({ resourceName: `R${i}` }));
    await expect(updateVariationsViaService({ items: many, bearerToken: 'tok', chunkSize: 2 })).rejects.toThrow(
      /chunk 2\/2 failed.*1 of 2 chunk\(s\) already committed/
    );
  });

  it('chunks large submissions and sums stats across chunks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ updatedFields: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const many = Array.from({ length: 5 }, (_, i) => ({ resourceName: `R${i}` }));

    const result = await updateVariationsViaService({ items: many, bearerToken: 'tok', chunkSize: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.chunks).toBe(3);
    expect(result.submitted).toBe(5);
    expect(result.stats.updatedFields).toBe(3);
  });

  it('sends isFastTrack for fast-track submissions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    await updateVariationsViaService({ items, bearerToken: 'tok', fastTrack: true, adminSecret: 'sekret' });
    expect(fetchMock.mock.calls[0][1].headers.isFastTrack).toBe('true');
    expect(fetchMock.mock.calls[0][1].headers.isAdminReview).toBeUndefined();
  });

  it('refuses a fast-track submission with no Fast Track credential, before any request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    await expect(updateVariationsViaService({ items, bearerToken: 'tok', fastTrack: true })).rejects.toThrow(
      /fast-track submission requires/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves an admin-review submission alone when no Fast Track credential is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    await updateVariationsViaService({ items, bearerToken: 'tok', adminReview: true });
    expect(fetchMock.mock.calls[0][1].headers.isAdminReview).toBe('true');
  });

  it('counts overwrite-required items separately from permission denials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        ignoredLookups: 0,
        overwriteRequired: [{ reason: 'Modification of a flagged mapping requires overwrite=true.', items: [{}, {}, {}] }]
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await updateVariationsViaService({ items, bearerToken: 'tok' });
    expect(result.overwriteRequired).toBe(3);
    expect(result.permissionDenied).toBe(0);
    expect(result.permissionDeniedReasons).toEqual({});
  });

  it('reports each permission-denial reason with its item count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        ignoredLookups: 0,
        permissionDenied: [
          { reason: 'Modification of a flagged mapping requires overwrite=true.', items: [{}, {}, {}] },
          { reason: 'Fast Track mappings can only be modified by a Fast Track admin.', items: [{}] }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await updateVariationsViaService({ items, bearerToken: 'tok' });
    expect(result.permissionDenied).toBe(4);
    expect(result.permissionDeniedReasons).toEqual({
      'Modification of a flagged mapping requires overwrite=true.': 3,
      'Fast Track mappings can only be modified by a Fast Track admin.': 1
    });
  });

  it('rejects a submission flagged both admin-review and fast-track', async () => {
    await expect(updateVariationsViaService({ items, bearerToken: 'tok', adminReview: true, fastTrack: true })).rejects.toThrow(
      /mutually exclusive/
    );
  });

  it('rejects an empty submission', async () => {
    await expect(updateVariationsViaService({ items: [], bearerToken: 'tok' })).rejects.toThrow(/No variation suggestions/);
  });

  it('throws when RESO_SERVICES_URL is unset', async () => {
    // `process.env.X = undefined` coerces to the STRING "undefined" and leaves the key present,
    // so every "throws when unset" assertion silently stops throwing. Only `delete` unsets.
    // biome-ignore lint/performance/noDelete: unsetting an env var requires `delete`.
    delete process.env.RESO_SERVICES_URL;
    await expect(updateVariationsViaService({ items, bearerToken: 'tok' })).rejects.toThrow(/RESO_SERVICES_URL is not set/);
  });

  it('throws AUTH_REQUIRED with no bearer and no .env credentials', async () => {
    const err = await updateVariationsViaService({ items, fromCli: true }).catch(e => e);
    expect(isVariationsAuthError(err)).toBe(true);
  });

  it('surfaces AUTH_REJECTED on a 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '', json: async () => ({}) })
    );
    const err = await updateVariationsViaService({ items, bearerToken: 'tok' }).catch(e => e);
    expect(isVariationsAuthError(err)).toBe(true);
  });

  it('throws SERVICE_ERROR with chunk info on a non-ok, non-auth response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom', json: async () => ({}) })
    );
    await expect(updateVariationsViaService({ items, bearerToken: 'tok' })).rejects.toThrow(/chunk 1\/1 failed: 500/);
  });
});
