import { describe, expect, it } from 'vitest';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import type { EnumCandidate } from '../../src/web-api-core/enum-selection.js';
import { createLookupCache } from '../../src/web-api-core/lookup-cache.js';
import type { CoreScenario } from '../../src/web-api-core/scenarios.js';
import { buildStandardMapFrom } from '../../src/web-api-core/standard-map.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { type LookupResourceContext, runLookupResourceScenario } from '../../src/web-api-core/test-runner.js';
import type { ODataRequester } from '../../src/test-runner/requester.js';

// A4: the Lookup Resource presence check must validate BOTH string forms the provider declares — the single-valued
// SINGLE_STRING field AND the multi-valued COLLECTION_STRING field (each has its OWN LookupName). Spec :100-101
// supply a single- and a multi-valued LookupName + sample values; the check previously validated only the single.

const ref: DdReference = {
  fields: [
    { resourceName: 'Property', fieldName: 'PropertyType', type: 'org.reso.metadata.enums.PropertyType' },
    { resourceName: 'Property', fieldName: 'Appliances', type: 'org.reso.metadata.enums.Appliances' },
  ],
  lookups: [
    { lookupName: 'org.reso.metadata.enums.PropertyType', lookupValue: 'Residential', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Residential' }] },
    { lookupName: 'org.reso.metadata.enums.Appliances', lookupValue: 'Dishwasher', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Dishwasher' }] },
    { lookupName: 'org.reso.metadata.enums.Appliances', lookupValue: 'Microwave', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Microwave' }] },
  ],
};

const singleCandidate: EnumCandidate = {
  field: 'PropertyType',
  representation: 'SINGLE_STRING',
  isStandard: true,
  values: ['Residential'],
  lookupSampleValues: ['Residential'],
  distinctValueCount: 1,
  fillRate: 1,
  lookupName: 'PropertyType',
};

// A multi-valued (Collection(Edm.String)) string lookup — the case A4 adds. Two sample values (spec: multi supplies two).
const multiCandidate: EnumCandidate = {
  field: 'Appliances',
  representation: 'COLLECTION_STRING',
  isStandard: true,
  values: ['Dishwasher', 'Microwave'],
  lookupSampleValues: ['Dishwasher', 'Microwave'],
  distinctValueCount: 2,
  fillRate: 1,
  lookupName: 'Appliances',
};

const paramsWith = (single?: EnumCandidate, multi?: EnumCandidate): TestParams => ({
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
  ...(single && { singleLookupField: single.field, singleLookupCandidates: [single] }),
  ...(multi && { multiLookupField: multi.field, multiLookupCandidates: [multi] }),
  lookupNameByField: {
    ...(single ? { [single.field]: single.lookupName ?? single.field } : {}),
    ...(multi ? { [multi.field]: multi.lookupName ?? multi.field } : {}),
  },
});

const scenario: CoreScenario = {
  tag: 'lookup-resource-validation',
  name: 'Lookup Resource: LookupName and sample values present',
  category: 'lookup-resource',
  assertion: 'lookup-resource-validation',
  fieldParam: 'singleLookupField',
  valueParam: 'singleLookupValue',
  minVersion: '2.1.0',
};

// A /Lookup requester that dispatches by the LookupName in the $filter (apostrophes are not percent-encoded, so the
// raw `'Name'` appears verbatim in the URL). A LookupName with no scripted rows returns an empty 200 (a real gap).
const lookupRequester = (rowsByName: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>): ODataRequester => ({
  request: async ({ url }) => {
    const name = Object.keys(rowsByName).find((n) => url.includes(`'${n}'`));
    const value = name ? rowsByName[name] : [];
    return { status: 200, headers: { 'odata-version': '4.01' }, body: { value }, rawBody: JSON.stringify({ value }) };
  },
});

const ctxFor = (fields: ReadonlyArray<{ field: string; lookupName: string }>, ignored = false): LookupResourceContext => ({
  cache: createLookupCache({ lookupNameFor: (_res, f) => fields.find((x) => x.field === f)?.lookupName }),
  standardMap: buildStandardMapFrom(ref),
  isEnumerationIgnored: () => ignored,
});

const propertyTypeRows = [{ LookupName: 'PropertyType', LookupValue: 'Residential', StandardLookupValue: 'Residential', LegacyODataValue: 'Residential' }];
const appliancesRows = [
  { LookupName: 'Appliances', LookupValue: 'Dishwasher', StandardLookupValue: 'Dishwasher', LegacyODataValue: 'Dishwasher' },
  { LookupName: 'Appliances', LookupValue: 'Microwave', StandardLookupValue: 'Microwave', LegacyODataValue: 'Microwave' },
];

describe('runLookupResourceScenario — validates BOTH the single- and multi-valued string forms (A4)', () => {
  it('single + multi both present and resolvable → PASS, with a presence assertion for EACH LookupName', async () => {
    const ctx = ctxFor([{ field: 'PropertyType', lookupName: 'PropertyType' }, { field: 'Appliances', lookupName: 'Appliances' }]);
    const req = lookupRequester({ PropertyType: propertyTypeRows, Appliances: appliancesRows });
    const result = await runLookupResourceScenario('http://x', 'Property', scenario, paramsWith(singleCandidate, multiCandidate), 'tok', 0, req, ctx);
    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(true);
    // Each fetched form contributes 3 assertions — the /Lookup 200-check + presence + value-report — so two
    // freshly-fetched forms (distinct LookupNames, no cache sharing) = 6; both LookupNames are named.
    expect(result.assertions.length).toBe(6);
    expect(result.assertions.some((a) => a.message.includes("'PropertyType'"))).toBe(true);
    expect(result.assertions.some((a) => a.message.includes("'Appliances'"))).toBe(true);
  });

  it('the MULTI LookupName sample value is absent from /Lookup → FAIL naming the multi field’s missing value (the A4 gap)', async () => {
    const ctx = ctxFor([{ field: 'PropertyType', lookupName: 'PropertyType' }, { field: 'Appliances', lookupName: 'Appliances' }]);
    // Appliances returns only Microwave — the sampled 'Dishwasher' is missing → presence fails for the multi form.
    const req = lookupRequester({ PropertyType: propertyTypeRows, Appliances: [appliancesRows[1]] });
    const result = await runLookupResourceScenario('http://x', 'Property', scenario, paramsWith(singleCandidate, multiCandidate), 'tok', 0, req, ctx);
    expect(result.passed).toBe(false);
    expect(result.assertions.some((a) => !a.passed && a.message.includes('Dishwasher') && a.message.includes("'Appliances'"))).toBe(true);
    // The single form still resolved — the failure is isolated to the multi form.
    expect(result.assertions.some((a) => a.passed && a.message.includes("'PropertyType'"))).toBe(true);
  });

  it('only a multi-valued string form present (no single) → validates it (COLLECTION_STRING alone is testable)', async () => {
    const ctx = ctxFor([{ field: 'Appliances', lookupName: 'Appliances' }]);
    const req = lookupRequester({ Appliances: appliancesRows });
    const result = await runLookupResourceScenario('http://x', 'Property', scenario, paramsWith(undefined, multiCandidate), 'tok', 0, req, ctx);
    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.assertions.some((a) => a.message.includes("'Appliances'"))).toBe(true);
  });

  it('only a single-valued string form present (no multi) → unchanged single-only behavior (regression)', async () => {
    const ctx = ctxFor([{ field: 'PropertyType', lookupName: 'PropertyType' }]);
    const req = lookupRequester({ PropertyType: propertyTypeRows });
    const result = await runLookupResourceScenario('http://x', 'Property', scenario, paramsWith(singleCandidate, undefined), 'tok', 0, req, ctx);
    expect(result.passed).toBe(true);
    expect(result.assertions.length).toBe(3); // one freshly-fetched form → 200-check + presence + value report
  });

  it('neither string form present (enum-typed lookups only) → SKIP', async () => {
    const ctx = ctxFor([]);
    const req = lookupRequester({});
    const result = await runLookupResourceScenario('http://x', 'Property', scenario, paramsWith(undefined, undefined), 'tok', 0, req, ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true); // a skip renders N/A, not a failure
  });
});
