/**
 * Benchmarks for OData query URL building.
 *
 * Query building happens for every scenario across every resource.
 * These benchmarks ensure URL construction stays fast.
 */

import { bench, describe } from 'vitest';
import { buildScenarioQuery } from '../src/web-api-core/queries.js';
import { scenariosForVersion } from '../src/web-api-core/scenarios.js';
import type { TestParams } from '../src/web-api-core/sampling.js';

const testParams: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: 'abc-123-def',
  enumMode: 'string',
  integerField: 'ListPrice',
  integerValueLow: 200000,
  integerValueHigh: 2147483647,
  decimalField: 'Latitude',
  decimalValueLow: 40.7,
  decimalValueHigh: 40.7,
  dateField: 'ListDate',
  dateValue: '2024-06-15',
  timestampField: 'ModificationTimestamp',
  datetimeValue: '2024-06-15T10:30:00Z',
  singleLookupField: 'StandardStatus',
  singleLookupValue: 'Active',
  multiLookupField: 'Features',
  multiLookupValue1: 'Pool',
  multiLookupValue2: 'Garage',
  stringField: 'City',
  stringValue: 'Austi',
  skippedTypes: [],
};

const scenarios = scenariosForVersion('2.0.0');

describe('buildScenarioQuery', () => {
  bench('single filter scenario', () => {
    const scenario = scenarios.find(s => s.tag === 'filter-int-gt')!;
    buildScenarioQuery('http://localhost:8080', 'Property', scenario, testParams);
  });

  bench('compound filter scenario', () => {
    const scenario = scenarios.find(s => s.tag === 'filter-int-and')!;
    buildScenarioQuery('http://localhost:8080', 'Property', scenario, testParams);
  });

  bench('orderby scenario', () => {
    const scenario = scenarios.find(s => s.tag === 'orderby-timestamp-asc')!;
    buildScenarioQuery('http://localhost:8080', 'Property', scenario, testParams);
  });

  bench('all 45 v2.0.0 scenarios', () => {
    for (const scenario of scenarios) {
      buildScenarioQuery('http://localhost:8080', 'Property', scenario, testParams);
    }
  });

  bench('all v2.1.0 scenarios', () => {
    const v21 = scenariosForVersion('2.1.0');
    for (const scenario of v21) {
      buildScenarioQuery('http://localhost:8080', 'Property', scenario, testParams);
    }
  });
});
