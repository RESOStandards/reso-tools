import { describe, expect, it } from 'vitest';
import type { EnumCandidate } from '../../src/web-api-core/enum-selection.js';
import type { CollectionScenario, EnumScenario, StringEnumScenario } from '../../src/web-api-core/scenarios.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import { buildScenarioQuery, recordDerivedSet } from '../../src/web-api-core/queries.js';
import { runEnumFamilyScenario } from '../../src/web-api-core/test-runner.js';

// #3 — RECORD-DERIVED all() / has-and value sets. A guaranteed-match filter built over ONE real record's own
// collection (all(x: x eq v1 or … or vn) — the record's members ⊆ the set) turns an otherwise skip-on-empty
// all()/has-and into a determinate check: the guaranteeing record MUST come back (empty → fail), and any record
// that comes back MUST sit inside the set (out-of-set element → fail). No subset → prior behavior (skip on empty).

const collAll: CollectionScenario = { tag: 'filter-coll-enum-all', name: 'Collection: all()', category: 'collection', lambda: 'all', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', minVersion: '2.0.0' };
const collAny: CollectionScenario = { tag: 'filter-coll-enum-any', name: 'Collection: any()', category: 'collection', lambda: 'any', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', minVersion: '2.0.0' };
const strAll: StringEnumScenario = { tag: 'filter-string-enum-multi-all', name: 'String enum collection: all()', category: 'string-enum', enumType: 'multi', op: 'all', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', valueParam2: 'multiLookupValue2', minVersion: '2.1.0' };
const hasAnd: EnumScenario = { tag: 'filter-enum-multi-has-and', name: 'Multi enum: has + and', category: 'enum', enumType: 'multi', op: 'has', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', valueParam2: 'multiLookupValue2', minVersion: '2.0.0' };

const collEnumCand = (subset?: ReadonlyArray<string>): EnumCandidate => ({
  field: 'ExteriorFeatures', representation: 'COLLECTION_ENUM', isStandard: true,
  values: ['Barbecue', 'Garden'], lookupSampleValues: ['Barbecue', 'Garden'], distinctValueCount: 4, fillRate: 1,
  ...(subset && { subsetSampleValues: subset }),
});

const collStringCand = (subset?: ReadonlyArray<string>): EnumCandidate => ({
  field: 'Appliances', representation: 'COLLECTION_STRING', isStandard: true,
  values: ['Dishwasher', 'Dryer'], lookupSampleValues: ['Dishwasher', 'Dryer'], distinctValueCount: 4, fillRate: 1,
  ...(subset && { subsetSampleValues: subset }),
});

const params = (cand: EnumCandidate): TestParams => ({
  resource: 'Property', keyField: 'ListingKey', keyValue: '1', enumMode: 'string', integerValueHigh: 0,
  skippedTypes: [], sampleComplete: true, multiLookupField: cand.field, multiLookupValue1: cand.values[0],
  multiLookupValue2: cand.values[1], multiLookupFieldRep: cand.representation,
  ...(cand.subsetSampleValues && { multiLookupSubsetValues: cand.subsetSampleValues }),
  multiLookupCandidates: [cand],
});

const filterOf = (url: string | undefined): string =>
  decodeURIComponent(new URL(url ?? 'http://x/').searchParams.get('$filter') ?? '');

// ── recordDerivedSet (the single source of truth) ──

describe('recordDerivedSet — which operators consume the record-derived set', () => {
  const withSubset = { multiLookupSubsetValues: ['A', 'B', 'C'] } as unknown as TestParams;
  it('collection all() → the full subset; any() → undefined (already fail-on-empty)', () => {
    expect(recordDerivedSet(collAll, withSubset)).toEqual(['A', 'B', 'C']);
    expect(recordDerivedSet(collAny, withSubset)).toBeUndefined();
  });
  it('string-enum all() → the full subset', () => {
    expect(recordDerivedSet(strAll, withSubset)).toEqual(['A', 'B', 'C']);
  });
  it('enum has-and → the first TWO co-present members (has A and has B); single has → undefined', () => {
    expect(recordDerivedSet(hasAnd, withSubset)).toEqual(['A', 'B']);
    const singleHas = { ...hasAnd, valueParam2: undefined } as EnumScenario;
    expect(recordDerivedSet(singleHas, withSubset)).toBeUndefined();
  });
  it('has-and with a subset of ONE → undefined (can’t prove two flags co-present)', () => {
    expect(recordDerivedSet(hasAnd, { multiLookupSubsetValues: ['A'] } as unknown as TestParams)).toBeUndefined();
  });
  it('no subset on params → undefined for every operator', () => {
    for (const s of [collAll, strAll, hasAnd]) expect(recordDerivedSet(s, {} as TestParams)).toBeUndefined();
  });
});

// ── query building ──

describe('query builders — all() / has-and over the record-derived set', () => {
  it('collection all() builds a disjunction over the WHOLE record collection', () => {
    const q = buildScenarioQuery('http://x', 'Property', collAll, params(collEnumCand(['Barbecue', 'Garden'])));
    expect(filterOf(q?.url)).toBe("ExteriorFeatures/all(x:x eq 'Barbecue' or x eq 'Garden')");
  });
  it('collection all() with NO subset falls back to the single sampled value', () => {
    expect(filterOf(buildScenarioQuery('http://x', 'Property', collAll, params(collEnumCand()))?.url))
      .toBe("ExteriorFeatures/all(x:x eq 'Barbecue')");
  });
  it('collection any() ignores the subset (single value — any() is already guaranteed-match)', () => {
    expect(filterOf(buildScenarioQuery('http://x', 'Property', collAny, params(collEnumCand(['Barbecue', 'Garden'])))?.url))
      .toBe("ExteriorFeatures/any(x:x eq 'Barbecue')");
  });
  it('string-enum all() builds a disjunction over the whole record collection', () => {
    expect(filterOf(buildScenarioQuery('http://x', 'Property', strAll, params(collStringCand(['Dishwasher', 'Dryer'])))?.url))
      .toBe("Appliances/all(x:x eq 'Dishwasher' or x eq 'Dryer')");
  });
  it('enum has-and builds `has A and has B` over two co-present members', () => {
    const flagsCand: EnumCandidate = { field: 'AccessibilityFeatures', representation: 'FLAGS_ENUM', isStandard: true, values: ['AccessibleBedroom', 'AccessibleApproachWithRamp'], lookupSampleValues: [], distinctValueCount: 3, fillRate: 1, subsetSampleValues: ['AccessibleApproachWithRamp', 'AccessibleBedroom'] };
    expect(filterOf(buildScenarioQuery('http://x', 'Property', hasAnd, params(flagsCand))?.url))
      .toBe('AccessibilityFeatures has \'AccessibleApproachWithRamp\' and AccessibilityFeatures has \'AccessibleBedroom\'');
  });
  it('escapes an apostrophe in a record value (OData 4.01 doubling)', () => {
    expect(filterOf(buildScenarioQuery('http://x', 'Property', strAll, params(collStringCand(["Chef's Kitchen", 'Pantry'])))?.url))
      .toBe("Appliances/all(x:x eq 'Chef''s Kitchen' or x eq 'Pantry')");
  });
});

// ── end-to-end verdict through runEnumFamilyScenario ──

const respond = (records: ReadonlyArray<Record<string, unknown>>): ODataRequester => ({
  request: async (): Promise<ODataResponse> => ({ status: 200, headers: { 'odata-version': '4.01' }, body: { value: records }, rawBody: '' }),
});

describe('end-to-end — record-derived all() is a DETERMINATE check, not a skip', () => {
  it('empty result for a record-derived all() → FAIL (the guaranteeing record must come back)', async () => {
    const r = await runEnumFamilyScenario('http://x', 'Property', collAll, params(collEnumCand(['Barbecue', 'Garden'])), 'tok', 0, 'all', respond([]));
    expect(r.skipped).toBe(false);
    expect(r.passed).toBe(false);
  });
  it('the guaranteeing record comes back (its collection ⊆ the set) → PASS', async () => {
    const r = await runEnumFamilyScenario('http://x', 'Property', collAll, params(collEnumCand(['Barbecue', 'Garden'])), 'tok', 0, 'all', respond([{ ExteriorFeatures: ['Barbecue', 'Garden'] }]));
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(false);
  });
  it('a returned record with an OUT-OF-SET element → FAIL (all() logically violated — "incorrect set back")', async () => {
    const r = await runEnumFamilyScenario('http://x', 'Property', collAll, params(collEnumCand(['Barbecue', 'Garden'])), 'tok', 0, 'all', respond([{ ExteriorFeatures: ['Barbecue', 'Pool'] }]));
    expect(r.passed).toBe(false);
    expect(r.skipped).toBe(false);
  });
  it('NO subset (arbitrary value) — empty all() stays a SKIP, never a fail (the guard is preserved)', async () => {
    const r = await runEnumFamilyScenario('http://x', 'Property', collAll, params(collEnumCand()), 'tok', 0, 'all', respond([]));
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(true); // a skip never counts as a failure
  });
});
