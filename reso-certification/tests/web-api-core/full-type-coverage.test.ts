import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import { describe, expect, it } from 'vitest';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import type { EntityProperty } from '../../src/test-runner/types.js';
import { isMultiRep, isSingleRep, selectEnumCandidates } from '../../src/web-api-core/enum-selection.js';
import { declaredCoreType, providedTypesOf } from '../../src/web-api-core/provided-types.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { buildStandardMapFrom } from '../../src/web-api-core/standard-map.js';
import { type TypeCoverage, buildCoverage } from '../../src/web-api-core/test-runner.js';
import { coverageFails, coverageFailureReasons, typeCoverageOf } from '../../src/web-api-core/type-coverage.js';

/**
 * Full type coverage (Josh, 2026-11-03): every data type the Core tests exercise, met on some field of some resource
 * tested. Every run measures it and its report says whether it was achieved, and the run reaches for it: a field that
 * cannot give a type its tests is not picked over one that can.
 *
 * "Met" follows the spec (Core §3.3): one sample value for a single-valued enumeration, two for a multi-valued one.
 */

const allMet = (resource: string): { readonly resource: string; readonly coverage: ReadonlyArray<TypeCoverage> } => ({
  resource,
  coverage: ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'].map(type => ({ type, field: 'F', hasData: true }))
});
const without = (report: ReturnType<typeof allMet>, missing: string) => ({
  ...report,
  coverage: report.coverage.map(c => (c.type === missing ? { ...c, hasData: false } : c))
});

describe('what meets a type', () => {
  const params = (over: Partial<TestParams>): TestParams => ({ skippedTypes: [], ...over }) as TestParams;
  const met = (over: Partial<TestParams>, type: string): boolean | undefined =>
    buildCoverage(params(over)).find(c => c.type === type)?.hasData;

  it('meets a multi-valued lookup only with two sampled values, as the spec gives two', () => {
    expect(met({ multiLookupField: 'RentIncludes', multiLookupValue1: 'None' }, 'multiLookup')).toBe(false);
    expect(met({ multiLookupField: 'Appliances', multiLookupValue1: 'Dishwasher', multiLookupValue2: 'Dryer' }, 'multiLookup')).toBe(true);
  });

  it('meets a single-valued lookup with one sampled value, as the spec gives one', () => {
    expect(met({ singleLookupField: 'StandardStatus', singleLookupValue: 'Active' }, 'singleLookup')).toBe(true);
  });
});

describe('whether a run met every type', () => {
  it('takes each type from any resource tested: none has to carry all of them', () => {
    const verdict = typeCoverageOf([without(allMet('Property'), 'multiLookup'), without(allMet('Member'), 'decimal')]);
    expect(verdict).toEqual({
      coveredTypes: ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'],
      missingTypes: [],
      fullCoverage: true,
      providedNotMet: []
    });
  });

  it('misses a type that no resource tested met', () => {
    const verdict = typeCoverageOf([without(allMet('Property'), 'multiLookup'), without(allMet('Member'), 'multiLookup')]);
    expect(verdict).toMatchObject({ missingTypes: ['multiLookup'], fullCoverage: false });
  });

  it('counts only the resources tested, so a run naming one resource needs every type there, as Core 2.0.0 did', () => {
    expect(typeCoverageOf([without(allMet('Property'), 'multiLookup')])).toMatchObject({
      missingTypes: ['multiLookup'],
      fullCoverage: false
    });
  });
});

describe('the multi-valued lookup a run tests', () => {
  const enumTypes: ReadonlyArray<CsdlEnumType> = [];
  const lookup = (name: string, multi: boolean): EntityProperty => ({
    name,
    type: multi ? 'Collection(Edm.String)' : 'Edm.String',
    annotations: { 'RESO.OData.Metadata.LookupName': name }
  });
  const dd: DdReference = {
    fields: [
      { resourceName: 'Property', fieldName: 'RentIncludes', type: 'Collection(Edm.String)' },
      { resourceName: 'Property', fieldName: 'PropertyType', type: 'Edm.String' }
    ],
    lookups: [
      { lookupName: 'RentIncludes', lookupValue: 'None' },
      { lookupName: 'PropertyType', lookupValue: 'Residential' }
    ]
  };
  // The FBS case: a standard field whose sample holds one standard value, beside a local field with two.
  const records = [
    { RentIncludes: ['None'], LocalAmenities: ['Pool', 'Gym'], PropertyType: 'Residential', LocalType: 'Cabin' },
    { RentIncludes: ['None'], LocalAmenities: ['Pool'], PropertyType: 'Residential', LocalType: 'Barn' }
  ];
  const select = (properties: ReadonlyArray<EntityProperty>, wantRep: typeof isMultiRep) =>
    selectEnumCandidates(properties, records, enumTypes, buildStandardMapFrom(dd), 'Property', wantRep).map(c => c.field);

  it('is one with both values to test, and never a field with one, however standard', () => {
    expect(select([lookup('RentIncludes', true), lookup('LocalAmenities', true)], isMultiRep)).toEqual(['LocalAmenities']);
  });

  it('is none when no field has both values: the type is not met, and its tests are not tested rather than run on one', () => {
    expect(select([lookup('RentIncludes', true)], isMultiRep)).toEqual([]);
  });

  it('leaves the single-valued ranking as it was: one value is all a single-valued lookup needs', () => {
    expect(select([lookup('PropertyType', false), lookup('LocalType', false)], isSingleRep)).toEqual(['PropertyType', 'LocalType']);
  });
});

/**
 * Full type coverage is required (Josh, 2026-11-03: "For Cert, full coverage needs to be achieved across all types for a
 * Core server to be considered compliant"; 2026-11-12: "that's a must"), except for a type the server cannot fulfill:
 * "a server who can't fulfill all types in their standard or local fields is just recorded as not having achieved full
 * type coverage, but can still be certified". A certified run once met no single lookup on a resource carrying lookups.
 */
describe('a type the server provides must be met', () => {
  const prop = (name: string, type: string, lookupName?: string): EntityProperty => ({
    name,
    type,
    ...(lookupName ? { annotations: { 'RESO.OData.Metadata.LookupName': lookupName } } : {})
  });
  const enums: ReadonlyArray<CsdlEnumType> = [
    { name: 'StandardStatus', members: [{ name: 'Active' }, { name: 'Closed' }] },
    {
      name: 'Appliances',
      members: [
        { name: 'Dishwasher', value: '1' },
        { name: 'Dryer', value: '2' }
      ],
      isFlags: true
    }
  ];

  it('reads the type from the declared metadata, every lookup form the spec allows included', () => {
    expect(declaredCoreType(prop('BedroomsTotal', 'Edm.Int32'), enums)).toBe('integer');
    expect(declaredCoreType(prop('ListPrice', 'Edm.Double'), enums)).toBe('decimal');
    expect(declaredCoreType(prop('ListingContractDate', 'Edm.Date'), enums)).toBe('date');
    expect(declaredCoreType(prop('ModificationTimestamp', 'Edm.DateTimeOffset'), enums)).toBe('timestamp');
    expect(declaredCoreType(prop('StandardStatus', 'org.reso.metadata.enums.StandardStatus'), enums)).toBe('singleLookup');
    expect(declaredCoreType(prop('StandardStatus', 'Edm.String', 'StandardStatus'), enums)).toBe('singleLookup');
    expect(declaredCoreType(prop('Appliances', 'org.reso.metadata.enums.Appliances'), enums)).toBe('multiLookup');
    expect(declaredCoreType(prop('Appliances', 'Collection(org.reso.metadata.enums.Appliances)'), enums)).toBe('multiLookup');
    expect(declaredCoreType(prop('Appliances', 'Collection(Edm.String)', 'Appliances'), enums)).toBe('multiLookup');
    expect(declaredCoreType(prop('City', 'Edm.String'), enums)).toBeUndefined();
    expect(declaredCoreType(prop('Tags', 'Collection(Edm.String)'), enums)).toBeUndefined();
  });

  it('counts a type as provided only when sampled data can meet it: a multi-valued lookup needs two values', () => {
    const properties = [
      prop('StandardStatus', 'Edm.String', 'StandardStatus'),
      prop('RentIncludes', 'Collection(Edm.String)', 'RentIncludes'),
      prop('Appliances', 'org.reso.metadata.enums.Appliances'),
      prop('CloseDate', 'Edm.Date')
    ];
    const records = [
      { StandardStatus: 'Active', RentIncludes: ['None'], Appliances: 3, CloseDate: null },
      { StandardStatus: null, RentIncludes: ['None'], Appliances: null, CloseDate: null }
    ];
    // RentIncludes holds one value, so it cannot fulfill a multi-valued lookup; Appliances 3 is two flags. CloseDate is
    // declared and empty: the server cannot fulfill a date, so it is not provided.
    expect(providedTypesOf(properties, records, enums)).toEqual([
      { type: 'singleLookup', fields: ['StandardStatus'] },
      { type: 'multiLookup', fields: ['Appliances'] }
    ]);
  });

  const report = (resource: string, coverage: ReadonlyArray<TypeCoverage>) => ({ resource, coverage });
  const metExcept = (missing: string, providedBy: ReadonlyArray<string>) =>
    ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'].map(type =>
      type === missing ? { type, field: undefined, hasData: false, providedBy } : { type, field: 'F', hasData: true, providedBy: ['F'] }
    );

  it('fails a run that met no single lookup though the server provides one, naming the field', () => {
    const verdict = typeCoverageOf([report('Property', metExcept('singleLookup', ['StandardStatus']))]);
    expect(verdict.providedNotMet).toEqual([{ type: 'singleLookup', fields: ['Property.StandardStatus'] }]);
    expect(coverageFails(verdict, false, true)).toBe(true);
    expect(coverageFailureReasons(verdict, false)).toEqual([
      'Full type coverage not achieved: the server provides singleLookup in Property.StandardStatus, and the run met no singleLookup'
    ]);
  });

  it('records a type the server does not provide, and lets the run certify', () => {
    const verdict = typeCoverageOf([report('Property', metExcept('date', []))]);
    expect(verdict).toMatchObject({ missingTypes: ['date'], fullCoverage: false, providedNotMet: [] });
    expect(coverageFails(verdict, false, true)).toBe(false);
  });

  it('fails any missing type in strict mode, the Core 2.0.0 parity mode, provided or not', () => {
    const verdict = typeCoverageOf([report('Property', metExcept('date', []))]);
    expect(coverageFails(verdict, true, true)).toBe(true);
    expect(coverageFailureReasons(verdict, true)).toEqual(['Full coverage required but missing types: date']);
  });

  it('is never a coverage failure when no record was tested: nothing was measured, and the run fails for that', () => {
    const verdict = typeCoverageOf([]);
    expect(coverageFails(verdict, true, false)).toBe(false);
    expect(coverageFails(verdict, false, false)).toBe(false);
  });

  /**
   * What must not be lost for an MLS (Josh, 2026-11-12): its Property resource carries all six types, so all six are
   * provided and all six must be met. "The rule for MLSs is still full coverage, if possible, on Core."
   */
  it('requires all six types of an MLS whose Property resource carries them, and fails a run that misses one', () => {
    const properties = [
      prop('ListingKey', 'Edm.String'),
      prop('BedroomsTotal', 'Edm.Int32'),
      prop('ListPrice', 'Edm.Decimal'),
      prop('ListingContractDate', 'Edm.Date'),
      prop('ModificationTimestamp', 'Edm.DateTimeOffset'),
      prop('StandardStatus', 'Edm.String', 'StandardStatus'),
      prop('InteriorFeatures', 'Collection(Edm.String)', 'InteriorFeatures')
    ];
    const records = [
      {
        ListingKey: '1',
        BedroomsTotal: 3,
        ListPrice: 350000,
        ListingContractDate: '2026-10-01',
        ModificationTimestamp: '2026-10-02T00:00:00Z',
        StandardStatus: 'Active',
        InteriorFeatures: ['Pantry', 'Elevator']
      }
    ];
    const provided = providedTypesOf(properties, records, enums);
    expect(provided.map(each => each.type)).toEqual(['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup']);

    const coverage = (missing: string): ReadonlyArray<TypeCoverage> =>
      provided.map(({ type, fields }) => ({ type, field: fields[0], hasData: type !== missing, providedBy: fields }));
    for (const missing of ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup']) {
      const verdict = typeCoverageOf([report('Property', coverage(missing))]);
      expect(coverageFails(verdict, false, true), missing).toBe(true);
    }
    expect(coverageFails(typeCoverageOf([report('Property', coverage('none'))]), false, true)).toBe(false);
  });

  it('names at most three providing fields in the reason, and counts the rest', () => {
    const verdict = typeCoverageOf([report('Property', metExcept('integer', ['A', 'B', 'C', 'D', 'E']))]);
    expect(coverageFailureReasons(verdict, false)[0]).toContain('Property.A, Property.B, Property.C and 2 more');
  });
});
