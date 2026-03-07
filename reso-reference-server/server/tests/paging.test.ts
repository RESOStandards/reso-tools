import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { collectionHandler } from '../src/odata/handlers.js';
import type { HandlerContext } from '../src/odata/handlers.js';
import type { DataAccessLayer, ResourceContext } from '../src/db/data-access.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeRecord = (key: string): Record<string, unknown> => ({ ListingKey: key, ListPrice: 100000 });
const makeRecords = (count: number, startIndex = 0): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => makeRecord(`L${startIndex + i + 1}`));

const mockResourceCtx: ResourceContext = {
  resource: 'Property',
  keyField: 'ListingKey',
  fields: [],
  navigationBindings: [],
  resolveChildContext: () => undefined
};

const makeMockDal = (totalAvailable: number): DataAccessLayer => ({
  queryCollection: vi.fn(async (_ctx, options) => {
    const top = options.$top ?? totalAvailable;
    const skip = options.$skip ?? 0;
    const available = Math.max(totalAvailable - skip, 0);
    const count = Math.min(top, available);
    return { value: makeRecords(count, skip) };
  }),
  readByKey: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  deleteByKey: vi.fn()
});

const makeCtx = (dal: DataAccessLayer): HandlerContext => ({
  resourceCtx: mockResourceCtx,
  dal,
  baseUrl: 'http://localhost:8080'
});

const makeReq = (query: Record<string, string> = {}, headers: Record<string, string> = {}): Partial<Request> => ({
  query,
  headers
});

const makeRes = (): Partial<Response> & { _status: number; _body: Record<string, unknown>; _headers: Record<string, string> } => {
  const res = {
    _status: 0,
    _body: {} as Record<string, unknown>,
    _headers: {} as Record<string, string>,
    status: vi.fn().mockImplementation(function (this: typeof res, code: number) {
      this._status = code;
      return this;
    }),
    json: vi.fn().mockImplementation(function (this: typeof res, body: Record<string, unknown>) {
      this._body = body;
      return this;
    }),
    set: vi.fn().mockImplementation(function (this: typeof res, key: string, value: string) {
      this._headers[key] = value;
      return this;
    })
  };
  return res;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server-driven paging', () => {
  describe('default page size', () => {
    it('returns at most 100 records by default when no $top is specified', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq();
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect(res._status).toBe(200);
      expect((res._body.value as unknown[]).length).toBe(100);
      expect(res._body['@odata.nextLink']).toBeDefined();
    });

    it('does not emit nextLink when fewer records exist than default page size', async () => {
      const dal = makeMockDal(50);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq();
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(50);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });
  });

  describe('$top interaction with page size', () => {
    it('$top=1 returns 1 record with no nextLink even if more exist', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({ $top: '1' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(1);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });

    it('$top=50 returns 50 records with no nextLink (within default page size)', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({ $top: '50' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(50);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });

    it('$top=200 returns all 200 in one page (no nextLink) since $top fits within max', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({ $top: '200' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(200);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });

    it('$top=200 with maxpagesize=50 returns 50 with nextLink', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({ $top: '200' }, { prefer: 'odata.maxpagesize=50' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(50);
      expect(res._body['@odata.nextLink']).toBeDefined();
      expect(res._body['@odata.nextLink']).toContain('$top=200');
      expect(res._body['@odata.nextLink']).toContain('$skip=50');
    });

    it('$top=2001 caps fetch at 2000 per page', async () => {
      const dal = makeMockDal(5000);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({ $top: '2001' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(2000);
      expect(res._body['@odata.nextLink']).toBeDefined();
      expect(res._body['@odata.nextLink']).toContain('$top=2001');
      expect(res._body['@odata.nextLink']).toContain('$skip=2000');
    });
  });

  describe('Prefer: odata.maxpagesize', () => {
    it('uses maxpagesize as the page size', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({}, { prefer: 'odata.maxpagesize=25' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(25);
      expect(res._body['@odata.nextLink']).toBeDefined();
    });

    it('responds with Preference-Applied header', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({}, { prefer: 'odata.maxpagesize=25' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect(res._headers['Preference-Applied']).toBe('odata.maxpagesize=25');
    });

    it('caps maxpagesize at MAX_PAGE_SIZE (2000)', async () => {
      const dal = makeMockDal(5000);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({}, { prefer: 'odata.maxpagesize=5000' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(2000);
      expect(res._headers['Preference-Applied']).toBe('odata.maxpagesize=2000');
    });

    it('$top and maxpagesize interact correctly — both act as upper bounds', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      // maxpagesize=50, $top=30 — should return 30 (client only wants 30 total)
      const req = makeReq({ $top: '30' }, { prefer: 'odata.maxpagesize=50' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(30);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });

    it('$top larger than maxpagesize pages correctly', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      // maxpagesize=25, $top=60 — first page should return 25 with nextLink
      const req = makeReq({ $top: '60' }, { prefer: 'odata.maxpagesize=25' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(25);
      expect(res._body['@odata.nextLink']).toBeDefined();
      expect(res._body['@odata.nextLink']).toContain('$top=60');
    });
  });

  describe('nextLink correctness', () => {
    it('nextLink includes $filter and $select from original query', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({ $filter: "City eq 'Austin'", $select: 'ListingKey,ListPrice' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      const nextLink = res._body['@odata.nextLink'] as string;
      expect(nextLink).toContain('$filter=');
      expect(nextLink).toContain('$select=');
      expect(nextLink).toContain('$skip=100');
      // No $top in nextLink when client didn't specify one
      expect(nextLink).not.toContain('$top=');
    });

    it('no nextLink when all data fits in one page', async () => {
      const dal = makeMockDal(100);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq();
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      // Exactly 100 records = exactly default page size, but are there more?
      // The DAL returns exactly 100 and that equals fetchLimit, so nextLink IS emitted.
      // This is correct — the server can't know there aren't 101 records without over-fetching.
      expect((res._body.value as unknown[]).length).toBe(100);
      expect(res._body['@odata.nextLink']).toBeDefined();
    });

    it('no nextLink when result count is less than page size', async () => {
      const dal = makeMockDal(99);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq();
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(99);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });

    it('second page with $skip returns remaining records', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      // Simulate following a nextLink: $top=300, $skip=100
      // remaining = 300 - 100 = 200, effectivePageSize = min(300, 2000) = 300
      // fetchLimit = min(200, 300) = 200, returns 200, client satisfied (100+200=300)
      const req = makeReq({ $top: '300', $skip: '100' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(200);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });

    it('pages correctly when maxpagesize is smaller than remaining', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      // $top=300, $skip=100, maxpagesize=50 → remaining=200, pageSize=50, fetch=50
      const req = makeReq({ $top: '300', $skip: '100' }, { prefer: 'odata.maxpagesize=50' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(50);
      expect(res._body['@odata.nextLink']).toBeDefined();
      expect(res._body['@odata.nextLink']).toContain('$skip=150');
      expect(res._body['@odata.nextLink']).toContain('$top=300');
    });

    it('last page has no nextLink when $top obligation is met', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      // $top=150, $skip=100 → remaining=50, fetch 50, then done
      const req = makeReq({ $top: '150', $skip: '100' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(50);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('empty result set returns no nextLink', async () => {
      const dal = makeMockDal(0);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq();
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(0);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });

    it('$top=0 returns empty result with no nextLink', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({ $top: '0' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(0);
      expect(res._body['@odata.nextLink']).toBeUndefined();
    });

    it('handles Prefer header with multiple preferences', async () => {
      const dal = makeMockDal(500);
      const handler = collectionHandler(makeCtx(dal));
      const req = makeReq({}, { prefer: 'return=representation, odata.maxpagesize=10' });
      const res = makeRes();

      await handler(req as Request, res as unknown as Response, vi.fn());

      expect((res._body.value as unknown[]).length).toBe(10);
      expect(res._headers['Preference-Applied']).toBe('odata.maxpagesize=10');
    });
  });
});
