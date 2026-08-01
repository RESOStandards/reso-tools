/**
 * Web API Core "Optional Tests" — deterministic contract.
 *
 * The verdict + outcome mechanics that the three adversarial lenses
 * (classification-matches-spec / verdict-integrity / outcome-semantics)
 * pair with. These are the machine-checkable invariants; the lenses carry
 * the judgment the tests can't (spec-fidelity, cross-path verdict integrity).
 */

import { describe, expect, it } from 'vitest';
import {
  summarizeScenarios,
  optionalOutcome,
  type ScenarioResult,
} from '../../src/web-api-core/test-runner.js';
import { allScenarios } from '../../src/web-api-core/scenarios.js';
import { buildScenarioQuery } from '../../src/web-api-core/queries.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';

const r = (over: Partial<ScenarioResult>): ScenarioResult => ({
  tag: 't',
  name: 'n',
  passed: true,
  skipped: false,
  assertions: [],
  duration: 0,
  ...over,
});

// ── outcome-semantics: the three optional labels ──
describe('optionalOutcome', () => {
  it('ran + passed → Passed', () => {
    expect(optionalOutcome(r({ passed: true, skipped: false }))).toBe('Passed');
  });
  it('ran + failed (determinate) → Not Supported', () => {
    expect(optionalOutcome(r({ passed: false, skipped: false }))).toBe('Not Supported');
  });
  it('skipped (no required-type data) → Not Tested', () => {
    expect(optionalOutcome(r({ passed: false, skipped: true }))).toBe('Not Tested');
  });
  it('errored / indeterminate → Not Tested, never Not Supported', () => {
    expect(optionalOutcome(r({ passed: false, skipped: false, errored: true }))).toBe('Not Tested');
  });
});

// ── verdict-integrity: optional never reaches summary.failed ──
describe('summarizeScenarios — verdict surface', () => {
  it('a required failure counts in failed', () => {
    expect(summarizeScenarios([r({ passed: false, skipped: false })]).failed).toBe(1);
  });
  it('an unmarked scenario defaults to required (counted)', () => {
    expect(summarizeScenarios([r({ passed: false })]).failed).toBe(1);
  });
  it('an optional failure NEVER counts in failed', () => {
    const s = summarizeScenarios([r({ passed: false, skipped: false, optional: true })]);
    expect(s.failed).toBe(0);
    expect(s.optional.notSupported).toBe(1);
  });
  it('required pass + optional fail → verdict-relevant failed is 0', () => {
    const s = summarizeScenarios([
      r({ passed: true }),
      r({ passed: false, optional: true }),
    ]);
    expect(s.failed).toBe(0);
    expect(s.passed).toBe(1);
    expect(s.optional.notSupported).toBe(1);
  });
  it('required fail + optional pass → failed is 1', () => {
    const s = summarizeScenarios([
      r({ passed: false }),
      r({ passed: true, optional: true }),
    ]);
    expect(s.failed).toBe(1);
    expect(s.optional.passed).toBe(1);
  });
  it('optional bucket tallies the three outcomes; required counts exclude optional', () => {
    const s = summarizeScenarios([
      r({ passed: true, optional: true }),
      r({ passed: false, skipped: false, optional: true }),
      r({ skipped: true, optional: true }),
    ]);
    expect(s.optional).toEqual({ passed: 1, notSupported: 1, notTested: 1 });
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.skipped).toBe(0);
  });
  it('total counts every result; required skipped is not a failure', () => {
    const s = summarizeScenarios([
      r({ passed: false, skipped: true }), // required, skipped
      r({ passed: false, optional: true }), // optional, failed
    ]);
    expect(s.total).toBe(2);
    expect(s.failed).toBe(0);
    expect(s.skipped).toBe(1);
  });
});

// ── classification-matches-spec: which scenarios are optional ──
describe('classification: string functions optional, Core required', () => {
  const byTag = (tag: string) => allScenarios.find((s) => s.tag === tag);

  it('contains / startswith / endswith are optional', () => {
    for (const tag of ['filter-string-contains', 'filter-string-startswith', 'filter-string-endswith']) {
      expect(byTag(tag)?.optional).toBe(true);
    }
  });

  it('Core / RCP-039 scenarios are NOT optional', () => {
    for (const tag of ['filter-string-enum-single-in', 'lookup-resource-validation', 'metadata-validation', 'filter-int-eq']) {
      expect(byTag(tag)?.optional).toBeFalsy();
    }
  });

  it('only string-function scenarios carry optional', () => {
    for (const s of allScenarios) {
      if (s.optional) expect(s.category).toBe('string-function');
    }
  });
});

// ── query builder restored ──
describe('query builder: string-function scenarios produce the right $filter', () => {
  const params: TestParams = {
    resource: 'Property',
    keyField: 'ListingKey',
    keyValue: 'ABC123',
    integerField: 'ListPrice',
    integerValueLow: 200000,
    integerValueHigh: 2147483647,
    decimalField: 'Latitude',
    decimalValueLow: 40.7,
    decimalValueHigh: 40.7,
    dateField: 'ListDate',
    dateValue: '2024-06-15',
    timestampField: 'ModificationTimestamp',
    datetimeValue: '2024-06-15T10:30:00Z',
    singleLookupField: 'StandardStatus',
    singleLookupValue: 'Active',
    multiLookupField: 'AccessibilityFeatures',
    multiLookupValue1: 'Pool',
    multiLookupValue2: 'Garage',
    stringField: 'City',
    stringValue: 'Dallas',
    sampleComplete: true,
    skippedTypes: [],
  };
  const byTag = (tag: string) => allScenarios.find((s) => s.tag === tag)!;

  it.each([
    ['filter-string-contains', "contains(City,'Dallas')"],
    ['filter-string-startswith', "startswith(City,'Dallas')"],
    ['filter-string-endswith', "endswith(City,'Dallas')"],
  ])('%s → %s', (tag, expectedFilter) => {
    const q = buildScenarioQuery('http://x', 'Property', byTag(tag), params);
    expect(q).toBeDefined();
    expect(decodeURIComponent(q!.url)).toContain(expectedFilter);
  });
});
