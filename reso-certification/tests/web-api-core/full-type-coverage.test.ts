import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import { describe, expect, it } from 'vitest';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import type { EntityProperty } from '../../src/test-runner/types.js';
import { isMultiRep, isSingleRep, selectEnumCandidates } from '../../src/web-api-core/enum-selection.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { buildStandardMapFrom } from '../../src/web-api-core/standard-map.js';
import { type TypeCoverage, buildCoverage } from '../../src/web-api-core/test-runner.js';
import { typeCoverageOf } from '../../src/web-api-core/type-coverage.js';

/**
 * Full type coverage (Josh, 2026-11-03): every data type the Core tests exercise, met on some field of some resource
 * tested. Every run measures it and its report says whether it was achieved, and the run reaches for it: a field that
 * cannot give a type its tests is not picked over one that can. Core 2.0.0 counts Property alone, the Commander's scope.
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
  it('on Core 2.1.0, takes each type from any resource tested: none has to carry all of them', () => {
    const verdict = typeCoverageOf([without(allMet('Property'), 'multiLookup'), without(allMet('Member'), 'decimal')], '2.1.0');
    expect(verdict).toEqual({
      coveredTypes: ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'],
      missingTypes: [],
      fullCoverage: true
    });
  });

  it('on Core 2.1.0, misses a type that no resource tested met', () => {
    const verdict = typeCoverageOf([without(allMet('Property'), 'multiLookup'), without(allMet('Member'), 'multiLookup')], '2.1.0');
    expect(verdict).toMatchObject({ missingTypes: ['multiLookup'], fullCoverage: false });
  });

  it('on Core 2.0.0, counts Property alone, as the Commander tested it', () => {
    const verdict = typeCoverageOf([without(allMet('Property'), 'multiLookup'), allMet('Member')], '2.0.0');
    expect(verdict).toMatchObject({ missingTypes: ['multiLookup'], fullCoverage: false });
    expect(typeCoverageOf([allMet('Property')], '2.0.0').fullCoverage).toBe(true);
  });

  it('on Core 2.0.0, misses every type when Property was not tested', () => {
    expect(typeCoverageOf([allMet('Member')], '2.0.0')).toMatchObject({ coveredTypes: [], fullCoverage: false });
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

  it('is one with two values to test, before a standard field with one', () => {
    expect(select([lookup('RentIncludes', true), lookup('LocalAmenities', true)], isMultiRep)).toEqual(['LocalAmenities', 'RentIncludes']);
  });

  it('is still the one-value field when no field has two, so its other tests still run', () => {
    expect(select([lookup('RentIncludes', true)], isMultiRep)).toEqual(['RentIncludes']);
  });

  it('leaves the single-valued ranking as it was: one value is all a single-valued lookup needs', () => {
    expect(select([lookup('PropertyType', false), lookup('LocalType', false)], isSingleRep)).toEqual(['PropertyType', 'LocalType']);
  });
});
