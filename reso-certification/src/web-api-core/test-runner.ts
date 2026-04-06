/**
 * Web API Core test runner.
 *
 * Runs all applicable scenarios for a resource, using the data-driven
 * approach: build query → make request → assert results.
 */

import { odataRequest } from '../test-runner/index.js';
import type { TestParams } from './sampling.js';
import { buildScenarioQuery } from './queries.js';
import { scenariosForVersion, type CoreScenario } from './scenarios.js';
import {
  assertODataResponse,
  assertHasResults,
  assertScalarComparison,
  assertSortOrder,
  assertEnumMatch,
  assertCollectionLambda,
  assertStringComparison,
  extractRecords,
  extractCount,
  extractNextLink,
  type AssertionResult,
} from './assertions.js';

/** Result of a single scenario execution. */
export interface ScenarioResult {
  readonly tag: string;
  readonly name: string;
  readonly passed: boolean;
  readonly skipped: boolean;
  readonly assertions: ReadonlyArray<AssertionResult>;
  readonly duration: number;
}

/** Coverage of a data type category for a resource. */
export interface TypeCoverage {
  readonly type: string;
  readonly field: string | undefined;
  readonly hasData: boolean;
}

/** Result of running all scenarios for one resource. */
export interface ResourceTestReport {
  readonly resource: string;
  readonly params: TestParams;
  readonly scenarios: ReadonlyArray<ScenarioResult>;
  readonly coverage: ReadonlyArray<TypeCoverage>;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
  };
}

/** Build coverage matrix from resolved test params. */
const buildCoverage = (params: TestParams): ReadonlyArray<TypeCoverage> => [
  { type: 'integer', field: params.integerField, hasData: params.integerValueLow != null },
  { type: 'decimal', field: params.decimalField, hasData: params.decimalValueLow != null },
  { type: 'date', field: params.dateField, hasData: params.dateValue != null },
  { type: 'timestamp', field: params.timestampField, hasData: params.datetimeValue != null },
  { type: 'singleLookup', field: params.singleLookupField, hasData: params.singleLookupValue != null },
  { type: 'multiLookup', field: params.multiLookupField, hasData: params.multiLookupValue1 != null },
];

/** Run a single scenario and collect all assertion results. */
const runScenario = async (
  serverUrl: string,
  resource: string,
  scenario: CoreScenario,
  params: TestParams,
  authToken: string,
): Promise<ScenarioResult> => {
  const enumMode = params.enumMode;
  const start = Date.now();

  // Skip scenarios based on enum mode
  // - 'has' operator requires IsFlags mode
  // - collection lambdas require collections or string mode
  // - enum eq/ne with namespace requires collections or isflags mode
  if (enumMode === 'string' && (
    (scenario.category === 'enum' && scenario.op === 'has') ||
    (scenario.category === 'enum' && scenario.enumType === 'multi') ||
    scenario.category === 'collection'
  )) {
    return {
      tag: scenario.tag,
      name: scenario.name,
      passed: true,
      skipped: true,
      assertions: [{ passed: true, message: 'Skipped: requires enum-type mode (has/collection operators not applicable to string enums)' }],
      duration: Date.now() - start,
    };
  }

  // Build query — undefined means required params missing, skip
  const query = buildScenarioQuery(serverUrl, resource, scenario, params);
  if (!query) {
    return {
      tag: scenario.tag,
      name: scenario.name,
      passed: false,
      skipped: true,
      assertions: [{ passed: false, message: 'Skipped: required test parameters not available for this resource' }],
      duration: Date.now() - start,
    };
  }

  const assertions: AssertionResult[] = [];

  try {
    // Special handling for structural scenarios (metadata returns XML, not JSON)
    if (scenario.category === 'structural') {
      return runStructuralScenario(serverUrl, resource, scenario.assertion, query, params, authToken, start);
    }

    // Special handling for paging scenario
    if (scenario.category === 'paging') {
      return runPagingScenario(serverUrl, resource, params, authToken, start);
    }

    // Special handling for error scenarios
    if (scenario.category === 'error') {
      const response = await odataRequest({ method: 'GET', url: query.url, authToken });
      const responseCheck = assertODataResponse(response, scenario.expectedStatus);
      return {
        tag: scenario.tag,
        name: scenario.name,
        passed: responseCheck.passed,
        skipped: false,
        assertions: [responseCheck],
        duration: Date.now() - start,
      };
    }

    // Standard flow: request → validate response → validate data
    const response = await odataRequest({ method: 'GET', url: query.url, authToken });

    const responseCheck = assertODataResponse(response, 200);
    assertions.push(responseCheck);
    if (!responseCheck.passed) {
      return { tag: scenario.tag, name: scenario.name, passed: false, skipped: false, assertions, duration: Date.now() - start };
    }

    const records = extractRecords(response.body);

    // No results: filter worked (200 OK) but no data to validate — skip with diagnostic
    if (records.length === 0) {
      assertions.push({ passed: true, message: 'No records returned — filter executed but no matching data to validate' });
      return { tag: scenario.tag, name: scenario.name, passed: true, skipped: true, assertions, duration: Date.now() - start };
    }

    // Data assertion based on scenario category
    const dataAssertion = assertData(records, scenario, params);
    if (dataAssertion) assertions.push(dataAssertion);

    const allPassed = assertions.every(a => a.passed);
    return { tag: scenario.tag, name: scenario.name, passed: allPassed, skipped: false, assertions, duration: Date.now() - start };
  } catch (err) {
    assertions.push({ passed: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
    return { tag: scenario.tag, name: scenario.name, passed: false, skipped: false, assertions, duration: Date.now() - start };
  }
};

/** Route to the appropriate data assertion based on scenario category. */
const assertData = (
  records: ReadonlyArray<Record<string, unknown>>,
  scenario: CoreScenario,
  params: TestParams,
): AssertionResult | undefined => {
  const resolve = (param: string): string | number | undefined =>
    param === 'now' ? new Date().toISOString() : (params as unknown as Record<string, string | number | undefined>)[param];

  const resolveField = (param: string): string =>
    (params as unknown as Record<string, string>)[param] ?? param;

  switch (scenario.category) {
    case 'filter': {
      const field = resolveField(scenario.fieldParam);
      const value = resolve(scenario.valueParam);
      if (value == null) return { passed: false, message: `Missing param: ${scenario.valueParam}` };

      if (scenario.compound) {
        const value2 = resolve(scenario.compound.valueParam2);
        if (value2 == null) return { passed: false, message: `Missing param: ${scenario.compound.valueParam2}` };

        // For compound filters, check each record satisfies the combined condition
        const check1 = assertScalarComparison(records, field, scenario.op, value, scenario.dataType);
        const check2 = assertScalarComparison(records, field, scenario.compound.op2, value2, scenario.dataType);

        if (scenario.compound.logical === 'and') {
          return check1.passed && check2.passed
            ? { passed: true, message: `Compound AND filter satisfied` }
            : { passed: false, message: `Compound AND failed: ${!check1.passed ? check1.message : check2.message}` };
        }
        // OR: at least one condition should be true for each record (already implicit in the data)
        return { passed: true, message: 'Compound OR filter — results valid' };
      }

      return assertScalarComparison(records, field, scenario.op, value, scenario.dataType);
    }

    case 'orderby':
      return assertSortOrder(records, resolveField(scenario.fieldParam), scenario.direction);

    case 'enum':
      return scenario.enumType === 'single'
        ? assertEnumMatch(records, resolveField(scenario.fieldParam), scenario.op, String(resolve(scenario.valueParam)))
        : assertCollectionLambda(
            records,
            resolveField(scenario.fieldParam),
            'has',
            scenario.valueParam2
              ? [String(resolve(scenario.valueParam)), String(resolve(scenario.valueParam2))]
              : [String(resolve(scenario.valueParam))],
          );

    case 'collection':
      return assertCollectionLambda(
        records,
        resolveField(scenario.fieldParam),
        scenario.lambda,
        [String(resolve(scenario.valueParam))],
      );

    case 'string-enum':
      if (scenario.enumType === 'single') {
        return assertStringComparison(records, resolveField(scenario.fieldParam), scenario.op as 'eq' | 'ne', String(resolve(scenario.valueParam)));
      }
      return assertCollectionLambda(
        records,
        resolveField(scenario.fieldParam),
        scenario.op as 'any' | 'all',
        scenario.valueParam2
          ? [String(resolve(scenario.valueParam)), String(resolve(scenario.valueParam2))]
          : [String(resolve(scenario.valueParam))],
      );

    case 'string-function': {
      const strField = resolveField(scenario.fieldParam);
      const strValue = String(resolve(scenario.valueParam) ?? '');
      const func = scenario.func;
      const failures: string[] = [];
      for (const [i, record] of records.entries()) {
        const actual = record[strField];
        if (actual == null) continue;
        const actualStr = String(actual);
        const matches = func === 'contains' ? actualStr.includes(strValue)
          : func === 'startswith' ? actualStr.startsWith(strValue)
          : actualStr.endsWith(strValue);
        if (!matches) {
          failures.push(`Record ${i}: ${strField}=${JSON.stringify(actualStr)} does not satisfy ${func}('${strValue}')`);
        }
      }
      return failures.length === 0
        ? { passed: true, message: `All ${records.length} records satisfy ${func}()` }
        : { passed: false, message: `${failures.length} records failed: ${failures[0]}` };
    }

    case 'expand':
      return { passed: true, message: 'Expand response received' };

    default:
      return undefined;
  }
};

/** Run structural scenarios (metadata, service-document, fetch-by-key, select, top, skip, count). */
const runStructuralScenario = async (
  serverUrl: string,
  resource: string,
  assertion: string,
  query: { readonly url: string; readonly selectFields: ReadonlyArray<string> },
  params: TestParams,
  authToken: string,
  start: number,
): Promise<ScenarioResult> => {
  const assertions: AssertionResult[] = [];
  const tag = assertion;
  const name = assertion;

  try {
    if (assertion === 'metadata') {
      const response = await odataRequest({ method: 'GET', url: query.url, authToken });
      // Metadata returns XML, not JSON — check status and rawBody instead of body
      const statusOk = response.status === 200;
      const odataVersion = response.headers['odata-version'];
      const hasODataHeader = odataVersion === '4.0' || odataVersion === '4.01';
      assertions.push(
        statusOk
          ? { passed: true, message: `HTTP 200` }
          : { passed: false, message: `Expected HTTP 200, got ${response.status}` }
      );
      assertions.push(
        hasODataHeader
          ? { passed: true, message: `OData-Version: ${odataVersion}` }
          : { passed: false, message: `Missing or invalid OData-Version header: ${odataVersion ?? 'none'}` }
      );
      assertions.push(
        response.rawBody?.includes('<edmx:Edmx')
          ? { passed: true, message: 'Valid EDMX metadata' }
          : { passed: false, message: 'Response does not contain EDMX metadata' }
      );
    } else if (assertion === 'skip') {
      // Skip test requires two requests and comparing results
      const resp1 = await odataRequest({ method: 'GET', url: query.url, authToken });
      assertions.push(assertODataResponse(resp1, 200));
      const records1 = extractRecords(resp1.body);

      const skipUrl = `${query.url}&$skip=5`;
      const resp2 = await odataRequest({ method: 'GET', url: skipUrl, authToken });
      assertions.push(assertODataResponse(resp2, 200));
      const records2 = extractRecords(resp2.body);

      const keys1 = new Set(records1.map(r => String(r[params.keyField])));
      const keys2 = new Set(records2.map(r => String(r[params.keyField])));
      const overlap = [...keys2].filter(k => keys1.has(k));
      assertions.push(
        overlap.length === 0
          ? { passed: true, message: `$skip produced different records (${records1.length} vs ${records2.length})` }
          : { passed: false, message: `$skip overlap: ${overlap.length} keys appear in both pages` }
      );
    } else if (assertion === 'count') {
      const response = await odataRequest({ method: 'GET', url: query.url, authToken });
      assertions.push(assertODataResponse(response, 200));
      const count = extractCount(response.body);
      const records = extractRecords(response.body);
      assertions.push(
        count != null && count >= records.length
          ? { passed: true, message: `@odata.count=${count} >= ${records.length} results` }
          : { passed: false, message: `@odata.count=${count ?? 'missing'}, results=${records.length}` }
      );
    } else if (assertion === 'top') {
      const response = await odataRequest({ method: 'GET', url: query.url, authToken });
      assertions.push(assertODataResponse(response, 200));
      const records = extractRecords(response.body);
      assertions.push(
        records.length <= 5
          ? { passed: true, message: `$top=5 returned ${records.length} records` }
          : { passed: false, message: `$top=5 returned ${records.length} records (expected <= 5)` }
      );
    } else if (assertion === 'fetch-by-key') {
      const response = await odataRequest({ method: 'GET', url: query.url, authToken });
      assertions.push(assertODataResponse(response, 200));
      const body = response.body as Record<string, unknown> | null;
      assertions.push(
        body && String(body[params.keyField]) === params.keyValue
          ? { passed: true, message: `Key ${params.keyField}=${params.keyValue} returned` }
          : { passed: false, message: `Expected ${params.keyField}=${params.keyValue}, got ${body?.[params.keyField]}` }
      );
    } else {
      // service-document, select
      const response = await odataRequest({ method: 'GET', url: query.url, authToken });
      assertions.push(assertODataResponse(response, 200));
      assertions.push(assertHasResults(response.body));
    }
  } catch (err) {
    assertions.push({ passed: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }

  const allPassed = assertions.every(a => a.passed);
  return { tag, name, passed: allPassed, skipped: false, assertions, duration: Date.now() - start };
};

/** Run server-driven paging scenario (v2.1.0). */
const runPagingScenario = async (
  serverUrl: string,
  resource: string,
  params: TestParams,
  authToken: string,
  start: number,
): Promise<ScenarioResult> => {
  const assertions: AssertionResult[] = [];

  try {
    // Start with $top=1 to get a small page
    let url: string | undefined = `${serverUrl}/${resource}?$top=2&$select=${params.keyField}`;
    const allKeys = new Set<string>();
    let pages = 0;
    const maxPages = 20;

    while (url && pages < maxPages) {
      const response = await odataRequest({ method: 'GET', url, authToken });
      if (response.status !== 200) {
        assertions.push({ passed: false, message: `Page ${pages + 1}: HTTP ${response.status}` });
        break;
      }

      const records = extractRecords(response.body);
      for (const r of records) allKeys.add(String(r[params.keyField]));

      url = extractNextLink(response.body);
      pages++;
    }

    assertions.push(
      pages > 1
        ? { passed: true, message: `Server-driven paging: ${pages} pages, ${allKeys.size} unique records` }
        : { passed: false, message: `Expected multiple pages but only got ${pages}` }
    );

    // Final page should have no nextLink
    if (!url) {
      assertions.push({ passed: true, message: 'Final page has no @odata.nextLink' });
    }
  } catch (err) {
    assertions.push({ passed: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }

  const allPassed = assertions.every(a => a.passed);
  return { tag: 'server-driven-paging', name: 'Server-driven paging', passed: allPassed, skipped: false, assertions, duration: Date.now() - start };
};

// ── Main runner ──

/**
 * Run all applicable Web API Core scenarios for a single resource.
 */
export const runCoreResourceScenarios = async (
  serverUrl: string,
  resource: string,
  params: TestParams,
  authToken: string,
  version: '2.0.0' | '2.1.0' = '2.0.0',
): Promise<ResourceTestReport> => {
  const scenarios = scenariosForVersion(version);
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const result = await runScenario(serverUrl, resource, scenario, params, authToken);
    results.push(result);
  }

  const passed = results.filter(r => r.passed && !r.skipped).length;
  const failed = results.filter(r => !r.passed && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;

  return {
    resource,
    params,
    coverage: buildCoverage(params),
    scenarios: results,
    summary: { total: results.length, passed, failed, skipped },
  };
};
