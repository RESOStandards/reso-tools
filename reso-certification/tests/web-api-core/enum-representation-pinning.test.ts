import { describe, expect, it } from 'vitest';
import type { EnumCandidate } from '../../src/web-api-core/enum-selection.js';
import type { CoreScenario } from '../../src/web-api-core/scenarios.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import { runEnumFamilyScenario, scenarioTargetsRep } from '../../src/web-api-core/test-runner.js';

// A3 + #2: enum-family scenarios are PINNED to their own representation. The catalog has a distinct scenario per
// representation, so each certifies its own implementation — a 2.1.0 `string-enum` scenario never lands on an
// `Edm.EnumType` field (nor an `enum` scenario on a string field), and a provider carrying BOTH an enum-typed and a
// string collection gets EACH field exercised, instead of only the first-ranked one.

describe('scenarioTargetsRep — each scenario pins to its own representation', () => {
  const s = (over: Partial<CoreScenario> & Pick<CoreScenario, 'category'>): CoreScenario =>
    ({ tag: 't', name: '', fieldParam: 'singleLookupField', minVersion: '2.0.0', ...over } as CoreScenario);

  it('enum/single → SINGLE_ENUM only (never the string field — A3)', () => {
    const sc = s({ category: 'enum', enumType: 'single', op: 'eq' });
    expect(scenarioTargetsRep(sc, 'SINGLE_ENUM')).toBe(true);
    expect(scenarioTargetsRep(sc, 'SINGLE_STRING')).toBe(false);
  });

  it('enum/multi → FLAGS_ENUM only (not a collection)', () => {
    const sc = s({ category: 'enum', enumType: 'multi', op: 'has' });
    expect(scenarioTargetsRep(sc, 'FLAGS_ENUM')).toBe(true);
    expect(scenarioTargetsRep(sc, 'COLLECTION_ENUM')).toBe(false);
    expect(scenarioTargetsRep(sc, 'COLLECTION_STRING')).toBe(false);
  });

  it('collection → COLLECTION_ENUM only (never the string collection — A3)', () => {
    const sc = s({ category: 'collection', lambda: 'any' });
    expect(scenarioTargetsRep(sc, 'COLLECTION_ENUM')).toBe(true);
    expect(scenarioTargetsRep(sc, 'COLLECTION_STRING')).toBe(false);
  });

  it('string-enum/single → SINGLE_STRING only (never the Edm.EnumType field — A3)', () => {
    const sc = s({ category: 'string-enum', enumType: 'single', op: 'eq' });
    expect(scenarioTargetsRep(sc, 'SINGLE_STRING')).toBe(true);
    expect(scenarioTargetsRep(sc, 'SINGLE_ENUM')).toBe(false);
  });

  it('string-enum/multi → COLLECTION_STRING only (never Collection(EnumType) — A3)', () => {
    const sc = s({ category: 'string-enum', enumType: 'multi', op: 'any' });
    expect(scenarioTargetsRep(sc, 'COLLECTION_STRING')).toBe(true);
    expect(scenarioTargetsRep(sc, 'COLLECTION_ENUM')).toBe(false);
  });

  it('in → BOTH single reps (spec :110: single-valued only, string or enum), never multi', () => {
    const sc = s({ category: 'in-operator', enumType: 'single' });
    expect(scenarioTargetsRep(sc, 'SINGLE_ENUM')).toBe(true);
    expect(scenarioTargetsRep(sc, 'SINGLE_STRING')).toBe(true);
    expect(scenarioTargetsRep(sc, 'COLLECTION_STRING')).toBe(false);
    expect(scenarioTargetsRep(sc, 'FLAGS_ENUM')).toBe(false);
  });
});

// The wiring: runEnumFamilyScenario filters candidates to the scenario's own representation, so which FIELD it
// queries proves the pinning. A both-reps provider has BOTH a Collection(EnumType) and a Collection(String) field.
const multiCand = (field: string, representation: EnumCandidate['representation'], value: string): EnumCandidate => ({
  field,
  representation,
  isStandard: true,
  values: [value],
  lookupSampleValues: [value],
  distinctValueCount: 1,
  fillRate: 1,
});

const paramsWithMultis = (cands: ReadonlyArray<EnumCandidate>): TestParams => ({
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
  multiLookupField: cands[0]?.field,
  multiLookupValue1: cands[0]?.values[0],
  multiLookupCandidates: cands,
});

// Records request URLs; returns a record carrying BOTH collection fields so whichever field is queried has data.
const recorder = (): { requester: ODataRequester; urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    requester: {
      request: async ({ url }) => {
        urls.push(url);
        return { status: 200, headers: { 'odata-version': '4.01' }, body: { value: [{ CollEnumField: ['E1'], CollStringField: ['S1'] }] }, rawBody: '' };
      },
    },
  };
};

const collEnumScenario: CoreScenario = { tag: 'filter-coll-enum-any', name: '', category: 'collection', lambda: 'any', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', minVersion: '2.0.0' } as CoreScenario;
const strMultiScenario: CoreScenario = { tag: 'filter-string-enum-multi-any', name: '', category: 'string-enum', enumType: 'multi', op: 'any', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', minVersion: '2.1.0' } as CoreScenario;
const bothReps = [multiCand('CollEnumField', 'COLLECTION_ENUM', 'E1'), multiCand('CollStringField', 'COLLECTION_STRING', 'S1')];

describe('runEnumFamilyScenario — a both-reps provider gets EACH implementation certified (#2)', () => {
  it('the Collection(EnumType) scenario queries the enum field, NOT the string field', async () => {
    const { requester, urls } = recorder();
    await runEnumFamilyScenario('http://x', 'Property', collEnumScenario, paramsWithMultis(bothReps), 'tok', 0, 'any', requester);
    expect(urls.some((u) => u.includes('CollEnumField'))).toBe(true);
    expect(urls.some((u) => u.includes('CollStringField'))).toBe(false); // pinned — the string collection is out of scope here
  });

  it('the Collection(String) scenario queries the string field, NOT the enum field', async () => {
    const { requester, urls } = recorder();
    await runEnumFamilyScenario('http://x', 'Property', strMultiScenario, paramsWithMultis(bothReps), 'tok', 0, 'any', requester);
    expect(urls.some((u) => u.includes('CollStringField'))).toBe(true);
    expect(urls.some((u) => u.includes('CollEnumField'))).toBe(false);
  });

  it('a string-enum scenario with ONLY an Edm.EnumType collection present → SKIP, not a false-certify (A3)', async () => {
    const { requester, urls } = recorder();
    const enumOnly = [multiCand('CollEnumField', 'COLLECTION_ENUM', 'E1')];
    const result = await runEnumFamilyScenario('http://x', 'Property', strMultiScenario, paramsWithMultis(enumOnly), 'tok', 0, 'any', requester);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true); // a skip is N/A, never a failure
    expect(urls.length).toBe(0); // no request issued — the enum field is not this scenario's representation
  });
});

// `has` on a single-valued enum: the Commander tests `filter-enum-single-has` (2.0.0 + 2.1.0), but our engine's
// opValidForRep excluded `has` from single reps, so the ported scenario never ran. Restored for SINGLE_ENUM only.
const singleCand = (field: string, representation: EnumCandidate['representation'], value: string): EnumCandidate => ({
  field,
  representation,
  isStandard: true,
  values: [value],
  lookupSampleValues: [value],
  distinctValueCount: 1,
  fillRate: 1,
});

const paramsWithSingles = (cands: ReadonlyArray<EnumCandidate>): TestParams => ({
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
  singleLookupField: cands[0]?.field,
  singleLookupValue: cands[0]?.values[0],
  singleLookupCandidates: cands,
});

const singleHasScenario: CoreScenario = { tag: 'filter-enum-single-has', name: '', category: 'enum', enumType: 'single', op: 'has', fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.0.0' } as CoreScenario;

describe('runEnumFamilyScenario — single-enum `has` restored (Commander parity)', () => {
  it('filter-enum-single-has now runs against a SINGLE_ENUM field with `has` (it never ran before)', async () => {
    const urls: string[] = [];
    const requester: ODataRequester = {
      request: async ({ url }) => {
        urls.push(url);
        return { status: 200, headers: { 'odata-version': '4.01' }, body: { value: [{ StatusField: 'Active' }] }, rawBody: '' };
      },
    };
    await runEnumFamilyScenario('http://x', 'Property', singleHasScenario, paramsWithSingles([singleCand('StatusField', 'SINGLE_ENUM', 'Active')]), 'tok', 0, 'has', requester);
    expect(urls.some((u) => u.includes('StatusField') && decodeURIComponent(u).includes(' has '))).toBe(true);
  });

  it('filter-enum-single-has SKIPS when the only single field is a string enum — `has` is enum-only (no request)', async () => {
    const urls: string[] = [];
    const requester: ODataRequester = {
      request: async ({ url }) => {
        urls.push(url);
        return { status: 200, headers: { 'odata-version': '4.01' }, body: { value: [] }, rawBody: '' };
      },
    };
    const result = await runEnumFamilyScenario('http://x', 'Property', singleHasScenario, paramsWithSingles([singleCand('CityField', 'SINGLE_STRING', 'Chicago')]), 'tok', 0, 'has', requester);
    expect(result.skipped).toBe(true);
    expect(urls.length).toBe(0);
  });
});
