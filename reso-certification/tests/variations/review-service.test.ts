import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listVariationReviewItemsViaService,
  listMyEndorsementsViaService,
  listEndorsementsByReviewStatusViaService,
  type VariationReviewItem,
} from '../../src/variations/review.js';
import { isVariationsAuthError } from '../../src/variations/service.js';

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const failResponse = (status: number, statusText = 'Nope') => ({
  ok: false,
  status,
  statusText,
  json: async () => ({ message: statusText }),
  text: async () => statusText,
});

const item = (key: string, extra: Partial<VariationReviewItem> = {}): VariationReviewItem => ({
  variationKey: key,
  resourceName: 'Property',
  fieldName: key.split('.')[1],
  lookupValue: null,
  status: 'pending',
  outcome: null,
  mapping: { suggestedFieldName: 'Buyer' },
  strategy: null,
  suggestions: null,
  provenance: [],
  lastUpdatedAt: '2026-09-16T15:27:11.915Z',
  otherDrafts: [],
  ...extra,
});

describe('listVariationReviewItemsViaService', () => {
  beforeEach(() => {
    process.env.RESO_SERVICES_URL = 'https://services.example.org';
    delete process.env.CERT_AUTH_API_BASE_URL;
    delete process.env.CERT_AUTH_API_USERNAME;
    delete process.env.CERTIFICATION_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.RESO_SERVICES_URL;
  });

  it('GETs the items route with the bearer and the status filter, and returns the items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ items: [item('Property.Buyer')] }));
    vi.stubGlobal('fetch', fetchMock);

    const items = await listVariationReviewItemsViaService({ bearerToken: 'tok', status: 'pending' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://services.example.org/v2/certification/variations-review-items');
    expect(parsed.searchParams.get('status')).toBe('pending');
    expect(parsed.searchParams.get('elementType')).toBeNull();
    expect(opts.method ?? 'GET').toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(items).toHaveLength(1);
    expect(items[0].variationKey).toBe('Property.Buyer');
  });

  it('passes elementType and limit through as query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await listVariationReviewItemsViaService({ bearerToken: 'tok', elementType: 'lookup', limit: 50 });

    const parsed = new URL(fetchMock.mock.calls[0][0]);
    expect(parsed.searchParams.get('elementType')).toBe('lookup');
    expect(parsed.searchParams.get('limit')).toBe('50');
    expect(parsed.searchParams.get('status')).toBeNull();
  });

  it('follows nextCursor until the service stops returning one, concatenating pages in order', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ items: [item('Property.A')], nextCursor: 'c1' }))
      .mockResolvedValueOnce(okResponse({ items: [item('Property.B')], nextCursor: 'c2' }))
      .mockResolvedValueOnce(okResponse({ items: [item('Property.C')] }));
    vi.stubGlobal('fetch', fetchMock);

    const items = await listVariationReviewItemsViaService({ bearerToken: 'tok' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('cursor')).toBeNull();
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('cursor')).toBe('c1');
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('cursor')).toBe('c2');
    expect(items.map(i => i.variationKey)).toEqual(['Property.A', 'Property.B', 'Property.C']);
  });

  it('returns the items exactly as served — nothing added, renamed or dropped', async () => {
    const served = item('Property.BuyerAgentKeyNumeric', {
      provenance: [
        {
          providerUoi: 'T00000001',
          providerUsi: '1',
          recipientUoi: 'M00000001',
          submittedAt: '2026-08-28T08:25:02.044Z',
          environmentName: 'qa',
        },
      ],
      strategy: 'Substring',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ items: [served] })));

    const [got] = await listVariationReviewItemsViaService({ bearerToken: 'tok' });

    expect(got).toEqual(served);
  });

  it('throws AUTH_REQUIRED with the .env hint when no token can be minted on the CLI path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(listVariationReviewItemsViaService({ fromCli: true })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringMatching(/TOKEN_URI.*CLIENT_SECRET.*CERT_AUTH_API_BASE_URL.*\.env/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403])('throws AUTH_REJECTED on %s and the auth predicate recognizes it', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failResponse(status)));

    const err = await listVariationReviewItemsViaService({ bearerToken: 'tok' }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'AUTH_REJECTED' });
    expect(isVariationsAuthError(err)).toBe(true);
  });

  it('throws SERVICE_ERROR naming the status on any other failure, and never returns a partial list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ items: [item('Property.A')], nextCursor: 'c1' }))
      .mockResolvedValueOnce(failResponse(500, 'Internal Server Error'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listVariationReviewItemsViaService({ bearerToken: 'tok' })).rejects.toMatchObject({
      code: 'SERVICE_ERROR',
      message: expect.stringContaining('500'),
    });
  });

  it('throws SERVICE_ERROR when RESO_SERVICES_URL is not set', async () => {
    delete process.env.RESO_SERVICES_URL;
    vi.stubGlobal('fetch', vi.fn());

    await expect(listVariationReviewItemsViaService({ bearerToken: 'tok' })).rejects.toMatchObject({
      code: 'SERVICE_ERROR',
      message: expect.stringContaining('RESO_SERVICES_URL'),
    });
  });

  it('rejects a response body without an items array rather than returning nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ message: 'unexpected' })));

    await expect(listVariationReviewItemsViaService({ bearerToken: 'tok' })).rejects.toMatchObject({
      code: 'SERVICE_ERROR',
    });
  });
});

describe('listMyEndorsementsViaService', () => {
  beforeEach(() => {
    process.env.RESO_SERVICES_URL = 'https://services.example.org';
    delete process.env.CERT_AUTH_API_BASE_URL;
    delete process.env.CERT_AUTH_API_USERNAME;
    delete process.env.CERTIFICATION_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.RESO_SERVICES_URL;
  });

  it('GETs endorsements/me with the bearer and returns the rows as served', async () => {
    const rows = [
      {
        providerUoi: 'T00000001',
        endorsementId: 'M00000001-T00000001-1-data-dictionary-2.1-abc',
        recipientUoi: 'M00000001',
        providerUsi: '1',
        endorsement: 'data-dictionary',
        version: '2.1',
        lifecycleStatus: 'in-review',
        reviewStatus: 'in-review',
        environmentName: 'qa',
        createdAt: '2026-09-16T15:27:11.915Z',
        updatedAt: '2026-09-16T15:27:11.915Z',
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ endorsements: rows }));
    vi.stubGlobal('fetch', fetchMock);

    const got = await listMyEndorsementsViaService({ bearerToken: 'tok' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://services.example.org/v2/certification/endorsements/me');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(got).toEqual(rows);
  });

  it('an empty endorsements array is an empty result, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ endorsements: [] })));

    await expect(listMyEndorsementsViaService({ bearerToken: 'tok' })).resolves.toEqual([]);
  });

  it.each([401, 403])('throws AUTH_REJECTED on %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failResponse(status)));

    await expect(listMyEndorsementsViaService({ bearerToken: 'tok' })).rejects.toMatchObject({ code: 'AUTH_REJECTED' });
  });

  it('throws SERVICE_ERROR when the body carries no endorsements array (a bare array is not the contract)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([{ providerUoi: 'T00000001', endorsementId: 'e1' }])));

    await expect(listMyEndorsementsViaService({ bearerToken: 'tok' })).rejects.toMatchObject({ code: 'SERVICE_ERROR' });
  });
});

describe('listEndorsementsByReviewStatusViaService', () => {
  beforeEach(() => {
    process.env.RESO_SERVICES_URL = 'https://services.example.org';
    delete process.env.CERT_AUTH_API_BASE_URL;
    delete process.env.CERT_AUTH_API_USERNAME;
    delete process.env.CERTIFICATION_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.RESO_SERVICES_URL;
  });

  it('GETs the endorsements route with the review status and returns the rows as served', async () => {
    const rows = [{ providerUoi: 'T00000001', endorsementId: 'e1', reviewStatus: 'in-review' }];
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ endorsements: rows }));
    vi.stubGlobal('fetch', fetchMock);

    const got = await listEndorsementsByReviewStatusViaService({ bearerToken: 'tok', reviewStatus: 'in-review' });

    const [url, opts] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://services.example.org/v2/certification/endorsements');
    expect(parsed.searchParams.get('reviewStatus')).toBe('in-review');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(got).toEqual(rows);
  });

  it('sends no reviewStatus when none is given, leaving the default to the route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ endorsements: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await listEndorsementsByReviewStatusViaService({ bearerToken: 'tok' });

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('reviewStatus')).toBeNull();
  });

  it.each([401, 403])('throws AUTH_REJECTED on %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failResponse(status)));

    await expect(listEndorsementsByReviewStatusViaService({ bearerToken: 'tok' })).rejects.toMatchObject({ code: 'AUTH_REJECTED' });
  });
});
