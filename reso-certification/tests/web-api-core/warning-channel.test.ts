import { describe, expect, it } from 'vitest';
import type { EnumCandidate } from '../../src/web-api-core/enum-selection.js';
import type { CoreScenario } from '../../src/web-api-core/scenarios.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import { runEnumFamilyScenario, summarizeScenarios } from '../../src/web-api-core/test-runner.js';
import type { ScenarioResult } from '../../src/web-api-core/test-runner.js';

// The non-gating WARNING channel: warnings ride ScenarioResult.warnings, are counted verdict-neutrally by
// summarizeScenarios, and (its first consumer) the single-enum `ne` value-violation surfaces as a warning — a PASS
// with a warning, never a failure — pending WG sign-off. Same channel later carries Fast Track / DD 3.0 suggestions.

const r = (over: Partial<ScenarioResult>): ScenarioResult => ({
  tag: 't', name: 'n', passed: true, skipped: false, assertions: [], duration: 0, ...over,
});

describe('summarizeScenarios — warnings are counted, verdict-neutral', () => {
  it('sums warnings across results and NEVER folds them into failed', () => {
    const s = summarizeScenarios([
      r({ passed: true, warnings: ['w1', 'w2'] }), // a passed scenario that also warns
      r({ passed: true }),
      r({ passed: false }), // a real failure
    ]);
    expect(s.warnings).toBe(2);
    expect(s.passed).toBe(2); // the warning-carrying result still counts as passed
    expect(s.failed).toBe(1); // warnings did NOT inflate failed
  });

  it('is 0 warnings when none are present', () => {
    expect(summarizeScenarios([r({ passed: true }), r({ passed: true })]).warnings).toBe(0);
  });
});

const singleEnumCand = (field: string, value: string): EnumCandidate => ({
  field, representation: 'SINGLE_ENUM', isStandard: true, values: [value], lookupSampleValues: [value], distinctValueCount: 2, fillRate: 1,
});

const paramsWithSingleEnum = (cand: EnumCandidate): TestParams => ({
  resource: 'Property', keyField: 'ListingKey', keyValue: '1', enumMode: 'string', integerValueHigh: 0,
  skippedTypes: [], sampleComplete: true, singleLookupField: cand.field, singleLookupValue: cand.values[0], singleLookupCandidates: [cand],
});

const neScenario: CoreScenario = { tag: 'filter-enum-ne', name: 'Single enum: ne', category: 'enum', enumType: 'single', op: 'ne', fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.0.0' } as CoreScenario;

const respondWith = (records: ReadonlyArray<Record<string, unknown>>): ODataRequester => ({
  request: async (): Promise<ODataResponse> => ({ status: 200, headers: { 'odata-version': '4.01' }, body: { value: records }, rawBody: '' }),
});

describe('single-enum `ne` — a value violation WARNS, never fails (pending WG)', () => {
  it('a server that returns the EXCLUDED value → PASS + a warning (not a failure)', async () => {
    // Query is `StandardStatus ne 'Active'`; the broken server wrongly returns an 'Active' record.
    const req = respondWith([{ StandardStatus: 'Closed' }, { StandardStatus: 'Active' }]);
    const result = await runEnumFamilyScenario('http://x', 'Property', neScenario, paramsWithSingleEnum(singleEnumCand('StandardStatus', 'Active')), 'tok', 0, 'ne', req);
    expect(result.passed).toBe(true); // NON-gating — the violation does not fail the provider
    expect(result.skipped).toBe(false);
    expect(result.warnings?.some((w) => w.includes('ne') && w.toLowerCase().includes('warning'))).toBe(true);
  });

  it('a conformant server (no excluded value) → PASS, no warning', async () => {
    const req = respondWith([{ StandardStatus: 'Closed' }, { StandardStatus: 'Pending' }]);
    const result = await runEnumFamilyScenario('http://x', 'Property', neScenario, paramsWithSingleEnum(singleEnumCand('StandardStatus', 'Active')), 'tok', 0, 'ne', req);
    expect(result.passed).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
