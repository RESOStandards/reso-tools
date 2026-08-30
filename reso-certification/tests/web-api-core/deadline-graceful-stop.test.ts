import { isDeadlineError } from '@reso-standards/reso-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';

// The metadata scenario fetches through a separate path (fetchMetadataWithVersion), not the
// requester seam. Mock it to succeed so this test isolates the deadline behavior on the
// requester-driven scenarios.
vi.mock('../../src/test-runner/metadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/test-runner/metadata.js')>();
  return {
    ...actual,
    fetchMetadataWithVersion: vi.fn(async () => ({ xml: '<edmx:Edmx></edmx:Edmx>', odataVersion: '4.01' }))
  };
});

import { runCoreResourceScenarios } from '../../src/web-api-core/test-runner.js';

const params: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerField: 'BedroomsTotal',
  integerValueHigh: 3,
  integerValueLow: 1,
  integerValueMin: 1,
  integerValueMax: 5,
  integerNotSentinel: -1,
  skippedTypes: [],
  sampleComplete: true
};

const DEADLINE_MSG = 'Not tested — run deadline reached';

/** Build the deadline-exceeded error the resilient client throws once the run budget is spent. */
const deadlineError = (): Error =>
  Object.assign(new Error('Total run timeout exceeded'), { resilienceKind: 'deadline-exceeded' as const });

/** A requester that serves `okCount` requests, then throws deadline-exceeded on every call after. */
const deadlineAfter = (okCount: number): ODataRequester => {
  const calls: string[] = []; // closure-local counter (const binding, mutated via push)
  return {
    request: async (options) => {
      calls.push(options.url);
      if (calls.length > okCount) throw deadlineError();
      return {
        status: 200,
        headers: { 'odata-version': '4.01' },
        body: { value: [{ ListingKey: '1', BedroomsTotal: 3 }], '@odata.count': 1 },
        rawBody: ''
      };
    }
  };
};

/** A requester that always succeeds — the no-deadline baseline. */
const okRequester = (): ODataRequester => deadlineAfter(Number.POSITIVE_INFINITY);

describe('runCoreResourceScenarios — graceful stop on the run deadline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sanity: the constructed deadline error is what the SDK recognizes (non-vacuity guard)', () => {
    expect(isDeadlineError(deadlineError())).toBe(true);
    expect(isDeadlineError(new Error('ordinary failure'))).toBe(false);
  });

  it('stops at the deadline: remaining scenarios are NOT TESTED (skipped), never failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected real network call'));

    // Baseline: the same resource with every request succeeding (no deadline).
    const full = await runCoreResourceScenarios('http://server', 'Property', params, 'tok', '2.0.0', okRequester());
    // Cut short: the run budget is spent after the third request.
    const cut = await runCoreResourceScenarios('http://server', 'Property', params, 'tok', '2.0.0', deadlineAfter(3));

    expect(cut.deadlineReached).toBe(true);
    expect(full.deadlineReached).toBeUndefined();

    // Some scenarios ran before the budget was spent (a genuine partial report).
    expect(cut.scenarios.filter(s => !s.skipped).length).toBeGreaterThan(0);

    // Every deadline-affected scenario is SKIPPED with the deadline reason, never failed.
    const deadlineScenarios = cut.scenarios.filter(s => s.assertions.some(a => a.message === DEADLINE_MSG));
    expect(deadlineScenarios.length).toBeGreaterThan(0);
    for (const s of deadlineScenarios) {
      expect(s.skipped).toBe(true);
      expect(s.passed).toBe(true); // a skip never counts as a failure
    }

    // THE CORE GUARANTEE, stated non-vacuously against a swallow-as-failed regression: a deadline can
    // only turn a would-be-tested scenario into a SKIP, never a failure — so the cut run has no MORE
    // failures than the full run, and strictly more skips. If the deadline were recorded as a failed
    // (or errored) scenario instead, cut.summary.failed would exceed the baseline and this would fail.
    expect(cut.summary.failed).toBeLessThanOrEqual(full.summary.failed);
    expect(cut.summary.skipped).toBeGreaterThan(full.summary.skipped);
  });

  it('marks (almost) everything not-tested when the budget is already spent at the first request', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected real network call'));

    // Metadata is mocked (no requester call), so the first requester call is the first data scenario.
    const report = await runCoreResourceScenarios('http://server', 'Property', params, 'tok', '2.0.0', deadlineAfter(0));

    expect(report.deadlineReached).toBe(true);
    // No REQUIRED scenario is a genuine failure — the (mocked) metadata passes, the rest is not-tested.
    const genuineRequiredFailures = report.scenarios.filter(s => !s.passed && !s.skipped && !s.optional);
    expect(genuineRequiredFailures).toEqual([]);
  });
});
