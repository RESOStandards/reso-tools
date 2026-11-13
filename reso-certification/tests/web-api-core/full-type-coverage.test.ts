import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import { describe, expect, it } from 'vitest';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import type { EntityProperty } from '../../src/test-runner/types.js';
import { declaredCoreType, declaredTypesOf } from '../../src/web-api-core/declared-types.js';
import { isMultiRep, isSingleRep, selectEnumCandidates } from '../../src/web-api-core/enum-selection.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { scenariosForVersion } from '../../src/web-api-core/scenarios.js';
import { buildStandardMapFrom } from '../../src/web-api-core/standard-map.js';
import { type ScenarioResult, type SkipKind, type TypeCoverage, buildCoverage } from '../../src/web-api-core/test-runner.js';
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
      declaredNotMet: [],
      testsNotPassed: []
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
 * All data types are required for Web API Core when the server has them, whether in standard or local fields (Josh,
 * 2026-11-12). "Has" is what the metadata declares, across every element: "if they have the types they have to fail if
 * they don't provide some field that can be sampled with that type"; "if they don't have the type at all it can be
 * skipped", "but we must never have seen them". When scanning cannot meet a declared type, the server names the field,
 * and the reason suggests the most populated ones.
 */
describe('a type the server declares must be met and must pass', () => {
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

  it('counts a declared field whatever its data, empty included, and ranks the fields by population', () => {
    const properties = [
      prop('CloseDate', 'Edm.Date'),
      prop('ListingContractDate', 'Edm.Date'),
      prop('RentIncludes', 'Collection(Edm.String)', 'RentIncludes')
    ];
    const records = [
      { CloseDate: null, ListingContractDate: '2026-10-01', RentIncludes: ['None'] },
      { CloseDate: null, ListingContractDate: '2026-10-02', RentIncludes: ['None'] }
    ];
    expect(declaredTypesOf(properties, records, enums)).toEqual([
      {
        type: 'date',
        fields: [
          { field: 'ListingContractDate', populated: 2 },
          { field: 'CloseDate', populated: 0 }
        ]
      },
      { type: 'multiLookup', fields: [{ field: 'RentIncludes', populated: 2 }] }
    ]);
  });

  const report = (resource: string, coverage: ReadonlyArray<TypeCoverage>, scenarios: ReadonlyArray<ScenarioResult> = []) => ({
    resource,
    coverage,
    scenarios,
    params: { sampleRecordCount: 1000 }
  });
  const metExcept = (missing: string, declaredBy: ReadonlyArray<{ field: string; populated: number }>) =>
    ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'].map(type =>
      type === missing
        ? { type, field: undefined, hasData: false, declaredBy }
        : { type, field: 'F', hasData: true, declaredBy: [{ field: 'F', populated: 1000 }] }
    );

  it('fails a run that could not sample a declared type, and suggests the most populated fields to name', () => {
    const verdict = typeCoverageOf([
      report('Property', metExcept('date', [{ field: 'CloseDate', populated: 0 }])),
      report('Member', metExcept('date', [{ field: 'MemberJoinDate', populated: 640 }]))
    ]);
    expect(verdict.declaredNotMet).toEqual([
      {
        type: 'date',
        fields: [
          { field: 'Member.MemberJoinDate', populated: 640, sampled: 1000 },
          { field: 'Property.CloseDate', populated: 0, sampled: 1000 }
        ]
      }
    ]);
    expect(coverageFails(verdict, false, true)).toBe(true);
    expect(coverageFailureReasons(verdict, false)).toEqual([
      'All data types are required for Web API Core when the server has them, whether in standard or local fields. The server declares date, and the run could not sample a field of it. Name the field to test with --field-overrides (coreOptions.fieldOverrides in a configuration file). Most populated: Member.MemberJoinDate (640 of 1,000 sampled records), Property.CloseDate (0 of 1,000 sampled records)'
    ]);
  });

  it('counts a type seen only on a resource the run did not test, and says to name that resource', () => {
    const verdict = typeCoverageOf(
      [report('Property', metExcept('date', []))],
      [],
      [{ resource: 'Widget', declared: [{ type: 'date', fields: [{ field: 'WidgetDate' }] }] }]
    );
    expect(verdict.declaredNotMet).toEqual([{ type: 'date', fields: [{ field: 'Widget.WidgetDate' }] }]);
    expect(coverageFailureReasons(verdict, false)[0]).toContain(
      'Widget.WidgetDate (its resource was not tested: name it with --resources)'
    );
  });

  it('skips a type the server never declares, and lets the run certify', () => {
    const verdict = typeCoverageOf([report('Property', metExcept('date', []))]);
    expect(verdict).toMatchObject({ missingTypes: ['date'], fullCoverage: false, declaredNotMet: [] });
    expect(coverageFails(verdict, false, true)).toBe(false);
  });

  const scenario = scenariosForVersion('2.1.0').find(each => each.tag === 'filter-date-ne');
  const skipped = (skipKind?: SkipKind): ScenarioResult => ({
    tag: 'filter-date-ne',
    name: 'Date: ne',
    passed: false,
    skipped: true,
    skipReason: 'not conclusively testable',
    ...(skipKind ? { skipKind } : {}),
    assertions: [],
    duration: 0
  });

  it('fails a met type whose required test passed nowhere, naming the test and why', () => {
    expect(scenario).toBeDefined();
    const verdict = typeCoverageOf([report('Property', metExcept('none', []), [skipped()])], scenario ? [scenario] : []);
    expect(verdict.testsNotPassed).toEqual([
      { type: 'date', tag: 'filter-date-ne', name: 'Date: ne', reason: 'not conclusively testable' }
    ]);
    expect(coverageFails(verdict, false, true)).toBe(true);
  });

  it('excuses a test that does not apply to the server, one no resource ran, and one that passed on another resource', () => {
    const scenarios = scenario ? [scenario] : [];
    // Not run at all: a test of a representation the server does not use is never selected for it.
    expect(typeCoverageOf([report('Property', metExcept('none', []))], scenarios).testsNotPassed).toEqual([]);
    expect(typeCoverageOf([report('Property', metExcept('none', []), [skipped('not-applicable')])], scenarios).testsNotPassed).toEqual([]);
    const passedElsewhere = { ...skipped(), skipped: false, passed: true };
    expect(
      typeCoverageOf(
        [report('Property', metExcept('none', []), [skipped()]), report('Member', metExcept('none', []), [passedElsewhere])],
        scenarios
      ).testsNotPassed
    ).toEqual([]);
  });

  it('fails any missing type in strict mode, the Core 2.0.0 parity mode, declared or not', () => {
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
   * declared and all six must be met. "We need to see each type exercised."
   */
  it('requires all six types of an MLS whose Property resource carries them, and fails a run that misses any one', () => {
    const properties = [
      prop('ListingKey', 'Edm.String'),
      prop('BedroomsTotal', 'Edm.Int32'),
      prop('ListPrice', 'Edm.Decimal'),
      prop('ListingContractDate', 'Edm.Date'),
      prop('ModificationTimestamp', 'Edm.DateTimeOffset'),
      prop('StandardStatus', 'Edm.String', 'StandardStatus'),
      prop('InteriorFeatures', 'Collection(Edm.String)', 'InteriorFeatures')
    ];
    const declared = declaredTypesOf(properties, [], enums);
    expect(declared.map(each => each.type)).toEqual(['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup']);

    const coverage = (missing: string): ReadonlyArray<TypeCoverage> =>
      declared.map(({ type, fields }) => ({ type, field: fields[0].field, hasData: type !== missing, declaredBy: fields }));
    for (const missing of ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup']) {
      expect(coverageFails(typeCoverageOf([report('Property', coverage(missing))]), false, true), missing).toBe(true);
    }
    expect(coverageFails(typeCoverageOf([report('Property', coverage('none'))]), false, true)).toBe(false);
  });

  it('suggests at most five fields in the reason, and points to the report for the rest', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((field, index) => ({ field, populated: 100 - index }));
    const reason = coverageFailureReasons(typeCoverageOf([report('Property', metExcept('integer', many))]), false)[0];
    expect(reason).toContain('Property.E (96 of 1,000 sampled records), and 2 more in the report');
  });
});
