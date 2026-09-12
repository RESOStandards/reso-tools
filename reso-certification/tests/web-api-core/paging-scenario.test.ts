import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { runPagingScenario } from '../../src/web-api-core/test-runner.js';

const response = (status: number, value: unknown[] = [], nextLink?: string): ODataResponse => ({
  status,
  headers: { 'odata-version': '4.01' },
  body: { value, ...(nextLink ? { '@odata.nextLink': nextLink } : {}) },
  rawBody: ''
});

interface RecordedCall { readonly url: string; readonly headers?: Readonly<Record<string, string>>; }

// Injected test client: returns the scripted responses in order AND records each request (url + headers),
// so tests can assert the request SHAPE the walk builds (filter / orderby / $top / Prefer maxpagesize).
const recordingRequester = (responses: readonly ODataResponse[]): { readonly requester: ODataRequester; readonly calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const requester: ODataRequester = {
    request: async (req) => {
      calls.push({ url: req.url, headers: req.headers });
      const next = queue.shift();
      if (!next) throw new Error('requester queue exhausted');
      return next;
    }
  };
  return { requester, calls };
};

// Params carry the sampled timestamp field + its `gt` target + distinct count — Check B (the walk) needs them.
const params: TestParams = {
  resource: 'Property', keyField: 'ListingKey', keyValue: '1',
  enumMode: 'string', integerValueHigh: 0, skippedTypes: [], sampleComplete: true,
  timestampField: 'ModificationTimestamp', datetimeValue: '2024-01-01T00:00:00Z',
  datetimeValueMax: '2025-06-01T00:00:00Z', datetimeDistinctCount: 5
};

const runWith = (p: TestParams, requester: ODataRequester) => runPagingScenario('http://x', 'Property', p, 'tok', 0, requester);
const run = (requester: ODataRequester) => runWith(params, requester);

const topOneOk = response(200, [{ ListingKey: '1' }]); // $top=1: 200, no @odata.nextLink (Check A pass)

// Check A — the normative `$top=1` stop-signal criterion (web-api-core.md Server-Driven Paging).
describe('runPagingScenario — Check A: $top=1 stop signal', () => {
  it('$top=1 returns no @odata.nextLink → that check passes, and the $top=1 request is made', async () => {
    const { requester, calls } = recordingRequester([topOneOk, response(200, [{ ListingKey: 'a' }])]);
    const out = await run(requester);
    expect(calls[0].url).toContain('$top=1');
    expect(out.assertions.some(a => a.passed && a.message.includes('$top=1'))).toBe(true);
  });

  it('$top=1 wrongly returns an @odata.nextLink → fails, and the report shows the $top=1 URL (not the walk URL)', async () => {
    const { requester } = recordingRequester([
      response(200, [{ ListingKey: '1' }], 'http://x/Property?$skiptoken=2'), // $top=1 carries a nextLink
      response(200, [{ ListingKey: 'a' }]) // walk single page
    ]);
    const out = await run(requester);
    expect(out.passed).toBe(false);
    expect(out.assertions.some(a => !a.passed && a.message.includes('$top=1 MUST NOT return an @odata.nextLink'))).toBe(true);
    expect(out.requestUrl).toContain('$top=1');
    expect(out.requestUrl).not.toContain('$top=500');
  });

  it('$top=1 non-200 → fails and reports the $top=1 URL', async () => {
    const { requester } = recordingRequester([response(400), response(200, [{ ListingKey: 'a' }])]);
    const out = await run(requester);
    expect(out.passed).toBe(false);
    expect(out.assertions.some(a => !a.passed && a.message.includes('$top=1 request returned HTTP 400'))).toBe(true);
    expect(out.requestUrl).toContain('$top=1');
  });
});

// Check B — the forward server-driven-paging walk (cheat detection): a server must not merely suppress the
// nextLink on $top=1; it must actually page a real result set via @odata.nextLink and terminate.
describe('runPagingScenario — Check B: forward gt-walk (server-driven paging)', () => {
  it('builds the walk with a gt filter, $orderby, a $top=500 bound and Prefer odata.maxpagesize=100', async () => {
    const { requester, calls } = recordingRequester([
      topOneOk,
      response(200, [{ ListingKey: 'a' }], 'http://x/Property?$skiptoken=1'),
      response(200, [{ ListingKey: 'b' }])
    ]);
    await run(requester);
    const walk = calls[1]; // calls[0] is the $top=1 request; calls[1] is the walk's first page
    expect(walk.url).toContain('$filter=');
    expect(decodeURIComponent(walk.url)).toMatch(/ModificationTimestamp\s+gt\s+/i);
    expect(walk.url).toContain('$orderby');
    expect(walk.url).toContain('$top=500');
    expect(walk.headers?.Prefer ?? '').toContain('odata.maxpagesize=100');
  });

  it('pages cleanly across pages and terminates (final page has no nextLink) → passes', async () => {
    const { requester } = recordingRequester([
      topOneOk,
      response(200, [{ ListingKey: 'a' }], 'http://x/Property?$skiptoken=1'),
      response(200, [{ ListingKey: 'b' }], 'http://x/Property?$skiptoken=2'),
      response(200, [{ ListingKey: 'c' }])
    ]);
    const out = await run(requester);
    expect(out.passed).toBe(true);
  });

  it('a key repeats across pages → fails (overlap), and the report shows the walk URL', async () => {
    const { requester } = recordingRequester([
      topOneOk,
      response(200, [{ ListingKey: 'a' }], 'http://x/Property?$skiptoken=1'),
      response(200, [{ ListingKey: 'a' }]) // page 2 repeats 'a'
    ]);
    const out = await run(requester);
    expect(out.passed).toBe(false);
    expect(out.assertions.some(a => !a.passed && /repeat|overlap|duplicat/i.test(a.message))).toBe(true);
    expect(out.requestUrl).toContain('$top=500'); // Check B failure → surface the walk URL
  });

  it('a non-200 page mid-walk → fails', async () => {
    const { requester } = recordingRequester([
      topOneOk,
      response(200, [{ ListingKey: 'a' }], 'http://x/Property?$skiptoken=1'),
      response(500)
    ]);
    const out = await run(requester);
    expect(out.passed).toBe(false);
  });

  it('whole filtered set in one page with no nextLink → passes (nothing to page)', async () => {
    const { requester } = recordingRequester([topOneOk, response(200, [{ ListingKey: 'a' }, { ListingKey: 'b' }])]);
    const out = await run(requester);
    expect(out.passed).toBe(true);
  });

  it('no returning timestamp filter (distinct < 2) → walk is skipped; only the $top=1 request is made', async () => {
    const { requester, calls } = recordingRequester([topOneOk]);
    const out = await runWith({ ...params, datetimeDistinctCount: 1 }, requester);
    expect(calls.length).toBe(1); // only $top=1 — no walk attempted
    expect(out.passed).toBe(true); // Check A passed; Check B skipped, not failed
  });

  it('no timestamp field → walk is skipped; only the $top=1 request is made', async () => {
    const { requester, calls } = recordingRequester([topOneOk]);
    await runWith({ ...params, timestampField: undefined }, requester);
    expect(calls.length).toBe(1);
  });

  it('$top overrun: the server still offers a nextLink after the $top bound is reached → fails ($top §11.2.6.3)', async () => {
    // walkBound = 4 for the test: two pages of 2 reach the bound, but a nextLink is still offered → over-run.
    const { requester } = recordingRequester([
      topOneOk,
      response(200, [{ ListingKey: 'a' }, { ListingKey: 'b' }], 'http://x/Property?$skiptoken=1'),
      response(200, [{ ListingKey: 'c' }, { ListingKey: 'd' }], 'http://x/Property?$skiptoken=2'), // bound reached, still a nextLink
      response(200, [{ ListingKey: 'e' }])
    ]);
    const out = await runPagingScenario('http://x', 'Property', params, 'tok', 0, requester, 4);
    expect(out.passed).toBe(false);
    expect(out.assertions.some(a => !a.passed && /\$top|bound|exceed|greater than/i.test(a.message))).toBe(true);
  });

  it('a throttled server that keeps returning fresh nextLink pages is capped (does not hang) and passes', async () => {
    const pages = [topOneOk, ...Array.from({ length: 40 }, (_, i) => response(200, [{ ListingKey: `k${i}` }], `http://x/Property?$skiptoken=${i}`))];
    const { requester, calls } = recordingRequester(pages);
    const out = await run(requester);
    expect(out.passed).toBe(true);
    expect(calls.length).toBeLessThan(41); // capped — did not walk all 40 pages
  });

  it('OSN scoping: when originatingSystemName is set, the walk filter includes it', async () => {
    const { requester, calls } = recordingRequester([topOneOk, response(200, [{ ListingKey: 'a' }])]);
    await runWith({ ...params, originatingSystemName: 'MyOSN' }, requester);
    expect(decodeURIComponent(calls[1].url)).toContain('MyOSN');
  });
});
