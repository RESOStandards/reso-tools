import { describe, expect, it } from 'vitest';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import type { EnumCandidate } from '../../src/web-api-core/enum-selection.js';
import { createLookupCache } from '../../src/web-api-core/lookup-cache.js';
import type { CoreScenario } from '../../src/web-api-core/scenarios.js';
import { buildStandardMapFrom } from '../../src/web-api-core/standard-map.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { type LookupResourceContext, runLookupResourceScenario } from '../../src/web-api-core/test-runner.js';
import type { ODataRequester } from '../../src/test-runner/requester.js';

const ref: DdReference = {
  fields: [{ resourceName: 'Property', fieldName: 'PropertyType', type: 'org.reso.metadata.enums.PropertyType' }],
  lookups: [
    { lookupName: 'org.reso.metadata.enums.PropertyType', lookupValue: 'Residential', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Residential' }] },
  ],
};

const candidate: EnumCandidate = {
  field: 'PropertyType',
  representation: 'SINGLE_STRING',
  isStandard: true,
  values: ['Residential'],
  lookupSampleValues: ['Residential'],
  distinctValueCount: 1,
  fillRate: 1,
  lookupName: 'PropertyType',
};

const params: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
  singleLookupField: 'PropertyType',
  singleLookupCandidates: [candidate],
  lookupNameByField: { PropertyType: 'PropertyType' },
};

const scenario: CoreScenario = {
  tag: 'lookup-resource-validation',
  name: 'Lookup Resource: LookupName and sample values present',
  category: 'lookup-resource',
  assertion: 'lookup-resource-validation',
  fieldParam: 'singleLookupField',
  valueParam: 'singleLookupValue',
  minVersion: '2.1.0',
};

// A requester that FAILS the test if it is ever called — the whole point of a cache hit is that no request goes out.
const throwingRequester: ODataRequester = {
  request: async () => {
    throw new Error('runLookupResourceScenario issued a request on a cache hit — the fetch was not skipped');
  },
};

describe('runLookupResourceScenario — cache hit skips the fetch', () => {
  it('reuses the pre-filled rows, issues no request, and still returns a valid gating result', async () => {
    const cache = createLookupCache({ lookupNameFor: (_res, f) => (f === 'PropertyType' ? 'PropertyType' : undefined) });
    // A prior resource already fetched (and 200-verified) this LookupName's rows.
    cache.put('PropertyType', [{ LookupName: 'PropertyType', LookupValue: 'Residential', StandardLookupValue: 'Residential', LegacyODataValue: 'Residential' }]);

    const lookupCtx: LookupResourceContext = {
      cache,
      standardMap: buildStandardMapFrom(ref),
      isEnumerationIgnored: () => false,
    };

    const result = await runLookupResourceScenario('http://server', 'Property', scenario, params, 'tok', 0, throwingRequester, lookupCtx);

    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(true); // presence (Residential present) + SLV-validity (Residential is DD-standard)
    expect(result.assertions.length).toBe(2); // both gating assertions ran off the cached rows
  });
});
