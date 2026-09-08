import { describe, it, expect } from 'vitest';
import { buildLookupUrl, buildScenarioQuery, originatingSystemFilterClause } from '../../src/web-api-core/queries.js';
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

  it('buildLookupUrl selects ALL columns (no $select) — cannot 400 on an undeclared StandardLookupValue/LegacyODataValue', () => {
    // Core does not gate on StandardLookupValue (a DD concern); $select-ing an undeclared column 400s the whole
    // scenario and cascade-skips the dependent string-enum/in tests. Select-all still returns SLV/LegacyODataValue
    // when present, and can never 400 on their absence. buildLookupUrl is the single source of this shape, used by
    // the runner's per-candidate presence fetch (`validateStringLookupCandidate`).
    const decoded = decodeURIComponent(buildLookupUrl('http://localhost:8080', 'StandardStatus'));
    expect(decoded).toBe("http://localhost:8080/Lookup?$filter=LookupName eq 'StandardStatus'");
    expect(decoded).not.toContain('$select');
  });
});

describe('buildScenarioQuery — OriginatingSystem (OSN/OSID) scoping', () => {
  const filterScenario: FilterScenario = { tag: 'filter-int-gt', name: 'Int gt', category: 'filter', dataType: 'integer', op: 'gt', fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0' };
  const osnParams: TestParams = { ...baseParams, originatingSystemName: 'MyMLS' };
  const query = (scenario: CoreScenario, params: TestParams): string =>
    decodeURIComponent(buildScenarioQuery('http://localhost:8080', 'Property', scenario, params)?.url ?? '');

  it('ANDs OriginatingSystemName into a resource-data filter query (original predicate preserved)', () => {
    const decoded = query(filterScenario, osnParams);
    expect(decoded).toContain('(ListPrice gt 200000) and OriginatingSystemName eq \'MyMLS\'');
  });

  it('is inert when no OriginatingSystem is configured (zero behavior change)', () => {
    const without = query(filterScenario, baseParams);
    expect(without).not.toContain('OriginatingSystem');
    expect(query(filterScenario, osnParams)).not.toEqual(without);
  });

  it('uses OriginatingSystemID when only OSID is set; OSN takes precedence when both are set', () => {
    expect(query(filterScenario, { ...baseParams, originatingSystemId: 'MLS-42' })).toContain('OriginatingSystemID eq \'MLS-42\'');
    const both = query(filterScenario, { ...baseParams, originatingSystemName: 'MyMLS', originatingSystemId: 'MLS-42' });
    expect(both).toContain('OriginatingSystemName eq \'MyMLS\'');
    expect(both).not.toContain('OriginatingSystemID');
  });

  it('does NOT scope a non-resource-data category (fetch-by-key / structural, /Lookup, error)', () => {
    const fetch: StructuralScenario = { tag: 'fetch-by-key', name: 'Fetch', category: 'structural', assertion: 'fetch-by-key', minVersion: '2.0.0' };
    const err: ErrorScenario = { tag: 'response-code-404', name: '404', category: 'error', expectedStatus: 404, minVersion: '2.0.0' };
    expect(query(fetch, osnParams)).not.toContain('OriginatingSystem');
    expect(query(err, osnParams)).not.toContain('OriginatingSystem');
  });

  it('adds a $filter when the scoped query has none (orderby without a filter)', () => {
    const scenario: OrderByScenario = { tag: 'orderby-timestamp-asc', name: 'Orderby', category: 'orderby', fieldParam: 'timestampField', direction: 'asc', minVersion: '2.0.0' };
    const decoded = query(scenario, osnParams);
    expect(decoded).toContain('$orderby=ModificationTimestamp asc');
    expect(decoded).toContain('$filter=OriginatingSystemName eq \'MyMLS\'');
  });

  it('escapes single quotes in the OriginatingSystem value (OData string literal)', () => {
    expect(query(filterScenario, { ...baseParams, originatingSystemName: 'O\'Brien MLS' })).toContain('OriginatingSystemName eq \'O\'\'Brien MLS\'');
  });
});

describe('originatingSystemFilterClause — shared OSN/OSID clause builder', () => {
  it('prefers OSN over OSID, falls back to OSID, and is empty when neither is set', () => {
    expect(originatingSystemFilterClause('MyMLS', 'MLS-42')).toBe("OriginatingSystemName eq 'MyMLS'");
    expect(originatingSystemFilterClause(undefined, 'MLS-42')).toBe("OriginatingSystemID eq 'MLS-42'");
    expect(originatingSystemFilterClause(undefined, undefined)).toBe('');
    expect(originatingSystemFilterClause('', '')).toBe('');
  });

  it('escapes single quotes (OData 4.01 string literal)', () => {
    expect(originatingSystemFilterClause("O'Brien MLS")).toBe("OriginatingSystemName eq 'O''Brien MLS'");
  });
});
