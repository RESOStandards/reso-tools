import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';

/**
 * #315: the missing-`ModificationTimestamp` warning must reach the REPORT, not just sit on TestParams.
 *
 * This test exists because the first wiring of it did not: `resolveTestParams` computed the warning and nothing
 * consumed it, and severing the call site in `runCoreResourceScenarios` broke no test in the suite. A warning that
 * is computed but never surfaced is indistinguishable from no warning at all, so the seam gets its own guard.
 */

// The metadata scenario fetches outside the requester seam; mock it, as the container test does.
vi.mock('../../src/test-runner/metadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/test-runner/metadata.js')>();
  return {
    ...actual,
    fetchMetadataWithVersion: vi.fn(async () => ({ xml: '<edmx:Edmx></edmx:Edmx>', odataVersion: '4.01' })),
  };
});

import { runCoreResourceScenarios } from '../../src/web-api-core/test-runner.js';

const WARNING = "Property does not declare it for 'ModificationTimestamp' — grounded the timestamp scenarios on 'OriginalEntryTimestamp' instead.";

// A resource certified on a substitute timestamp field: `timestampField` is populated so the datetime scenarios run,
// and `timestampWarning` is the note sampling produced.
const paramsWith = (timestampWarning?: string): TestParams => ({
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 3,
  timestampField: 'OriginalEntryTimestamp',
  timestampFieldForNow: 'OriginalEntryTimestamp',
  datetimeValue: '2026-01-01T00:00:00Z',
  datetimeValueMax: '2026-02-01T00:00:00Z',
  datetimeDistinctCount: 2,
  skippedTypes: [],
  sampleComplete: true,
  ...(timestampWarning !== undefined && { timestampWarning }),
});

const okRequester = (): ODataRequester => ({
  request: async () => ({
    status: 200,
    headers: { 'odata-version': '4.01' },
    body: { value: [{ ListingKey: '1', OriginalEntryTimestamp: '2026-01-01T00:00:00Z' }], '@odata.count': 1 },
    rawBody: '',
  }),
});

const run = (timestampWarning?: string) =>
  runCoreResourceScenarios('http://server', 'Property', paramsWith(timestampWarning), 'tok', '2.1.0', okRequester());

describe('the missing-ModificationTimestamp warning reaches the report (#315)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('surfaces exactly once across the whole resource report', async () => {
    const report = await run(WARNING);
    const carrying = report.scenarios.filter(s => (s.warnings ?? []).includes(WARNING));
    expect(carrying).toHaveLength(1);
  });

  it('rides a scenario that actually ran on the timestamp field', async () => {
    const report = await run(WARNING);
    const carrying = report.scenarios.find(s => (s.warnings ?? []).includes(WARNING));
    expect(carrying?.tag).toMatch(/datetime|timestamp/);
  });

  it('is counted by the summary, and counted as a WARNING not a failure', async () => {
    const withW = await run(WARNING);
    const without = await run(undefined);
    expect((withW.summary.warnings ?? 0) - (without.summary.warnings ?? 0)).toBe(1);
    expect(withW.summary.failed).toBe(without.summary.failed);
    expect(withW.summary.passed).toBe(without.summary.passed);
  });

  it('is absent from every scenario when the resource HAS a usable ModificationTimestamp', async () => {
    const report = await run(undefined);
    for (const s of report.scenarios) {
      expect((s.warnings ?? []).some(w => w.includes('ModificationTimestamp'))).toBe(false);
    }
  });
});
