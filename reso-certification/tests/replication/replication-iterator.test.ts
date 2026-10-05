/**
 * The replication iterator's paging loop.
 *
 * These tests exist because the implementation they replaced was wrong in a way its absence of
 * tests could not reveal: it truncated at exactly `$top` against any provider that served a
 * nextLink with a page smaller than the requested window. One real provider lost 1,909 of 2,909
 * lookup rows that way, on every recipient, on two Data Dictionary versions, and the resulting
 * reports looked clean.
 *
 * The scripted server below is the piece the old tests lacked. The existing legacy replication mock
 * honors `$top` exactly — it always serves what was asked for, or fewer only when the collection
 * runs out — so no test could express "the server serves fewer rows than requested while more
 * remain," which is the only shape that failed. `serverPageCap` is that shape.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  REPLICATION_STRATEGIES,
  replicationIterator
} from '../../src/replication/replication-iterator.js';
import type { ODataRequester } from '../../src/test-runner/index.js';

const ROOT = 'https://example.com/odata';

const lookupRows = (count: number): ReadonlyArray<Record<string, unknown>> =>
  Array.from({ length: count }, (_, i) => ({
    LookupKey: `K${i}`,
    LookupName: `Lookup${Math.floor(i / 10)}`,
    LookupValue: `Value ${i}`
  }));

interface ServerOptions {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** The most rows this server will put in one response, whatever `$top` asked for. */
  readonly serverPageCap?: number;
  /** Offer `@odata.nextLink` while more rows remain, as a server-driven-paging provider does. */
  readonly offerNextLink?: boolean;
  /** Advertise this as `@odata.count`, truthfully or not. */
  readonly advertisedCount?: number;
  /** Status to answer with, by 1-based request number. Anything unlisted answers 200. */
  readonly statusByRequest?: Readonly<Record<number, number>>;
}

/** A server that honors `$skip`, and serves at most `serverPageCap` rows per response. */
const scriptServer = (options: ServerOptions): { requester: ODataRequester; urls: string[] } => {
  const urls: string[] = [];
  const requester: ODataRequester = {
    request: async ({ url }) => {
      urls.push(url);
      const status = options.statusByRequest?.[urls.length] ?? 200;
      if (status !== 200) {
        const body = { error: { code: String(status), message: 'scripted failure' } };
        return { status, headers: {}, body, rawBody: JSON.stringify(body) };
      }

      const parsed = new URL(url);
      const top = Number(parsed.searchParams.get('$top') ?? '0');
      const skip = Number(parsed.searchParams.get('$skip') ?? '0');
      const size = Math.min(top, options.serverPageCap ?? top);
      const page = options.rows.slice(skip, skip + size);

      const body: Record<string, unknown> = { value: page };
      if (options.advertisedCount !== undefined) body['@odata.count'] = options.advertisedCount;
      // A `$top` on a server-driven walk BOUNDS that walk: the server offers links until `$top` is
      // satisfied or it runs out of rows. Encoding the remaining budget in the link is what makes
      // this fixture reproduce the truncation. A fixture that keeps offering links past `$top`
      // cannot, which is how a regression test for this defect quietly becomes vacuous — verified
      // the hard way, by watching the old implementation pass against a fixture missing this.
      const remaining = top - page.length;
      if (options.offerNextLink && remaining > 0 && skip + page.length < options.rows.length) {
        body['@odata.nextLink'] = `${ROOT}/Lookup?$skip=${skip + page.length}&$top=${remaining}`;
      }
      return { status, headers: {}, body, rawBody: JSON.stringify(body) };
    }
  };
  return { requester, urls };
};

const walk = async (
  requester: ODataRequester,
  overrides: Partial<Parameters<typeof replicationIterator>[0]> = {}
): Promise<{ records: Array<Record<string, unknown>>; counts: Array<number | undefined> }> => {
  const records: Array<Record<string, unknown>> = [];
  const counts: Array<number | undefined> = [];
  for await (const page of replicationIterator({
    serviceRootUri: ROOT,
    resourceName: 'Lookup',
    strategy: REPLICATION_STRATEGIES.TOP_AND_SKIP,
    authToken: 'test-token',
    requester,
    ...overrides
  })) {
    records.push(...page.records);
    counts.push(page.advertisedCount);
  }
  return { records, counts };
};

const skips = (urls: ReadonlyArray<string>): Array<string | null> =>
  urls.map(u => new URL(u).searchParams.get('$skip'));

describe('replicationIterator — TopAndSkip', () => {
  it('walks the complete set against a server that caps its page below $top', async () => {
    // 2,909 rows, 200 per response, nextLink offered. The implementation this replaced returned
    // exactly 1,000 here, because $top=1000 bounded the server-driven walk and the 200-row page
    // then failed its `>= PAGE_SIZE` continuation test. This is the regression.
    const rows = lookupRows(2909);
    const { requester, urls } = scriptServer({ rows, serverPageCap: 200, offerNextLink: true });

    const { records } = await walk(requester, { pageSize: 1000 });

    expect(records).toHaveLength(2909);
    expect(records.at(-1)).toEqual(rows.at(-1));
    // 14 full pages of 200, a 109-row page, then the empty page that ends it.
    expect(urls).toHaveLength(16);
  });

  it('advances $skip by the records SERVED, never by the requested window', async () => {
    // Advancing by $top instead would jump 0 → 1000 and silently lose rows 201-1000. That is a gap
    // rather than a truncation, which is worse: the total looks plausible and the holes scatter.
    const { requester, urls } = scriptServer({ rows: lookupRows(650), serverPageCap: 200 });

    const { records } = await walk(requester, { pageSize: 1000 });

    expect(records).toHaveLength(650);
    expect(skips(urls)).toEqual(['0', '200', '400', '600', '650']);
  });

  it('treats a short page as a short page, not as end-of-data', async () => {
    // The specification's own example: 1,000 requested, 100 supported, so the next query is
    // $top=100-worth further on. A client that stops here reports 100 of 250 rows as complete.
    const { requester, urls } = scriptServer({ rows: lookupRows(250), serverPageCap: 100 });

    const { records } = await walk(requester, { pageSize: 1000 });

    expect(records).toHaveLength(250);
    expect(skips(urls)).toEqual(['0', '100', '200', '250']);
  });

  it('still issues one more request after a page that exactly fills the window', async () => {
    // The exactly-`pageSize` edge: 400 rows at 200 a page looks finished after the second page, and
    // is not. Only the empty third response says so.
    //
    // Naming this "terminates only on a zero-record response" would overclaim — a client that
    // stopped on `records.length < top` also makes exactly three requests here and passes. What
    // proves the "only" is the short-page test above, where such a client returns 100 of 250.
    const { requester, urls } = scriptServer({ rows: lookupRows(400), serverPageCap: 200 });

    const { records } = await walk(requester, { pageSize: 200 });

    expect(records).toHaveLength(400);
    expect(urls).toHaveLength(3);
    expect(skips(urls).at(-1)).toBe('400');
  });

  it('never follows @odata.nextLink, even when the server offers one on every page', async () => {
    // pageSize MUST exceed serverPageCap for the fixture to offer any link at all: it withdraws the
    // link once `$top` is satisfied, so `pageSize === cap` leaves remaining = 0 and offers none.
    // With 1000 requested and 100 served, every page carries a link with 900 of budget left.
    const { requester, urls } = scriptServer({ rows: lookupRows(500), serverPageCap: 100, offerNextLink: true });

    const { records } = await walk(requester, { pageSize: 1000 });

    // A follower would have been bounded at 1000 and, here, stopped at 500 by coincidence — so the
    // assertion that matters is the URL shape: every request is one this iterator built itself.
    expect(records).toHaveLength(500);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('$top')).toBe('1000');
      expect(parsed.searchParams.has('$skip')).toBe(true);
    }
    expect(skips(urls)).toEqual(['0', '100', '200', '300', '400', '500']);
  });

  it('surfaces @odata.count but makes no decision on it', async () => {
    // The advertised count is wrong on purpose, and lower than the truth. A count-driven loop bound
    // would stop at 50 and call it complete. Advertised counts are not reliable enough to decide on.
    const { requester } = scriptServer({ rows: lookupRows(250), serverPageCap: 100, advertisedCount: 50 });

    const { records, counts } = await walk(requester, { pageSize: 100 });

    expect(records).toHaveLength(250);
    expect(counts.every(c => c === 50)).toBe(true);
  });

  it('never requests $count of its own accord', async () => {
    const { requester, urls } = scriptServer({ rows: lookupRows(10), serverPageCap: 10 });

    await walk(requester, { pageSize: 10 });

    // Read the parsed parameter, NOT the URL text. `URLSearchParams` serializes every `$`-key as
    // `%24`, so `url.includes('$count')` is false even for a URL that sets `$count` — an assertion
    // on the text passes against an implementation that requests a count on every page.
    for (const url of urls) {
      expect(new URL(url).searchParams.has('$count')).toBe(false);
    }
  });

  it('sends only $top and $skip when the caller passes no query of its own', async () => {
    // The guard for "never ADD an `$orderby`" — or anything else. Asserting that a caller-supplied
    // parameter round-trips cannot catch a parameter the client injects by itself.
    const { requester, urls } = scriptServer({ rows: lookupRows(5), serverPageCap: 5 });

    await walk(requester, { pageSize: 5 });

    for (const url of urls) {
      expect([...new URL(url).searchParams.keys()].sort()).toEqual(['$skip', '$top']);
    }
  });

  it('preserves the caller’s query options and owns only $top and $skip', async () => {
    const { requester, urls } = scriptServer({ rows: lookupRows(300), serverPageCap: 100 });

    await walk(requester, {
      pageSize: 100,
      query: { $filter: "LookupName eq 'Roof'", $orderby: 'LookupKey', $top: '7', $skip: '9' }
    });

    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('$filter')).toBe("LookupName eq 'Roof'");
      expect(parsed.searchParams.get('$orderby')).toBe('LookupKey');
      // The caller's $top/$skip are overridden — those two belong to the walk.
      expect(parsed.searchParams.get('$top')).toBe('100');
    }
    expect(skips(urls)).toEqual(['0', '100', '200', '300']);
  });

  it('defaults the window to DEFAULT_PAGE_SIZE when the caller gives none', async () => {
    const { requester, urls } = scriptServer({ rows: lookupRows(5) });

    await walk(requester);

    expect(new URL(urls[0]).searchParams.get('$top')).toBe(String(DEFAULT_PAGE_SIZE));
  });

  it('stops on a non-200 without advancing the cursor or reissuing the request', async () => {
    const { requester, urls } = scriptServer({
      rows: lookupRows(500),
      serverPageCap: 100,
      statusByRequest: { 3: 500 }
    });

    const pages = [];
    for await (const page of replicationIterator({
      serviceRootUri: ROOT,
      resourceName: 'Lookup',
      strategy: REPLICATION_STRATEGIES.TOP_AND_SKIP,
      authToken: 'test-token',
      pageSize: 100,
      requester
    })) {
      pages.push(page);
    }

    expect(urls).toHaveLength(3);
    const last = pages.at(-1);
    expect(last?.status).toBe(500);
    expect(last?.records).toEqual([]);
    // The cursor is where the two good pages left it, not advanced past the failure.
    expect(last?.totalRecordsFetched).toBe(200);
    expect(last?.errorBody).toContain('scripted failure');
  });

  it('reports the URL that actually failed, not the one before it', async () => {
    const { requester } = scriptServer({ rows: lookupRows(500), serverPageCap: 100, statusByRequest: { 2: 503 } });

    const pages = [];
    for await (const page of replicationIterator({
      serviceRootUri: ROOT,
      resourceName: 'Lookup',
      strategy: REPLICATION_STRATEGIES.TOP_AND_SKIP,
      authToken: 'test-token',
      pageSize: 100,
      requester
    })) {
      pages.push(page);
    }

    expect(new URL(pages.at(-1)!.requestUrl).searchParams.get('$skip')).toBe('100');
  });
});

describe('replicationIterator — the strategies that are not implemented', () => {
  // Each must REFUSE rather than fall through to TopAndSkip. A silent fallthrough is how a caller
  // ends up on a strategy it did not ask for, which is the class of defect that prompted all this.
  it.each([REPLICATION_STRATEGIES.TIMESTAMP_ASC, REPLICATION_STRATEGIES.TIMESTAMP_DESC, REPLICATION_STRATEGIES.NEXT_LINK])(
    '%s throws rather than silently paging another way',
    async strategy => {
      const { requester, urls } = scriptServer({ rows: lookupRows(10), serverPageCap: 10 });

      const iterate = async (): Promise<void> => {
        for await (const _page of replicationIterator({
          serviceRootUri: ROOT,
          resourceName: 'Lookup',
          strategy,
          authToken: 'test-token',
          requester
        })) {
          // unreachable
        }
      };

      await expect(iterate()).rejects.toThrow(/not implemented/i);
      expect(urls).toHaveLength(0);
    }
  );
});

describe('replicationIterator — the optional record dump', () => {
  // The Lookup pull accumulates in memory and does not use this. It exists for when a walk needs to
  // be inspected after the fact, so it is tested rather than left to be discovered broken later.
  it('writes one file per non-empty page when an output path is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repl-dump-'));
    try {
      const { requester } = scriptServer({ rows: lookupRows(250), serverPageCap: 100 });

      await walk(requester, { pageSize: 100, outputPath: dir });

      const files = (await readdir(dir)).sort();
      // Three non-empty pages (100, 100, 50). The empty page that ends the walk writes nothing.
      expect(files).toEqual(['Lookup-page-1.json', 'Lookup-page-2.json', 'Lookup-page-3.json']);

      const page3 = JSON.parse(await readFile(join(dir, 'Lookup-page-3.json'), 'utf-8'));
      expect(page3.value).toHaveLength(50);
      expect(page3.value[0].LookupKey).toBe('K200');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Deliberately NOT tested: "writes nothing when no output path is given." The obvious form of
  // that test makes a temp directory the iterator has never been told about and asserts it stays
  // empty, which passes whatever the iterator does. A test that cannot fail is worse than no test,
  // because it reads as coverage.
});

describe('replicationIterator — malformed responses', () => {
  const respond = (body: unknown): ODataRequester => ({
    request: async () => ({ status: 200, headers: {}, body, rawBody: JSON.stringify(body) })
  });

  it.each([
    ['an object', { value: { nope: true } }],
    ['a string', { value: 'nope' }],
    ['a number', { value: 7 }]
  ])('refuses a 200 whose value is %s rather than reading it as an empty page', async (_label, body) => {
    // Substituting [] would end the walk and report "the resource exists and has no rows", which is
    // a clean-looking wrong answer. The previous implementation threw here too, but only by accident,
    // via a TypeError on spreading a non-iterable.
    await expect(walk(respond(body))).rejects.toThrow(/"value" is .*not an array/i);
  });

  it('still treats an absent value as an empty page, which is the prior behavior', async () => {
    // Left deliberately tolerant so this change cannot newly fail a provider that answers an empty
    // collection without the member.
    const { records } = await walk(respond({}));
    expect(records).toEqual([]);
  });
});
