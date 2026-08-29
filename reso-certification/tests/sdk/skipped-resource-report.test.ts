import { describe, expect, it } from 'vitest';
import { skippedResourceReport } from '../../src/sdk/core.js';

// A resource that can't be sampled/tested (e.g. a sampling network failure) must not be
// silently dropped by continue-on-error — it surfaces as a SKIPPED report. The tests
// couldn't run, so it is inconclusive, not a compliance failure.
describe('skippedResourceReport', () => {
  it('reports an untestable resource as skipped, not failed', () => {
    const report = skippedResourceReport('Media', new Error('sampling failed: ECONNRESET'));

    expect(report.resource).toBe('Media');
    // Counts as a skip, never a failure.
    expect(report.summary).toMatchObject({ total: 1, passed: 0, failed: 0, skipped: 1 });
    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0]?.skipped).toBe(true);
    expect(report.scenarios[0]?.passed).toBe(false);
    expect(report.scenarios[0]?.name).toContain('ECONNRESET');
    // A well-formed report the aggregators/formatters can consume.
    expect(report.params.resource).toBe('Media');
    expect(report.coverage).toEqual([]);
  });

  it('stringifies a non-Error thrown value', () => {
    const report = skippedResourceReport('Property', 'boom');
    expect(report.scenarios[0]?.name).toContain('boom');
    expect(report.summary.skipped).toBe(1);
  });
});
