import { describe, it, expect } from 'vitest';
import { buildScenarioQuery } from '../../src/web-api-core/queries.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import type { CoreScenario, FilterScenario, OrderByScenario, ErrorScenario, StructuralScenario } from '../../src/web-api-core/scenarios.js';

const baseParams: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: 'ABC123',
  integerField: 'ListPrice',
  integerValueLow: 200000,
  integerValueHigh: 2147483647,
  integerNotSentinel: -1,
  decimalField: 'Latitude',
  decimalValueLow: 40.7,
  decimalValueHigh: 40.7,
  dateField: 'ListDate',
  dateValue: '2024-06-15',
  timestampField: 'ModificationTimestamp',
  datetimeValue: '2024-06-15T10:30:00Z',
  singleLookupField: 'StandardStatus',
  singleLookupValue: 'Active',
  multiLookupField: 'AccessibilityFeatures',
  multiLookupValue1: 'Pool',
  multiLookupValue2: 'Garage',
  sampleComplete: true,
  skippedTypes: [],
};

describe('buildScenarioQuery', () => {
  it('builds metadata URL', () => {
    const scenario: StructuralScenario = { tag: 'metadata-validation', name: 'Metadata', category: 'structural', assertion: 'metadata', minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.url).toBe('http://localhost:8080/$metadata');
  });

  it('builds fetch-by-key URL', () => {
    const scenario: StructuralScenario = { tag: 'fetch-by-key', name: 'Fetch', category: 'structural', assertion: 'fetch-by-key', minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.url).toContain("Property('ABC123')");
  });

  it('builds integer filter URL', () => {
    const scenario: FilterScenario = { tag: 'filter-int-gt', name: 'Int gt', category: 'filter', dataType: 'integer', op: 'gt', fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.url).toContain('$filter=');
    expect(result?.url).toContain('ListPrice');
    expect(result?.url).toContain('200000');
  });

  it('builds compound filter URL', () => {
    const scenario: FilterScenario = { tag: 'filter-int-and', name: 'Int and', category: 'filter', dataType: 'integer', op: 'gt', fieldParam: 'integerField', valueParam: 'integerValueLow', compound: { op2: 'lt', valueParam2: 'integerValueHigh', logical: 'and' }, minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.url).toContain('and');
  });

  it('builds the not() filter as not(field <op> <sentinel>) — the -1 sentinel returns every non-negative record', () => {
    // `not(ListPrice le -1)` = ListPrice > -1 = all records (prices are non-negative) → guaranteed non-empty,
    // so an empty result is a determinate operator defect. The builder must honor scenario.op (le), not eq.
    const scenario: FilterScenario = { tag: 'filter-int-not', name: 'Int not()', category: 'filter', dataType: 'integer', op: 'le', fieldParam: 'integerField', valueParam: 'integerNotSentinel', negated: true, minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result && decodeURIComponent(result.url)).toContain('not(ListPrice le -1)');
  });

  it('builds orderby URL', () => {
    const scenario: OrderByScenario = { tag: 'orderby-timestamp-asc', name: 'Orderby', category: 'orderby', fieldParam: 'timestampField', direction: 'asc', minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.url).toContain('$orderby=ModificationTimestamp asc');
  });

  it('builds error 400 URL', () => {
    const scenario: ErrorScenario = { tag: 'response-code-400', name: '400', category: 'error', expectedStatus: 400, minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.url).toContain('INVALIDFIELD');
  });

  it('builds error 404 URL', () => {
    const scenario: ErrorScenario = { tag: 'response-code-404', name: '404', category: 'error', expectedStatus: 404, minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.url).toContain('ResourceNotFound');
  });

  it('returns undefined when required param is missing', () => {
    const paramsNoInt: TestParams = { ...baseParams, integerField: undefined };
    const scenario: FilterScenario = { tag: 'filter-int-gt', name: 'Int gt', category: 'filter', dataType: 'integer', op: 'gt', fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, paramsNoInt);
    expect(result).toBeUndefined();
  });

  it('includes select fields in query', () => {
    const scenario: FilterScenario = { tag: 'filter-int-eq', name: 'Int eq', category: 'filter', dataType: 'integer', op: 'eq', fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.selectFields).toContain('ListingKey');
    expect(result?.selectFields).toContain('ListPrice');
  });

  it('builds count URL', () => {
    const scenario: StructuralScenario = { tag: 'count', name: 'Count', category: 'structural', assertion: 'count', minVersion: '2.0.0' };
    const result = buildScenarioQuery('http://localhost:8080', 'Property', scenario, baseParams);
    expect(result?.url).toContain('$count=true');
  });
});
