/**
 * The read and write handlers go through the SDK's CRUD helpers rather than assembling requests
 * themselves.
 *
 * Two things are worth asserting. The query options have to survive the handoff, because the
 * previous implementation built them by hand and a silent regression there changes what a search
 * returns rather than failing. And `ifMatch` has to actually reach the wire, because an optimistic
 * concurrency check that sends no header is not a check: the write lands anyway and the caller
 * believes it was guarded.
 *
 * Every assertion is on the request that left the process, not on what the handler returned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_AUTH_TOKEN, ENV_BASE_URL } from '../src/auth-env.js';
import { handlers } from '../src/handlers.js';

const SERVER = 'https://data.example.com';
const KEY = 'listing-key-1';

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Records every outgoing request and answers each with an empty OData collection. */
const recordRequests = (): ReadonlyArray<RecordedCall> => {
  const calls: RecordedCall[] = [];

  vi.stubGlobal('fetch', async (input: unknown, init: Record<string, unknown> = {}) => {
    calls.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : ''
    });

    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

  return calls;
};

/** The data request, skipping any token exchange the client may make first. */
const dataCall = (calls: ReadonlyArray<RecordedCall>): RecordedCall | undefined => calls.find(c => !c.url.includes('/oauth/token'));

beforeEach(() => {
  vi.stubEnv(ENV_AUTH_TOKEN, 'test-token');
  vi.stubEnv(ENV_BASE_URL, SERVER);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('query hands its options to the SDK intact', () => {
  it('carries every option through, so none is dropped in the handoff', async () => {
    const calls = recordRequests();

    await handlers.query({
      url: SERVER,
      resource: 'Property',
      filter: "City eq 'Austin'",
      select: 'ListingKey,ListPrice',
      orderby: 'ListPrice desc',
      top: 5,
      skip: 10,
      count: true,
      expand: 'Media'
    });

    const url = dataCall(calls)?.url ?? '';
    const decoded = decodeURIComponent(url);

    expect(decoded).toContain('/Property');
    expect(decoded).toContain("$filter=City eq 'Austin'");
    expect(decoded).toContain('$select=ListingKey,ListPrice');
    expect(decoded).toContain('$orderby=ListPrice desc');
    expect(decoded).toContain('$top=5');
    expect(decoded).toContain('$skip=10');
    expect(decoded).toContain('$count=true');
    expect(decoded).toContain('$expand=Media');
  });

  it('omits what was not asked for rather than sending empty options', async () => {
    const calls = recordRequests();

    await handlers.query({ url: SERVER, resource: 'Property' });

    const url = dataCall(calls)?.url ?? '';
    for (const option of ['$filter', '$select', '$orderby', '$top', '$skip', '$count', '$expand']) {
      expect(url).not.toContain(option);
    }
  });

  it('sends $count=false as absent rather than as the string false', async () => {
    // A server reading $count=false literally is conformant; sending it when the caller said no is
    // still wrong, and the old hand-built path happened to get this right by accident.
    const calls = recordRequests();

    await handlers.query({ url: SERVER, resource: 'Property', count: false });

    expect(dataCall(calls)?.url ?? '').not.toContain('$count');
  });
});

describe('ifMatch reaches the wire, which is the point of using the write helpers', () => {
  it('sends If-Match on update when the caller supplies an etag', async () => {
    const calls = recordRequests();

    await handlers.update({
      url: SERVER,
      resource: 'Property',
      key: KEY,
      record: { ListPrice: 1 },
      ifMatch: 'W/"etag-1"'
    });

    const call = dataCall(calls);
    expect(call?.method).toBe('PATCH');
    expect(call?.headers['If-Match']).toBe('W/"etag-1"');
  });

  it('sends no If-Match on update when none was supplied, rather than a wildcard', async () => {
    // Defaulting an absent etag to "*" would turn every unguarded write into one that claims to be
    // guarded and matches anything. Absent has to stay absent.
    const calls = recordRequests();

    await handlers.update({ url: SERVER, resource: 'Property', key: KEY, record: { ListPrice: 1 } });

    const call = dataCall(calls);
    expect(call?.method).toBe('PATCH');
    expect(call?.headers['If-Match']).toBeUndefined();
  });

  it('sends If-Match on delete too, so the guard is not update-only', async () => {
    const calls = recordRequests();

    await handlers.delete({ url: SERVER, resource: 'Property', key: KEY, ifMatch: 'W/"etag-2"' });

    const call = dataCall(calls);
    expect(call?.method).toBe('DELETE');
    expect(call?.headers['If-Match']).toBe('W/"etag-2"');
  });

  it('sends no If-Match on delete when none was supplied', async () => {
    const calls = recordRequests();

    await handlers.delete({ url: SERVER, resource: 'Property', key: KEY });

    expect(dataCall(calls)?.headers['If-Match']).toBeUndefined();
  });

  it('treats an empty etag as absent, not as a header with no value', async () => {
    const calls = recordRequests();

    await handlers.update({
      url: SERVER,
      resource: 'Property',
      key: KEY,
      record: { ListPrice: 1 },
      ifMatch: ''
    });

    expect(dataCall(calls)?.headers['If-Match']).toBeUndefined();
  });
});

describe('the write verbs and URL shapes are unchanged by the switch', () => {
  it('creates with POST against the collection, with no key in the URL', async () => {
    const calls = recordRequests();

    await handlers.create({ url: SERVER, resource: 'Office', record: { OfficeCity: 'Eugene' } });

    const call = dataCall(calls);
    expect(call?.method).toBe('POST');
    expect(call?.url).toContain('/Office');
    expect(call?.url).not.toContain("('");
    expect(call?.body).toContain('Eugene');
  });

  it('updates and deletes against the keyed URL', async () => {
    const updateCalls = recordRequests();
    await handlers.update({ url: SERVER, resource: 'Property', key: KEY, record: { ListPrice: 1 } });
    expect(decodeURIComponent(dataCall(updateCalls)?.url ?? '')).toContain(`Property('${KEY}')`);

    vi.unstubAllGlobals();

    const deleteCalls = recordRequests();
    await handlers.delete({ url: SERVER, resource: 'Property', key: KEY });
    expect(decodeURIComponent(dataCall(deleteCalls)?.url ?? '')).toContain(`Property('${KEY}')`);
  });
});

describe('the credential binding still runs before any request', () => {
  it('refuses a call aimed at a server the environment credential is not bound to', async () => {
    // The refactor moved client construction behind a helper. If that helper ever stopped calling
    // resolveAuthToken first, this is the test that notices: the bound-origin check is the only
    // thing standing between an ambient credential and whatever host a tool call names.
    const calls = recordRequests();

    // The handler throws and index.ts turns that into an error result for the client. What matters
    // here is the second assertion: the refusal happened before anything was sent.
    await expect(handlers.query({ url: 'https://somewhere-else.example.com', resource: 'Property' })).rejects.toThrow(/bound to/);

    expect(dataCall(calls)).toBeUndefined();
  });
});
