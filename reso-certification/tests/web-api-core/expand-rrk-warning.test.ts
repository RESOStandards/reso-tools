import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import type { ExpandScenario } from '../../src/web-api-core/scenarios.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import {
  executeStandardScenario,
  expandRrkWarnings,
  summarizeScenarios,
  type ScenarioResult,
} from '../../src/web-api-core/test-runner.js';
import { coreVerdict } from '../../src/sdk/core.js';

// The WG rule (transport#22 / RCP-039): an expanded child's ResourceRecordKey should equal the primary key of
// the parent record it was expanded into (e.g. an expanded Media's ResourceRecordKey == the parent Property's
// ListingKey). A mismatch is a NON-GATING warning — it must never fail a compliant server.

const expandScenario: ExpandScenario = {
  tag: 'expand',
  name: '$expand navigation property',
  category: 'expand',
  fieldParam: 'expandField',
  minVersion: '2.1.0',
};

// Parent = Property (ListingKey), expanded nav property = Media.
const params: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: 'P1',
  enumMode: 'string',
  expandField: 'Media',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
};

// One parent Property whose expanded Media collection is exactly `children`.
const parent = (children: unknown): Record<string, unknown> => ({ ListingKey: 'P1', Media: children });

describe('expandRrkWarnings (unit — the RRK expanded-item rule)', () => {
  it('mismatch → one warning that NAMES the offending ResourceRecordKey and the parent key', () => {
    const warnings = expandRrkWarnings([parent([{ MediaKey: 'M1', ResourceRecordKey: 'WRONG' }])], expandScenario, params);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('WRONG'); // the offender
    expect(warnings[0]).toContain('ListingKey'); // the parent key field
    expect(warnings[0]).toContain('P1'); // the parent key value it should have matched
    expect(warnings[0]).toContain('Media'); // the expanded nav property
  });

  it('match → no warning', () => {
    const warnings = expandRrkWarnings([parent([{ MediaKey: 'M1', ResourceRecordKey: 'P1' }])], expandScenario, params);
    expect(warnings).toEqual([]);
  });

  it('no expanded children (nav property absent) → no warning, no crash', () => {
    expect(expandRrkWarnings([{ ListingKey: 'P1' }], expandScenario, params)).toEqual([]);
  });

  it('empty expanded array → no warning', () => {
    expect(expandRrkWarnings([parent([])], expandScenario, params)).toEqual([]);
  });

  it('expanded value is not an array (single object) → no warning', () => {
    expect(expandRrkWarnings([parent({ ResourceRecordKey: 'WRONG' })], expandScenario, params)).toEqual([]);
  });

  it('expanded value is a scalar (not an array) → no warning', () => {
    expect(expandRrkWarnings([parent('nope' as unknown)], expandScenario, params)).toEqual([]);
  });

  it('child has no ResourceRecordKey → no warning (absence is a different concern, out of scope)', () => {
    expect(expandRrkWarnings([parent([{ MediaKey: 'M1' }])], expandScenario, params)).toEqual([]);
  });

  it('parent has no primary-key value → no warning (nothing to compare against)', () => {
    expect(expandRrkWarnings([{ Media: [{ ResourceRecordKey: 'WRONG' }] }], expandScenario, params)).toEqual([]);
  });

  it('multiple children, only one mismatched → exactly one warning naming that offender', () => {
    const children = [
      { MediaKey: 'M1', ResourceRecordKey: 'P1' }, // match
      { MediaKey: 'M2', ResourceRecordKey: 'OFFENDER' }, // mismatch
      { MediaKey: 'M3' }, // no RRK — out of scope
      { MediaKey: 'M4', ResourceRecordKey: 'P1' }, // match
    ];
    const warnings = expandRrkWarnings([parent(children)], expandScenario, params);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OFFENDER');
  });

  it('returns [] when the expand field cannot resolve (no expandField param)', () => {
    const noExpand: TestParams = {
      resource: 'Property',
      keyField: 'ListingKey',
      keyValue: 'P1',
      enumMode: 'string',
      integerValueHigh: 0,
      skippedTypes: [],
      sampleComplete: true,
    };
    expect(expandRrkWarnings([parent([{ ResourceRecordKey: 'WRONG' }])], expandScenario, noExpand)).toEqual([]);
  });
});

// ── The non-gating proof, end-to-end through executeStandardScenario ──

const response = (children: unknown): ODataResponse => ({
  status: 200,
  headers: { 'odata-version': '4.01' },
  body: { value: [parent(children)] },
  rawBody: JSON.stringify({ value: [parent(children)] }),
});

const scriptedRequester = (res: ODataResponse): ODataRequester => ({ request: async () => res });

const runExpand = (children: unknown): Promise<{ readonly result: ScenarioResult }> =>
  executeStandardScenario('http://x', 'Property', expandScenario, params, 'tok', 0, scriptedRequester(response(children)));

describe('$expand RRK warning is NON-GATING (does not change passed / failed / verdict)', () => {
  it('mismatch → scenario STILL passes, warning rides alongside on ScenarioResult.warnings', async () => {
    const { result } = await runExpand([{ MediaKey: 'M1', ResourceRecordKey: 'WRONG' }]);
    expect(result.passed).toBe(true); // expansion worked — the scenario passes
    expect(result.skipped).toBe(false);
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toContain('WRONG');
    // The warning never entered the assertions (the pass/fail surface).
    expect(result.assertions.every(a => a.passed)).toBe(true);
  });

  it('match → scenario passes with NO warnings field emitted', async () => {
    const { result } = await runExpand([{ MediaKey: 'M1', ResourceRecordKey: 'P1' }]);
    expect(result.passed).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it('THE PROOF: a warning changes neither the failed count nor the verdict vs. a clean match', async () => {
    const mismatch = (await runExpand([{ MediaKey: 'M1', ResourceRecordKey: 'WRONG' }])).result;
    const clean = (await runExpand([{ MediaKey: 'M1', ResourceRecordKey: 'P1' }])).result;

    const mismatchSummary = summarizeScenarios([mismatch]);
    const cleanSummary = summarizeScenarios([clean]);

    // The verdict surface (passed/failed/skipped) is IDENTICAL — the only difference is the advisory warning.
    expect(mismatchSummary).toEqual(cleanSummary);
    expect(mismatchSummary.failed).toBe(0);
    expect(mismatchSummary.passed).toBe(1);

    // And the run verdict derived from those counts is `passed` in BOTH cases — the warning is inert to it.
    const verdictArgs = (failed: number) => ({ totalFailed: failed, coverageFailed: false, deadlineReached: false });
    expect(coreVerdict(verdictArgs(mismatchSummary.failed))).toBe('passed');
    expect(coreVerdict(verdictArgs(cleanSummary.failed))).toBe('passed');
  });
});
