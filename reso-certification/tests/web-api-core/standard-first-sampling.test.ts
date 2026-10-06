/**
 * Core sampling is RESO-first for every sampled group, not only the enumerations (#315).
 *
 * Integer, Decimal and Date used to be picked by `findBestField`: the first field of the type in metadata
 * declaration order carrying enough distinct sampled values, with no notion of a standard element and no
 * alternates. Observed consequence on a 2.1.0 run (2026-09-21): a LOCAL `Edm.Date` sorted first in the metadata,
 * the server answered 500 to its `$filter`, and all six Date scenarios failed while standard Date fields with
 * values sat on the same resource. Expansions had the same gap — `expandField` was simply the first declared
 * collection navigation.
 *
 * These tests pin the four behaviors the fix owes: a standard field beats an earlier-declared local one, a local
 * field is reached only when no standard field is populated, the runner walks past a non-2xx to the next
 * candidate, and the expansions are ordered standard-first without losing coverage of the local ones.
 */

import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { EntityType, ODataResponse } from '../../src/test-runner/types.js';
import { type TestParams, numericStats, rankCollectionNavs, resolveTestParams } from '../../src/web-api-core/sampling.js';
import { selectScalarCandidates } from '../../src/web-api-core/scalar-selection.js';

import type { StandardMap } from '../../src/web-api-core/standard-map.js';
import { type ScalarFilterScenario, runScalarFilterScenario } from '../../src/web-api-core/test-runner.js';

// A StandardMap whose only real answer is isStandardField — the one question scalar and expansion ranking asks.
// The value-level members are inert here (no enumeration is involved).
const standardMapFor = (standardFields: ReadonlyArray<string>): StandardMap => ({
  isStandardField: (_resource, field) => standardFields.includes(field),
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
  standardValuesForField: () => undefined,
  isClosedEnumField: () => false
});

const ALL_LOCAL = standardMapFor([]);

const makeEntityType = (properties: EntityType['properties'], navigationProperties?: EntityType['navigationProperties']): EntityType => ({
  name: 'Property',
  keyProperties: ['ListingKey'],
  properties: [{ name: 'ListingKey', type: 'Edm.String' }, ...properties],
  ...(navigationProperties && { navigationProperties })
});

const pageOf = (records: ReadonlyArray<Record<string, unknown>>): ODataResponse => ({
  status: 200,
  headers: { 'odata-version': '4.01' },
  body: { value: records },
  rawBody: JSON.stringify({ value: records })
});

const samplingRequester = (records: ReadonlyArray<Record<string, unknown>>): ODataRequester => ({
  request: async () => pageOf(records)
});

const sample = (entityType: EntityType, records: ReadonlyArray<Record<string, unknown>>, standardMap: StandardMap): Promise<TestParams> =>
  resolveTestParams('http://x', 'Property', entityType, 'tok', [], standardMap, undefined, samplingRequester(records));

// ── The Date group: the field that failed the 2026-09-21 run ──

// A local Edm.Date declared BEFORE a standard one, both with three distinct values. This is the observed shape.
const DATE_PROPERTIES: EntityType['properties'] = [
  { name: 'LocalClosingDate', type: 'Edm.Date' },
  { name: 'ListingContractDate', type: 'Edm.Date' }
];
const DATE_RECORDS = [
  { ListingKey: 'P1', LocalClosingDate: '2024-01-01', ListingContractDate: '2023-05-01' },
  { ListingKey: 'P2', LocalClosingDate: '2024-01-02', ListingContractDate: '2023-05-02' },
  { ListingKey: 'P3', LocalClosingDate: '2024-01-03', ListingContractDate: '2023-05-03' }
];
const DATE_STANDARD_MAP = standardMapFor(['ListingContractDate']);

describe('scalar sampling is RESO-first (#315): a standard field beats an earlier-declared local one', () => {
  it('picks the standard Edm.Date even though the local one is declared first (the 2026-09-21 regression)', async () => {
    const params = await sample(makeEntityType(DATE_PROPERTIES), DATE_RECORDS, DATE_STANDARD_MAP);
    expect(params.dateField).toBe('ListingContractDate');
    expect(params.dateValue).toBe('2023-05-02'); // the median of the CHOSEN field, not the local one's
  });

  it('keeps the local field as a ranked alternate rather than discarding it', async () => {
    const params = await sample(makeEntityType(DATE_PROPERTIES), DATE_RECORDS, DATE_STANDARD_MAP);
    expect((params.dateCandidates ?? []).map(c => c.field)).toEqual(['ListingContractDate', 'LocalClosingDate']);
  });

  it('does the same for Integer and Decimal', async () => {
    const params = await sample(
      makeEntityType([
        { name: 'LocalCount', type: 'Edm.Int64' },
        { name: 'BedroomsTotal', type: 'Edm.Int64' },
        { name: 'LocalAmount', type: 'Edm.Decimal' },
        { name: 'ListPrice', type: 'Edm.Decimal' }
      ]),
      [
        { ListingKey: 'P1', LocalCount: 1, BedroomsTotal: 10, LocalAmount: 1.5, ListPrice: 100.5 },
        { ListingKey: 'P2', LocalCount: 2, BedroomsTotal: 20, LocalAmount: 2.5, ListPrice: 200.5 },
        { ListingKey: 'P3', LocalCount: 3, BedroomsTotal: 30, LocalAmount: 3.5, ListPrice: 300.5 }
      ],
      standardMapFor(['BedroomsTotal', 'ListPrice'])
    );
    expect(params.integerField).toBe('BedroomsTotal');
    expect(params.integerValueLow).toBe(20); // the standard field's own median
    expect(params.decimalField).toBe('ListPrice');
    expect(params.decimalValueLow).toBe(200.5);
  });

  it('derives the not() sentinel from the CHOSEN field, not from whichever was declared first', async () => {
    // The local field is non-negative (sentinel -1); the chosen standard field is signed and goes below it.
    const params = await sample(
      makeEntityType([
        { name: 'LocalCount', type: 'Edm.Int64' },
        { name: 'BedroomsTotal', type: 'Edm.Int64' }
      ]),
      [
        { ListingKey: 'P1', LocalCount: 1, BedroomsTotal: -40 },
        { ListingKey: 'P2', LocalCount: 2, BedroomsTotal: -20 },
        { ListingKey: 'P3', LocalCount: 3, BedroomsTotal: 30 }
      ],
      standardMapFor(['BedroomsTotal'])
    );
    expect(params.integerField).toBe('BedroomsTotal');
    expect(params.integerNotSentinel).toBe(-41);
  });
});

describe('scalar sampling: a local field is reached only when no standard field is populated', () => {
  it('falls back to the local field when every standard field of the type is empty', async () => {
    const params = await sample(
      makeEntityType(DATE_PROPERTIES),
      [
        { ListingKey: 'P1', LocalClosingDate: '2024-01-01', ListingContractDate: null },
        { ListingKey: 'P2', LocalClosingDate: '2024-01-02', ListingContractDate: null },
        { ListingKey: 'P3', LocalClosingDate: '2024-01-03', ListingContractDate: null }
      ],
      DATE_STANDARD_MAP
    );
    expect(params.dateField).toBe('LocalClosingDate');
    expect((params.dateCandidates ?? []).map(c => c.field)).toEqual(['LocalClosingDate']);
  });

  it('prefers a standard field even when it is SPARSER than a local one — the filter precedes the ranking', async () => {
    // The candidates are filtered to the standard elements and ranked on usage FROM THERE, so usage never
    // promotes a local field over a standard one. One distinct standard value against three local ones: the
    // standard field still leads, and if the server will not serve it the ladder falls through to the local one
    // rather than stranding the type.
    const params = await sample(
      makeEntityType(DATE_PROPERTIES),
      [
        { ListingKey: 'P1', LocalClosingDate: '2024-01-01', ListingContractDate: '2023-05-01' },
        { ListingKey: 'P2', LocalClosingDate: '2024-01-02', ListingContractDate: null },
        { ListingKey: 'P3', LocalClosingDate: '2024-01-03', ListingContractDate: null }
      ],
      DATE_STANDARD_MAP
    );
    expect(params.dateField).toBe('ListingContractDate');
    expect((params.dateCandidates ?? []).map(c => c.field)).toEqual(['ListingContractDate', 'LocalClosingDate']);
  });

  it('inside the standard set, USAGE leads — a fully populated single-valued field outranks a sparser richer one', () => {
    // The requirement is "filtered by what's in the standard and then ranked on usage from there" (#315: "most-used
    // among standard fields means, in the engine, fill rate in the sample"). Distinct count is NOT a key ahead of
    // usage: HighUsageOneValue is 6/6 populated with one value, LowUsageThreeValues only 3/6 with three. Usage wins.
    // Where the standard set is too thin to settle an operator, the ladder recovers — not a reordering of the set.
    const records = [
      { HighUsageOneValue: 7, LowUsageThreeValues: 1, TieMoreDistinct: 10 },
      { HighUsageOneValue: 7, LowUsageThreeValues: 2, TieMoreDistinct: 20 },
      { HighUsageOneValue: 7, LowUsageThreeValues: 3, TieMoreDistinct: 30 },
      { HighUsageOneValue: 7, LowUsageThreeValues: null, TieMoreDistinct: 40 },
      { HighUsageOneValue: 7, LowUsageThreeValues: null, TieMoreDistinct: 10 },
      { HighUsageOneValue: 7, LowUsageThreeValues: null, TieMoreDistinct: 20 }
    ];
    const allStandard = standardMapFor(['HighUsageOneValue', 'LowUsageThreeValues', 'TieMoreDistinct']);
    const ranked = selectScalarCandidates(
      ['HighUsageOneValue', 'LowUsageThreeValues', 'TieMoreDistinct'],
      records,
      allStandard,
      'Property',
      numericStats
    );
    // TieMoreDistinct and HighUsageOneValue are both 6/6, so distinct count breaks THAT tie and nothing else;
    // LowUsageThreeValues is last on usage despite carrying the second-most distinct values.
    expect(ranked.map(c => c.field)).toEqual(['TieMoreDistinct', 'HighUsageOneValue', 'LowUsageThreeValues']);
    expect(ranked.map(c => c.fillRate)).toEqual([1, 1, 0.5]);
  });

  it('falls back to the local fields ranked by usage when nothing standard is available', () => {
    const records = [
      { LocalFuller: 1, LocalSparser: 9 },
      { LocalFuller: 2, LocalSparser: null },
      { LocalFuller: 3, LocalSparser: null },
      { LocalFuller: 4, LocalSparser: null }
    ];
    const ranked = selectScalarCandidates(['LocalSparser', 'LocalFuller'], records, ALL_LOCAL, 'Property', numericStats);
    expect(ranked.map(c => c.field)).toEqual(['LocalFuller', 'LocalSparser']);
  });

  it('excludes a field whose sampled values the type cannot use, instead of certifying the type on it', async () => {
    // A declared Edm.Int64 serving non-numeric text: numericStats finds nothing finite, so it is not a candidate
    // and the standard field carries the type. Previously declaration order selected it and the scenarios skipped.
    const params = await sample(
      makeEntityType([
        { name: 'LocalCount', type: 'Edm.Int64' },
        { name: 'BedroomsTotal', type: 'Edm.Int64' }
      ]),
      [
        { ListingKey: 'P1', LocalCount: 'n/a', BedroomsTotal: 10 },
        { ListingKey: 'P2', LocalCount: 'n/a', BedroomsTotal: 20 },
        { ListingKey: 'P3', LocalCount: 'unknown', BedroomsTotal: 30 }
      ],
      standardMapFor(['BedroomsTotal'])
    );
    expect(params.integerField).toBe('BedroomsTotal');
    expect((params.integerCandidates ?? []).map(c => c.field)).toEqual(['BedroomsTotal']);
  });
});

// ── The retry: a server that will not filter on one field no longer fails the whole type ──

const DATE_EQ_SCENARIO: ScalarFilterScenario = {
  tag: 'filter-date-eq',
  name: 'Date: eq',
  category: 'filter',
  dataType: 'date',
  op: 'eq',
  fieldParam: 'dateField',
  valueParam: 'dateValue',
  minVersion: '2.0.0'
};

/** A requester that rejects any query naming `brokenField` and serves `records` for everything else. */
const rejectingRequester = (
  brokenField: string,
  records: ReadonlyArray<Record<string, unknown>>,
  status = 500
): ODataRequester & { readonly urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    request: async ({ url }) => {
      urls.push(url);
      return url.includes(brokenField)
        ? { status, headers: {}, body: { error: { message: 'cannot filter on that field' } }, rawBody: '{}' }
        : pageOf(records);
    }
  };
};

describe('scalar filter scenarios walk the candidate ladder past a non-2xx (#315)', () => {
  it('certifies the type on the next candidate when the standard field 500s, instead of failing', async () => {
    const params = await sample(makeEntityType(DATE_PROPERTIES), DATE_RECORDS, DATE_STANDARD_MAP);
    expect(params.dateField).toBe('ListingContractDate'); // the ladder starts standard-first
    const requester = rejectingRequester('ListingContractDate', [{ ListingKey: 'P2', LocalClosingDate: '2024-01-02' }]);
    const result = await runScalarFilterScenario('http://x', 'Property', DATE_EQ_SCENARIO, params, 'tok', Date.now(), requester);
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    // It tried the standard field first and only then the local one — and reported the one that answered.
    expect(requester.urls.some(u => u.includes('ListingContractDate'))).toBe(true);
    expect(result.requestUrl).toContain('LocalClosingDate');
  });

  it('queries each alternate with its OWN median, never the primary field’s value', async () => {
    const params = await sample(makeEntityType(DATE_PROPERTIES), DATE_RECORDS, DATE_STANDARD_MAP);
    const requester = rejectingRequester('ListingContractDate', [{ ListingKey: 'P2', LocalClosingDate: '2024-01-02' }]);
    await runScalarFilterScenario('http://x', 'Property', DATE_EQ_SCENARIO, params, 'tok', Date.now(), requester);
    const localAttempt = requester.urls.find(u => u.includes('LocalClosingDate')) ?? '';
    expect(decodeURIComponent(localAttempt)).toContain('2024-01-02'); // the local field's median
    expect(decodeURIComponent(localAttempt)).not.toContain('2023-05-02'); // not the standard field's
  });

  it('still FAILS when every candidate rejects the operator — an all-reject gap is a real defect', async () => {
    const params = await sample(makeEntityType(DATE_PROPERTIES), DATE_RECORDS, DATE_STANDARD_MAP);
    // Both candidates carry "Date" in their names, so this rejects every attempt.
    const requester = rejectingRequester('Date', []);
    const result = await runScalarFilterScenario('http://x', 'Property', DATE_EQ_SCENARIO, params, 'tok', Date.now(), requester);
    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
  });

  it('a lone candidate that rejects the operator still fails, exactly as before the ladder', async () => {
    const params = await sample(makeEntityType([{ name: 'ListingContractDate', type: 'Edm.Date' }]), DATE_RECORDS, DATE_STANDARD_MAP);
    const requester = rejectingRequester('ListingContractDate', [], 400);
    const result = await runScalarFilterScenario('http://x', 'Property', DATE_EQ_SCENARIO, params, 'tok', Date.now(), requester);
    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
  });
});

// ── Expansions ──

describe('expansions are ordered RESO-first, without losing coverage (#315)', () => {
  const NAVS: NonNullable<EntityType['navigationProperties']> = [
    { name: 'LocalHistory', isCollection: true, targetType: 'LocalHistory' },
    { name: 'Media', isCollection: true, targetType: 'Media' }
  ];

  it('makes expandField the first STANDARD collection nav, not the first declared', async () => {
    const params = await sample(makeEntityType([], NAVS), [{ ListingKey: 'P1' }], standardMapFor(['Media']));
    expect(params.expandField).toBe('Media');
  });

  it('still tests every declared collection nav — ranking decides order, never coverage', async () => {
    const params = await sample(makeEntityType([], NAVS), [{ ListingKey: 'P1' }], standardMapFor(['Media']));
    expect((params.expandNavs ?? []).map(n => n.name)).toEqual(['Media', 'LocalHistory']);
  });

  it('keeps declaration order when no nav is standard, so selection stays deterministic', async () => {
    const params = await sample(makeEntityType([], NAVS), [{ ListingKey: 'P1' }], ALL_LOCAL);
    expect(params.expandField).toBe('LocalHistory');
    expect((params.expandNavs ?? []).map(n => n.name)).toEqual(['LocalHistory', 'Media']);
  });

  it('rankCollectionNavs is a stable standard-first partition', () => {
    const navs = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
    expect(rankCollectionNavs(navs, standardMapFor(['B', 'D']), 'Property').map(n => n.name)).toEqual(['B', 'D', 'A', 'C']);
  });
});

// ── The groups the ticket deliberately leaves alone ──

describe('timestamps and the key are unchanged (#315 scope)', () => {
  it('still grounds the timestamp scenarios on ModificationTimestamp even when it is a sparser field', async () => {
    // ModificationTimestamp is required on every standard resource and is the only field guaranteed <= now, so it
    // is chosen by requirement rather than by the standard-first ranking. A local resource is the anything-goes case.
    const params = await sample(
      makeEntityType([
        { name: 'OpenHouseStartTime', type: 'Edm.DateTimeOffset' },
        { name: 'ModificationTimestamp', type: 'Edm.DateTimeOffset' }
      ]),
      [
        { ListingKey: 'P1', OpenHouseStartTime: '2030-01-01T00:00:00Z', ModificationTimestamp: '2024-01-01T00:00:00Z' },
        { ListingKey: 'P2', OpenHouseStartTime: '2030-02-01T00:00:00Z', ModificationTimestamp: '2024-01-01T00:00:00Z' }
      ],
      standardMapFor(['OpenHouseStartTime', 'ModificationTimestamp'])
    );
    expect(params.timestampField).toBe('ModificationTimestamp');
  });
});
