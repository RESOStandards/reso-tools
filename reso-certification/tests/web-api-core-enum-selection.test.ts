import { describe, expect, it } from 'vitest';
import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import type { DdReference } from '../src/metadata/dd-metadata-checks.js';
import type { EntityProperty } from '../src/test-runner/types.js';
import { isMultiRep, isSingleRep, selectEnumCandidates } from '../src/web-api-core/enum-selection.js';
import { buildStandardMapFrom } from '../src/web-api-core/standard-map.js';

const enumTypes: ReadonlyArray<CsdlEnumType> = [
  {
    name: 'StandardStatus',
    isFlags: false,
    members: [
      { name: 'Active', value: '0' },
      { name: 'Pending', value: '1' },
      { name: 'Closed', value: '2' },
    ],
  },
  {
    name: 'AccessibilityFeatures',
    isFlags: true,
    members: [
      { name: 'None', value: '0' },
      { name: 'AccessibleApproachWithRamp', value: '1' },
      { name: 'AccessibleBedroom', value: '2' },
    ],
  },
];

const prop = (name: string, type: string, annotations?: Record<string, string>): EntityProperty => ({
  name,
  type,
  ...(annotations && { annotations }),
});

const properties: ReadonlyArray<EntityProperty> = [
  prop('StandardStatus', 'org.reso.metadata.enums.StandardStatus'), // SINGLE_ENUM, standard field
  prop('MyLocalStatus', 'org.reso.metadata.enums.StandardStatus'), // SINGLE_ENUM, LOCAL field (not in DD)
  prop('AccessibilityFeatures', 'org.reso.metadata.enums.AccessibilityFeatures'), // FLAGS_ENUM, standard
  prop('Appliances', 'Collection(Edm.String)', { 'RESO.OData.Metadata.LookupName': 'Appliances' }), // COLLECTION_STRING
  prop('ListPrice', 'Edm.Decimal'), // not an enum at all
];

const records: ReadonlyArray<Record<string, unknown>> = [
  {
    StandardStatus: 'Active',
    MyLocalStatus: 'Active',
    AccessibilityFeatures: 'AccessibleApproachWithRamp,AccessibleBedroom', // comma form
    Appliances: ['Dishwasher', 'Dryer'],
    ListPrice: 100,
  },
  {
    StandardStatus: 'Pending',
    MyLocalStatus: 'Closed',
    AccessibilityFeatures: 3, // integer bitmask (1 | 2) — must decode to the two members
    Appliances: ['Dishwasher'],
    ListPrice: 200,
  },
];

const ddRef: DdReference = {
  fields: [
    { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus' },
    { resourceName: 'Property', fieldName: 'AccessibilityFeatures', type: 'org.reso.metadata.enums.AccessibilityFeatures' },
    { resourceName: 'Property', fieldName: 'Appliances', type: 'Collection(Edm.String)' },
    { resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal' },
    // MyLocalStatus intentionally absent → local
  ],
  lookups: [
    { lookupName: 'StandardStatus', lookupValue: 'Active' },
    { lookupName: 'StandardStatus', lookupValue: 'Pending' },
    { lookupName: 'StandardStatus', lookupValue: 'Closed' },
    { lookupName: 'AccessibilityFeatures', lookupValue: 'AccessibleApproachWithRamp' },
    { lookupName: 'AccessibilityFeatures', lookupValue: 'AccessibleBedroom' },
    { lookupName: 'Appliances', lookupValue: 'Dishwasher' },
    { lookupName: 'Appliances', lookupValue: 'Dryer' },
  ],
};

const standardMap = buildStandardMapFrom(ddRef);
const select = (wantRep: (r: import('@reso-standards/reso-client').EnumRepresentation) => boolean) =>
  selectEnumCandidates(properties, records, enumTypes, standardMap, 'Property', wantRep);

describe('selectEnumCandidates — single-valued group', () => {
  const candidates = select(isSingleRep);

  it('picks the standard SINGLE_ENUM field first, local after', () => {
    expect(candidates.map((c) => c.field)).toEqual(['StandardStatus', 'MyLocalStatus']);
    expect(candidates[0].representation).toBe('SINGLE_ENUM');
    expect(candidates[0].isStandard).toBe(true);
    expect(candidates[1].isStandard).toBe(false);
  });

  it('carries standard-first decoded sample values (type-correct, from the field itself)', () => {
    expect(candidates[0].values).toContain('Active');
    expect(candidates[0].values).toContain('Pending');
  });

  it('excludes non-enum and multi-valued fields', () => {
    expect(candidates.some((c) => c.field === 'ListPrice')).toBe(false);
    expect(candidates.some((c) => c.field === 'AccessibilityFeatures')).toBe(false);
  });
});

describe('selectEnumCandidates — multi-valued group', () => {
  const candidates = select(isMultiRep);

  it('includes the flags and collection fields, tagged by real representation', () => {
    const byField = new Map(candidates.map((c) => [c.field, c]));
    expect(byField.get('AccessibilityFeatures')?.representation).toBe('FLAGS_ENUM');
    expect(byField.get('Appliances')?.representation).toBe('COLLECTION_STRING');
  });

  it('decodes an integer bitmask into member names (representation-aware sampling)', () => {
    const flags = candidates.find((c) => c.field === 'AccessibilityFeatures');
    // Record 2 sends the bitmask 3 (1|2); it must decode to the two members, not "3".
    expect(flags?.values).toContain('AccessibleApproachWithRamp');
    expect(flags?.values).toContain('AccessibleBedroom');
    expect(flags?.values).not.toContain('3');
  });

  it('carries the LookupName for a string-collection field', () => {
    expect(candidates.find((c) => c.field === 'Appliances')?.lookupName).toBe('Appliances');
  });
});

describe('R2-2 — Lookup Resource sample is local-first, filter values standard-first', () => {
  it('surfaces a local value (the RCP-039 risk) first for the Lookup Resource check', () => {
    const strProps = [prop('MlsStatus', 'Edm.String', { 'RESO.OData.Metadata.LookupName': 'MlsStatus' })];
    const strRecords = [{ MlsStatus: 'Active' }, { MlsStatus: 'CustomLocalStatus' }];
    const strDd: DdReference = {
      fields: [{ resourceName: 'Property', fieldName: 'MlsStatus', type: 'Edm.String' }],
      lookups: [{ lookupName: 'MlsStatus', lookupValue: 'Active' }], // 'CustomLocalStatus' intentionally absent from the DD
    };
    const strMap = buildStandardMapFrom(strDd);
    const [c] = selectEnumCandidates(strProps, strRecords, [], strMap, 'Property', isSingleRep);
    expect(c.representation).toBe('SINGLE_STRING');
    expect(c.values[0]).toBe('Active'); // standard-first — for filter tests
    expect(c.lookupSampleValues[0]).toBe('CustomLocalStatus'); // local-first — so a value missing from /Lookup is tested
  });
});

describe('drift resistance — frequency ordering, distinct count, fill rate', () => {
  // A standard SINGLE_ENUM field where 'Active' dominates (3 records) over 'Pending' (1), plus one record
  // that omits the field entirely — so the fill rate is 4/5, not 1.
  const freqProps = [prop('StandardStatus', 'org.reso.metadata.enums.StandardStatus')];
  const freqRecords: ReadonlyArray<Record<string, unknown>> = [
    { StandardStatus: 'Pending' }, // Pending appears FIRST in record order but is the minority value
    { StandardStatus: 'Active' },
    { StandardStatus: 'Active' },
    { StandardStatus: 'Active' },
    {}, // field absent → does not count toward fill
  ];
  const [c] = selectEnumCandidates(freqProps, freqRecords, enumTypes, standardMap, 'Property', isSingleRep);

  it('orders values most-frequent-first, not first-seen (Active dominates Pending)', () => {
    // First-seen order would put Pending first; frequency order must put Active first (drift-resistant choice).
    expect(c.values[0]).toBe('Active');
    expect(c.values).toContain('Pending');
  });

  it('reports the distinct value count the ne verdict consumes', () => {
    expect(c.distinctValueCount).toBe(2); // Active + Pending
  });

  it('reports fill rate as the fraction of records carrying a usable value', () => {
    expect(c.fillRate).toBeCloseTo(4 / 5); // one of five records omits the field
  });

  it('ranks the fuller field first within the same rank tier', () => {
    // Two standard fields of the same tier; the one populated in more records must sort first.
    const rankProps = [
      prop('SparseStatus', 'org.reso.metadata.enums.StandardStatus'),
      prop('FullStatus', 'org.reso.metadata.enums.StandardStatus'),
    ];
    const rankRecords = [
      { SparseStatus: 'Active', FullStatus: 'Active' },
      { FullStatus: 'Pending' }, // SparseStatus absent here → lower fill
    ];
    const rankDd: DdReference = {
      fields: [
        { resourceName: 'Property', fieldName: 'SparseStatus', type: 'org.reso.metadata.enums.StandardStatus' },
        { resourceName: 'Property', fieldName: 'FullStatus', type: 'org.reso.metadata.enums.StandardStatus' },
      ],
      lookups: ddRef.lookups,
    };
    const ranked = selectEnumCandidates(rankProps, rankRecords, enumTypes, buildStandardMapFrom(rankDd), 'Property', isSingleRep);
    expect(ranked.map((x) => x.field)).toEqual(['FullStatus', 'SparseStatus']);
  });
});

describe('rep predicates', () => {
  it('partition the five representations correctly', () => {
    expect(['SINGLE_ENUM', 'SINGLE_STRING'].every(isSingleRep)).toBe(true);
    expect(['FLAGS_ENUM', 'COLLECTION_ENUM', 'COLLECTION_STRING'].every(isMultiRep)).toBe(true);
    expect(isSingleRep('FLAGS_ENUM')).toBe(false);
    expect(isMultiRep('SINGLE_ENUM')).toBe(false);
  });
});
