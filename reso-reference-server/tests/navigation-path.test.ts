import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { DataAccessLayer, NavigationPropertyBinding, ResourceContext } from '../src/db/data-access.js';
import { collectionHandler, navigationPropertyHandler, readHandler } from '../src/odata/handlers.js';
import type { HandlerContext } from '../src/odata/handlers.js';

// #285 — OData navigation-property-path GET `/{Resource}('key')/{NavProp}` (Web API Core 2.1.0 §2.5.10.2). The
// handler reuses $expand child-resolution: readByKey(parent, key, {$expand:[NavProp]}) then returns the resolved
// navigation property as a top-level response — a collection for a to-many nav, the single entity for a to-one.

const mediaBinding: NavigationPropertyBinding = {
  name: 'Media',
  targetResource: 'Media',
  targetKeyField: 'MediaKey',
  targetFields: [],
  foreignKey: { strategy: 'resource-record-key' },
  isCollection: true
};
const buyerAgentBinding: NavigationPropertyBinding = {
  name: 'BuyerAgent',
  targetResource: 'Member',
  targetKeyField: 'MemberKey',
  targetFields: [],
  foreignKey: { strategy: 'parent-fk', parentColumn: 'BuyerAgentKey' },
  isCollection: false
};

const resourceCtx: ResourceContext = {
  resource: 'Property',
  keyField: 'ListingKey',
  fields: [],
  navigationBindings: [mediaBinding, buyerAgentBinding],
  resolveChildContext: () => undefined
};

// readByKey returns the parent with the requested nav property inlined (as $expand would produce it).
const makeDal = (parentByKey: (key: string) => Record<string, unknown> | undefined): DataAccessLayer => ({
  queryCollection: vi.fn(),
  readByKey: vi.fn(async (_ctx, key: string) => parentByKey(key)),
  insert: vi.fn(),
  update: vi.fn(),
  deleteByKey: vi.fn()
});

const makeCtx = (dal: DataAccessLayer): HandlerContext => ({ resourceCtx, dal, baseUrlOverride: 'http://localhost:8080' });

const makeReq = (path: string, query: Record<string, string> = {}): Partial<Request> => ({ path, query, headers: {} });

const makeRes = (): Partial<Response> & { _status: number; _body: Record<string, unknown> } => {
  const res = {
    _status: 0,
    _body: {} as Record<string, unknown>,
    status: vi.fn().mockImplementation(function (this: typeof res, code: number) {
      this._status = code;
      return this;
    }),
    json: vi.fn().mockImplementation(function (this: typeof res, body: Record<string, unknown>) {
      this._body = body;
      return this;
    }),
    set: vi.fn().mockReturnThis()
  };
  return res;
};

describe('navigationPropertyHandler — collection nav (#285)', () => {
  it('returns 200 with the child collection under `value`, with the target-resource @odata.context', async () => {
    const media = [
      { MediaKey: 'M1', ResourceName: 'Property', ResourceRecordKey: 'P1' },
      { MediaKey: 'M2', ResourceName: 'Property', ResourceRecordKey: 'P1' }
    ];
    const dal = makeDal(key => (key === 'P1' ? { ListingKey: 'P1', Media: media } : undefined));
    const req = makeReq("/Property('P1')/Media");
    const res = makeRes();

    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(req as Request, res as Response, vi.fn());

    expect(res._status).toBe(200);
    expect(res._body['@odata.context']).toBe('http://localhost:8080/$metadata#Media');
    expect(res._body.value).toEqual(media);
  });

  it('passes $expand={NavProp} to readByKey (reuses the expand machinery)', async () => {
    const dal = makeDal(() => ({ ListingKey: 'P1', Media: [] }));
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(
      makeReq("/Property('P1')/Media") as Request,
      makeRes() as Response,
      vi.fn()
    );
    expect(dal.readByKey).toHaveBeenCalledWith(resourceCtx, 'P1', { $expand: [{ property: 'Media', options: {} }] });
  });

  it('passes a nested $select through to the expansion', async () => {
    const dal = makeDal(() => ({ ListingKey: 'P1', Media: [] }));
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(
      makeReq("/Property('P1')/Media", { $select: 'MediaKey' }) as Request,
      makeRes() as Response,
      vi.fn()
    );
    expect(dal.readByKey).toHaveBeenCalledWith(resourceCtx, 'P1', { $expand: [{ property: 'Media', options: { $select: 'MediaKey' } }] });
  });

  it('a parent with no children → 200 with an empty value array (not 404)', async () => {
    const dal = makeDal(() => ({ ListingKey: 'P1' })); // Media absent
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(makeReq("/Property('P1')/Media") as Request, res as Response, vi.fn());
    expect(res._status).toBe(200);
    expect(res._body.value).toEqual([]);
  });

  it('parent not found → 404', async () => {
    const dal = makeDal(() => undefined);
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(makeReq("/Property('NOPE')/Media") as Request, res as Response, vi.fn());
    expect(res._status).toBe(404);
  });

  it('missing key in the path → 400', async () => {
    const dal = makeDal(() => ({ ListingKey: 'P1', Media: [] }));
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(makeReq('/Property/Media') as Request, res as Response, vi.fn());
    expect(res._status).toBe(400);
  });
});

describe('navigationPropertyHandler — to-one nav (#285)', () => {
  it('returns 200 with the single related entity ($entity context)', async () => {
    const agent = { MemberKey: 'AG1', MemberFullName: 'A. Gent' };
    const dal = makeDal(() => ({ ListingKey: 'P1', BuyerAgent: agent }));
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), buyerAgentBinding)(
      makeReq("/Property('P1')/BuyerAgent") as Request,
      res as Response,
      vi.fn()
    );
    expect(res._status).toBe(200);
    expect(res._body['@odata.context']).toBe('http://localhost:8080/$metadata#Member/$entity');
    expect(res._body.MemberKey).toBe('AG1');
  });

  it('an unset to-one relationship → 404', async () => {
    const dal = makeDal(() => ({ ListingKey: 'P1', BuyerAgent: null }));
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), buyerAgentBinding)(
      makeReq("/Property('P1')/BuyerAgent") as Request,
      res as Response,
      vi.fn()
    );
    expect(res._status).toBe(404);
  });
});

// reso-tools #440 – the path's query options become the expansion's options; what is not implemented is a 501.
describe('navigationPropertyHandler – query options on the path (#440)', () => {
  it('passes $select, $orderby, $top, $skip and $count to the expansion, and returns the count', async () => {
    const dal = makeDal(() => ({ ListingKey: 'L1', 'Media@odata.count': 7, Media: [{ MediaKey: 'M2' }] }));
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(
      makeReq("/Property('L1')/Media", { $select: 'MediaKey', $orderby: 'Order desc', $top: '1', $skip: '1', $count: 'true' }) as Request,
      res as unknown as Response,
      vi.fn()
    );
    expect(vi.mocked(dal.readByKey).mock.calls[0][2]).toEqual({
      $expand: [{ property: 'Media', options: { $select: 'MediaKey', $orderby: 'Order desc', $top: 1, $skip: 1, $count: true } }]
    });
    expect(res._status).toBe(200);
    expect(res._body['@odata.count']).toBe(7);
  });

  it('passes $filter on the path to the expansion, where the backend applies it', async () => {
    const dal = makeDal(() => ({ ListingKey: 'L1', Media: [] }));
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(
      makeReq("/Property('L1')/Media", { $filter: "MediaType eq 'Jpeg'" }) as Request,
      res as unknown as Response,
      vi.fn()
    );
    expect(vi.mocked(dal.readByKey).mock.calls[0][2]).toEqual({
      $expand: [{ property: 'Media', options: { $filter: "MediaType eq 'Jpeg'" } }]
    });
    expect(res._status).toBe(200);
  });

  it('answers 501 for $search on the path, without reading anything', async () => {
    const dal = makeDal(() => ({ ListingKey: 'L1', Media: [] }));
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(
      makeReq("/Property('L1')/Media", { $search: 'kitchen' }) as Request,
      res as unknown as Response,
      vi.fn()
    );
    expect(res._status).toBe(501);
    expect(JSON.stringify(res._body)).toMatch(/\$search on \/Property\('key'\)\/Media/);
    expect(dal.readByKey).not.toHaveBeenCalled();
  });

  it('answers 400 for a $top that is not a non-negative integer', async () => {
    const dal = makeDal(() => ({ ListingKey: 'L1', Media: [] }));
    const res = makeRes();
    await navigationPropertyHandler(makeCtx(dal), mediaBinding)(
      makeReq("/Property('L1')/Media", { $top: '-1' }) as Request,
      res as unknown as Response,
      vi.fn()
    );
    expect(res._status).toBe(400);
  });
});

describe('readHandler and collectionHandler – options inside $expand (#440)', () => {
  it('answers 501 for $search inside $expand on a single read, naming it, without reading anything', async () => {
    const dal = makeDal(() => ({ ListingKey: 'L1' }));
    const res = makeRes();
    await readHandler(makeCtx(dal))(
      makeReq("/Property('L1')", { $expand: 'Media($search=kitchen)' }) as Request,
      res as unknown as Response,
      vi.fn()
    );
    expect(res._status).toBe(501);
    expect(JSON.stringify(res._body)).toMatch(/\$search inside \$expand=Media/);
    expect(dal.readByKey).not.toHaveBeenCalled();
  });

  it('answers 400, not 500, when a $filter inside $expand names a field the expanded resource lacks', async () => {
    const dal = makeDal(() => ({ ListingKey: 'L1' }));
    vi.mocked(dal.readByKey).mockRejectedValueOnce(new Error('Unknown field in $filter: "Nope"'));
    const res = makeRes();
    await readHandler(makeCtx(dal))(
      makeReq("/Property('L1')", { $expand: "Media($filter=Nope eq 'x')" }) as Request,
      res as unknown as Response,
      vi.fn()
    );
    expect(res._status).toBe(400);
  });

  it('answers 400, not 500, for a malformed $expand on a single read', async () => {
    const dal = makeDal(() => ({ ListingKey: 'L1' }));
    const res = makeRes();
    await readHandler(makeCtx(dal))(
      makeReq("/Property('L1')", { $expand: 'Media($top=abc)' }) as Request,
      res as unknown as Response,
      vi.fn()
    );
    expect(res._status).toBe(400);
  });

  it('answers 501 for $levels inside $expand on a collection', async () => {
    const dal = makeDal(() => undefined);
    const res = makeRes();
    await collectionHandler(makeCtx(dal))(
      makeReq('/Property', { $expand: 'Media($levels=2)' }) as Request,
      res as unknown as Response,
      vi.fn()
    );
    expect(res._status).toBe(501);
    expect(dal.queryCollection).not.toHaveBeenCalled();
  });
});
