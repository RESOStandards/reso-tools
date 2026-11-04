import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import type { EnumCandidate } from '../../src/web-api-core/enum-selection.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { scenariosForVersion } from '../../src/web-api-core/scenarios.js';
import { runEnumFamilyScenario } from '../../src/web-api-core/test-runner.js';

/**
 * A multi-valued test is filled in with both values, or it moves to the next field (Josh, 2026-11-03: "we need to
 * always try and fill in both multi values on the multi tests, otherwise go to the next field"). The case is FBS's
 * Core 2.1.0 run for Heart of Missouri: RentIncludes held only `None`, while InteriorFeatures held two values.
 */

const oneValue: EnumCandidate = {
  field: 'RentIncludes',
  representation: 'COLLECTION_STRING',
  isStandard: true,
  values: ['None'],
  lookupSampleValues: ['None'],
  distinctValueCount: 1,
  fillRate: 1,
  subsetSampleValues: ['None']
};
const twoValues: EnumCandidate = {
  field: 'InteriorFeatures',
  representation: 'COLLECTION_STRING',
  isStandard: true,
  values: ['Garden Bath', 'Outside Shower'],
  lookupSampleValues: ['Garden Bath', 'Outside Shower'],
  distinctValueCount: 5,
  fillRate: 0.9,
  subsetSampleValues: ['Garden Bath', 'Outside Shower']
};

// The one-value field first, as the old ranking put it, so the runner has to move past it.
const params: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
  multiLookupField: oneValue.field,
  multiLookupValue1: 'None',
  multiLookupFieldRep: 'COLLECTION_STRING',
  multiLookupSubsetValues: ['None'],
  multiLookupCandidates: [oneValue, twoValues]
};

/** A server that answers every query with one record holding both fields, and remembers what it was asked. */
const recording = () => {
  const filters: string[] = [];
  const requester: ODataRequester = {
    request: async (options): Promise<ODataResponse> => {
      filters.push(decodeURIComponent(new URL(options.url).searchParams.get('$filter') ?? ''));
      return {
        status: 200,
        headers: { 'odata-version': '4.01' },
        body: { value: [{ ListingKey: '1', RentIncludes: ['None'], InteriorFeatures: ['Garden Bath', 'Outside Shower'] }] },
        rawBody: ''
      };
    }
  };
  return { filters, requester };
};

const twoValueMultiScenarios = scenariosForVersion('2.1.0').filter(
  s => 'valueParam2' in s && s.valueParam2 === 'multiLookupValue2' && 'category' in s && s.category === 'string-enum'
);

describe('a multi-valued test that takes two values', () => {
  it('has the string-collection scenarios to check', () => {
    expect(twoValueMultiScenarios.map(s => s.tag).sort()).toEqual(['filter-string-enum-multi-all', 'filter-string-enum-multi-any']);
  });

  it.each(twoValueMultiScenarios.map(s => [s.tag, s] as const))(
    '%s runs on the field with both values, never the one-value field',
    async (_tag, scenario) => {
      const { filters, requester } = recording();
      const op = scenario.tag.endsWith('all') ? 'all' : 'any';
      const result = await runEnumFamilyScenario('http://x', 'Property', scenario, params, 'tok', 0, op, requester);
      expect(filters.length).toBeGreaterThan(0);
      expect(filters.every(f => !f.includes('RentIncludes'))).toBe(true);
      expect(filters.at(-1)).toContain('InteriorFeatures');
      expect(filters.at(-1)).toContain("'Garden Bath'");
      expect(filters.at(-1)).toContain("'Outside Shower'");
      expect(result.skipped).not.toBe(true);
    }
  );
});
