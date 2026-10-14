import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { EntityType, ODataResponse } from '../../src/test-runner/types.js';
import { resolveTestParams } from '../../src/web-api-core/sampling.js';
import type { StandardMap } from '../../src/web-api-core/standard-map.js';

/**
 * Sampling pages to the 1000-record target instead of keeping whatever the first `$top=1000` returned
 * (Josh, 2026-10-03: "if we can page we need to sample up to 1000"). The motivation is selection quality:
 * field ranking filters to the standard elements and then ranks on fill rate within the sample, so a provider
 * whose page size caps below the target silently degraded both the ranking and the type coverage.
 *
 * Two invariants carry the most weight here:
 *
 *   - `sampleComplete` must never be TRUE unless the sample provably IS the whole resource, because it drives
 *     the `ne`/`gt`/`lt` empty-verdict's pass-vs-skip split. A full sample with no forward link means the
 *     `$top` window was satisfied, NOT that the resource ran out.
 *   - `@odata.count` is never consulted. Providers' counts are frequently wrong, so the only trusted stopping
 *     conditions are our own record tally and the absence of a forward link.
 */

const SAMPLE_TOP = 1000;

const noopStandardMap: StandardMap = {
  isStandardField: () => false,
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
  standardValuesForField: () => undefined,
  isClosedEnumField: () => false
};

const entityType: EntityType = {
  name: 'Property',
  keyProperties: ['ListingKey'],
  properties: [
    { name: 'ListingKey', type: 'Edm.String' },
    { name: 'ListPrice', type: 'Edm.Int64' }
  ]
};

const records = (n: number, from = 0): ReadonlyArray<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ ListingKey: `P${from + i}`, ListPrice: 100 + from + i }));

const page = (
  recs: ReadonlyArray<Record<string, unknown>>,
  opts: { readonly next?: string; readonly status?: number; readonly count?: number } = {}
): ODataResponse => ({
  status: opts.status ?? 200,
  headers: { 'odata-version': '4.01' },
  body: {
    value: recs,
    ...(opts.next !== undefined ? { '@odata.nextLink': opts.next } : {}),
    ...(opts.count !== undefined ? { '@odata.count': opts.count } : {})
  },
  rawBody: '{}'
});

/** Replays a scripted sequence of pages, recording each requested URL and the headers it carried. */
interface Call {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}
const scripted = (pages: ReadonlyArray<ODataResponse | Error>, calls: Call[]): ODataRequester => ({
  request: async ({ url, headers }) => {
    calls.push({ url, ...(headers ? { headers } : {}) });
    const next = pages[calls.length - 1];
    if (next === undefined) throw new Error(`unscripted request #${calls.length}: ${url}`);
    if (next instanceof Error) throw next;
    return next;
  }
});

const sample = (pages: ReadonlyArray<ODataResponse | Error>, calls: Call[] = []) =>
  resolveTestParams('http://x', 'Property', entityType, 'tok', [], noopStandardMap, undefined, scripted(pages, calls));

describe('sampling pages to the record target', () => {
  it('keeps paging until the target is met, and trims an over-long final page', async () => {
    const calls: Call[] = [];
    const params = await sample(
      [
        page(records(400, 0), { next: 'http://x/Property?$skiptoken=a' }),
        page(records(400, 400), { next: 'http://x/Property?$skiptoken=b' }),
        page(records(400, 800), { next: 'http://x/Property?$skiptoken=c' })
      ],
      calls
    );
    expect(calls).toHaveLength(3);
    expect(params.sampleRecordCount).toBe(SAMPLE_TOP);
    expect(params.samplePagesFetched).toBe(3);
    expect(params.sampleStopReason).toBe('reached-target');
    // More records may exist beyond the target, so this is NOT the complete resource.
    expect(params.sampleComplete).toBe(false);
  });

  it('stops when the server runs out of pages, and calls that the complete resource', async () => {
    const params = await sample([page(records(100, 0), { next: 'http://x/Property?$skiptoken=a' }), page(records(50, 100))]);
    expect(params.sampleRecordCount).toBe(150);
    expect(params.samplePagesFetched).toBe(2);
    expect(params.sampleStopReason).toBe('exhausted');
    expect(params.sampleComplete).toBe(true);
  });

  it('is a single request when the first page already exhausts the resource', async () => {
    const calls: Call[] = [];
    const params = await sample([page(records(1))], calls);
    expect(calls).toHaveLength(1);
    expect(params.samplePagesFetched).toBe(1);
    expect(params.sampleStopReason).toBe('exhausted');
    expect(params.sampleComplete).toBe(true);
  });

  it('does NOT call a full sample complete even with no forward link', async () => {
    // The $top window was satisfied, which is not evidence the resource ran out. Getting this wrong would let
    // a `ne` false-PASS through, so it is the sharpest edge in the change.
    const params = await sample([page(records(SAMPLE_TOP))]);
    expect(params.sampleRecordCount).toBe(SAMPLE_TOP);
    expect(params.sampleStopReason).toBe('reached-target');
    expect(params.sampleComplete).toBe(false);
  });
});

describe('sampling stops safely when paging cannot continue', () => {
  it('treats a non-200 FIRST page as an error, never as an exhausted resource', async () => {
    // The sharp one, and the half that was missing. reso-client does not throw on a non-200, so a 500
    // arrives as an ordinary value whose body carries no `value` and no forward link. Read literally that is
    // indistinguishable from an empty resource, and reporting it as `exhausted` + `complete` fails a REQUIRED
    // resource while the report asserts the resource is genuinely empty, which blames the provider for our
    // own failed request.
    const params = await sample([page([], { status: 500 })]);
    expect(params.sampleStopReason).toBe('page-error');
    expect(params.sampleComplete).toBe(false);
    expect(params.sampleRecordCount).toBe(0);
  });

  it('does so for every non-200, not just a 500', async () => {
    // An expired token (401) and a forbidden resource (403) take the same path, and all three previously
    // produced an identical false "complete".
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const params = await sample([page([], { status })]);
      expect(params.sampleStopReason).toBe('page-error');
      expect(params.sampleComplete).toBe(false);
    }
  });

  it('gives the first page the same gate as every later page', async () => {
    // The defect was an ASYMMETRY: pages 2..N were gated and page 1 was not. This pins the symmetry rather
    // than the instance, so re-introducing the gap on either side fails here.
    const onFirst = await sample([page([], { status: 500 })]);
    const onSecond = await sample([page(records(10), { next: 'http://x/Property?$skiptoken=a' }), page([], { status: 500 })]);
    expect(onFirst.sampleStopReason).toBe(onSecond.sampleStopReason);
    expect(onFirst.sampleComplete).toBe(onSecond.sampleComplete);
  });

  it('keeps the records already in hand when a page request throws', async () => {
    const params = await sample([page(records(200), { next: 'http://x/Property?$skiptoken=a' }), new Error('socket hang up')]);
    expect(params.sampleRecordCount).toBe(200);
    expect(params.sampleStopReason).toBe('page-error');
    expect(params.sampleComplete).toBe(false);
  });

  it('keeps the records already in hand when a page answers non-200', async () => {
    const params = await sample([page(records(200), { next: 'http://x/Property?$skiptoken=a' }), page([], { status: 500 })]);
    expect(params.sampleRecordCount).toBe(200);
    expect(params.sampleStopReason).toBe('page-error');
  });

  it('does not spin when a page carries a forward link but no records', async () => {
    const calls: Call[] = [];
    const params = await sample(
      [page(records(10), { next: 'http://x/Property?$skiptoken=a' }), page([], { next: 'http://x/Property?$skiptoken=b' })],
      calls
    );
    expect(calls).toHaveLength(2); // stopped rather than following the link again
    expect(params.sampleRecordCount).toBe(10);
    expect(params.sampleStopReason).toBe('empty-page');
    expect(params.sampleComplete).toBe(false);
  });

  it('propagates a run-deadline error instead of swallowing it as a page error', async () => {
    // A deadline means the whole run is out of budget, so it must stop the run, not just this resource's paging.
    // The real marker shape: a plain Error carrying `resilienceKind` (reso-client's `resilienceError` factory —
    // this codebase uses marker fields, not Error subclasses). A fake shape would make this test pass while the
    // guard did nothing, which is the failure mode worth avoiding in a test OF a guard.
    const deadline = Object.assign(new Error('deadline exceeded'), { resilienceKind: 'deadline-exceeded' });
    await expect(sample([page(records(10), { next: 'http://x/Property?$skiptoken=a' }), deadline])).rejects.toThrow();
  });
});

describe('sampling request shape', () => {
  it('asks for a large page on the first request AND on every page request', async () => {
    const calls: Call[] = [];
    await sample([page(records(400), { next: 'http://x/Property?$skiptoken=a' }), page(records(10, 400))], calls);
    for (const call of calls) {
      expect(call.headers?.Prefer).toBe(`odata.maxpagesize=${SAMPLE_TOP}`);
    }
  });

  it('re-bases a forward link onto the origin we actually queried', async () => {
    // A provider behind a proxy emits an internal host in its nextLink; following it blindly would fail a
    // conformant server. Covered by rebaseNextLink, asserted here so the sampler keeps using it.
    const calls: Call[] = [];
    await sample([page(records(400), { next: 'http://internal-host:9000/Property?$skiptoken=a' }), page(records(10, 400))], calls);
    expect(calls[1].url).toBe('http://x/Property?$skiptoken=a');
  });

  it('ignores @odata.count entirely, because providers report it wrong', async () => {
    // A count that disagrees with reality must change nothing: the tally and the forward link are the only
    // trusted signals. Here the server claims a million records but serves 5 and stops.
    const params = await sample([page(records(5), { count: 1_000_000 })]);
    expect(params.sampleRecordCount).toBe(5);
    expect(params.sampleStopReason).toBe('exhausted');
    expect(params.sampleComplete).toBe(true);
  });
});
