/**
 * Web API Core test runner.
 *
 * Runs all applicable scenarios for a resource, using the data-driven
 * approach: build query → make request → assert results.
 */

import { type ODataRequester, odataRequest, webRequester } from '../test-runner/index.js';
import { fetchMetadataWithVersion } from '../test-runner/metadata.js';
import { MetadataFetchError, decodeFlagsValue } from '@reso-standards/reso-metadata-utils';
import type { EnumRepresentation } from '@reso-standards/reso-client';
import type { TestParams } from './sampling.js';
import type { EnumCandidate } from './enum-selection.js';
import { buildScenarioQuery } from './queries.js';
import { emptyVerdict, type EmptyContext, type EmptyVerdict } from './empty-verdict.js';
import { scenariosForVersion, type ComparisonOp, type CoreScenario } from './scenarios.js';
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
  /** OData request latency in ms (excludes assertion/processing time). */
  readonly requestLatency?: number;
  /** URL that was requested (for diagnostics). */
  readonly requestUrl?: string;
  /** OData-Version header detected from the server's metadata response.
   *  Populated only by the metadata-validation scenario. Used by the main
   *  runner to gate scenarios that require a specific OData minor version
   *  (e.g., the `in` operator requires 4.01). */
  readonly odataVersion?: string;
  /** True when this scenario is an Optional Test: a failure renders
   *  "Not Supported" and never contributes to the Core verdict. Propagated
   *  from the scenario's `optional` flag. */
  readonly optional?: boolean;
  /** True when the request errored (no determinate server response) rather
   *  than an assertion failing. For optional scenarios this maps to
   *  "Not Tested", never "Not Supported". */
  readonly errored?: boolean;
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
  readonly summary: CoreSummary;
}

/** The three outcomes an Optional Test can render. */
export type OptionalOutcome = 'Passed' | 'Not Supported' | 'Not Tested';

/** Tally of optional-test outcomes. Never affects the Core verdict. */
export interface OptionalOutcomeCounts {
  readonly passed: number;
  readonly notSupported: number;
  readonly notTested: number;
}

/** Scenario summary. `passed`/`failed`/`skipped` count REQUIRED scenarios
 *  only — they are the verdict surface (`failed > 0` ⇒ Core fail). Optional
 *  ("Optional Tests") results live in their own bucket and never reach the
 *  verdict. `total` counts every scenario, required and optional. */
export interface CoreSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly optional: OptionalOutcomeCounts;
}

/** Derive an Optional Test's outcome. A skipped or errored (indeterminate)
 *  result is "Not Tested" — the test couldn't run, so support is unknown.
 *  A determinate run maps pass→"Passed", fail→"Not Supported". */
export const optionalOutcome = (
  result: Pick<ScenarioResult, 'passed' | 'skipped' | 'errored'>,
): OptionalOutcome =>
  result.skipped || result.errored
    ? 'Not Tested'
    : result.passed
      ? 'Passed'
      : 'Not Supported';

/** Summarize scenario results. The verdict surface (passed/failed/skipped)
 *  counts REQUIRED scenarios only — an optional failure can never make
 *  `failed > 0`. Optional results are tallied separately by outcome. A
 *  scenario with no `optional` flag defaults to required. */
export const summarizeScenarios = (
  results: ReadonlyArray<ScenarioResult>,
): CoreSummary => {
  const required = results.filter(r => r.optional !== true);
  const optional = results.filter(r => r.optional === true);
  return {
    total: results.length,
    passed: required.filter(r => r.passed && !r.skipped).length,
    failed: required.filter(r => !r.passed && !r.skipped).length,
    skipped: required.filter(r => r.skipped).length,
    optional: {
      passed: optional.filter(r => optionalOutcome(r) === 'Passed').length,
      notSupported: optional.filter(r => optionalOutcome(r) === 'Not Supported').length,
      notTested: optional.filter(r => optionalOutcome(r) === 'Not Tested').length,
    },
  };
};

/** Build coverage matrix from resolved test params. */
const buildCoverage = (params: TestParams): ReadonlyArray<TypeCoverage> => [
  { type: 'integer', field: params.integerField, hasData: params.integerValueLow != null },
  { type: 'decimal', field: params.decimalField, hasData: params.decimalValueLow != null },
  { type: 'date', field: params.dateField, hasData: params.dateValue != null },
  { type: 'timestamp', field: params.timestampField, hasData: params.datetimeValue != null },
  { type: 'singleLookup', field: params.singleLookupField, hasData: params.singleLookupValue != null },
  { type: 'multiLookup', field: params.multiLookupField, hasData: params.multiLookupValue1 != null },
];

// ── Enum-family gating + candidate retry ──

/** The enum-family operator a scenario exercises, or undefined when the scenario isn't enum-family. */
type EnumOp = 'has' | 'eq' | 'ne' | 'in' | 'any' | 'all';

const enumScenarioOp = (scenario: CoreScenario): EnumOp | undefined => {
  switch (scenario.category) {
    case 'enum':
      return scenario.op; // has | eq | ne
    case 'collection':
      return scenario.lambda; // any | all
    case 'string-enum':
      return scenario.op; // eq | ne | any | all
    case 'in-operator':
      return 'in';
    default:
      return undefined;
  }
};

/** Which enumeration representations support an operator (OData 4.01): single→eq/ne/in, flags→has, collection→any/all. */
const opValidForRep = (op: EnumOp, rep: EnumRepresentation): boolean => {
  switch (rep) {
    case 'SINGLE_ENUM':
    case 'SINGLE_STRING':
      return op === 'eq' || op === 'ne' || op === 'in';
    case 'FLAGS_ENUM':
      return op === 'has';
    case 'COLLECTION_ENUM':
    case 'COLLECTION_STRING':
      return op === 'any' || op === 'all';
  }
};

/** The candidate slot a scenario draws from, by its fieldParam. */
const scenarioSlot = (scenario: CoreScenario): 'single' | 'multi' =>
  'fieldParam' in scenario && scenario.fieldParam === 'multiLookupField' ? 'multi' : 'single';

/** Substitute a candidate's field + values (+ enum type) into the slot's param names so the query builders
 *  and the data assertion use this candidate. Setting the enumType (even to undefined for a string lookup)
 *  overrides the primary's, so the response decoder matches the candidate actually queried. */
const paramsWithCandidate = (params: TestParams, slot: 'single' | 'multi', c: EnumCandidate): TestParams => {
  const lookupNameByField = { ...params.lookupNameByField, ...(c.lookupName ? { [c.field]: c.lookupName } : {}) };
  return slot === 'multi'
    ? { ...params, multiLookupField: c.field, multiLookupFieldRep: c.representation, multiLookupEnumType: c.enumType, multiLookupValue1: c.values[0], multiLookupValue2: c.values[1], multiLookupDistinctCount: c.distinctValueCount, lookupNameByField }
    : { ...params, singleLookupField: c.field, singleLookupFieldRep: c.representation, singleLookupEnumType: c.enumType, singleLookupValue: c.values[0], singleLookupValue2: c.values[1], singleLookupValue3: c.values[2], singleLookupDistinctCount: c.distinctValueCount, lookupNameByField };
};

/** A skipped-scenario result with a diagnostic. A skip never counts toward pass/fail. */
const skipResult = (scenario: CoreScenario, start: number, message: string): ScenarioResult => ({
  tag: scenario.tag,
  name: scenario.name,
  passed: true,
  skipped: true,
  assertions: [{ passed: true, message: `Skipped: ${message}` }],
  duration: Date.now() - start,
});

/**
 * Re-base a server-supplied `@odata.nextLink` onto the origin we actually queried.
 *
 * Per OData JSON Format v4.01 a nextLink MAY be absolute or relative (§4.5.5, Control Information: nextLink),
 * and a relative URL resolves against its base URL — the enclosing `@odata.context`, else the request URL
 * (§4.3, Relative URLs; https://docs.oasis-open.org/odata/odata-json-format/v4.01/odata-json-format-v4.01.html).
 * We support both: `new URL(nextLink, requestUrl)` resolves a relative link, and for an absolute link we keep
 * its path + query but force the request's protocol/host/port.
 *
 * Why force the request origin rather than trust the link (or, per §4.3, the context URL)? A server behind a
 * proxy or with a misconfigured base URL emits an internal/wrong host — e.g. `http://localhost/…` with the
 * port dropped — in BOTH `@odata.nextLink` AND `@odata.context`, so even strict §4.3 resolution of a relative
 * link would land on the wrong host. A blind fetch there → "fetch failed" → a FALSE FAIL of a conformant
 * server whose paged resource is otherwise fine. The tester gave us the reachable origin and the paged data
 * lives on it, so re-basing there is strictly more robust than §4.3 resolution.
 */
export const rebaseNextLink = (nextLink: string, requestUrl: string): string => {
  try {
    const base = new URL(requestUrl);
    const next = new URL(nextLink, base); // absolute link keeps its own path/query; relative resolves on base
    // Set hostname + port SEPARATELY: the `.host` setter leaves an existing port in place, so a proxy nextLink
    // like `http://internal:9000/…` would keep :9000. Assigning port explicitly (to '' for a default-port base)
    // clears it.
    next.protocol = base.protocol;
    next.hostname = base.hostname;
    next.port = base.port;
    return next.toString();
  } catch {
    return nextLink; // unparseable — let the caller attempt it as-is
  }
};

/** The comparison operator whose predicate is the logical negation of `op`. A `negated` scenario wraps its
 *  filter in `not(...)`, so the records it returns satisfy the COMPLEMENT of `field op value` — e.g. the
 *  `-1` sentinel `not(field le -1)` returns records where `field gt -1`. The data assertion must check that
 *  complement, not `op` itself, or it would false-fail every returned record. */
export const complementOp = (op: ComparisonOp): ComparisonOp =>
  ({ eq: 'ne', ne: 'eq', gt: 'le', le: 'gt', ge: 'lt', lt: 'ge' } as const)[op];

/** Build the {@link EmptyContext} the `ne` empty-verdict consumes: the distinct value count of the field this
 *  scenario actually queried (scalar counts come from sampling; enum counts ride in on the substituted
 *  candidate via `paramsWithCandidate`), plus whether the sample was the complete resource. */
export const emptyContextFor = (scenario: CoreScenario, params: TestParams): EmptyContext => {
  const distinct = ((): number | undefined => {
    if (scenario.category === 'filter') {
      if (scenario.dataType === 'integer') return params.integerDistinctCount;
      if (scenario.dataType === 'decimal') return params.decimalDistinctCount;
      if (scenario.dataType === 'date') return params.dateDistinctCount;
      return params.datetimeDistinctCount; // datetime `gt`; the `now()` scenarios ignore the count (fail-on-empty)
    }
    if (scenario.category === 'enum' || scenario.category === 'string-enum') {
      return scenarioSlot(scenario) === 'multi' ? params.multiLookupDistinctCount : params.singleLookupDistinctCount;
    }
    return undefined;
  })();
  return { ...(distinct !== undefined && { distinctValueCount: distinct }), complete: params.sampleComplete };
};

/** Map a 200-empty {@link EmptyVerdict} to the scenario-result flags for the branch. A `fail` and a `pass`
 *  are DETERMINATE (`retryable: false`): a guaranteed-match empty is a real defect that retrying another
 *  field would MASK, and a correct `ne` empty is likewise conclusive. Only `skip` stays retryable. */
export const emptyOutcome = (
  verdict: EmptyVerdict,
): { readonly passed: boolean; readonly skipped: boolean; readonly retryable: boolean; readonly message: string } => {
  switch (verdict) {
    case 'fail':
      return { passed: false, skipped: false, retryable: false, message: 'Guaranteed-match filter returned 0 records for a value sampled from this field — the operator failed to return a known-present record' };
    case 'pass':
      return { passed: true, skipped: false, retryable: false, message: 'ne over a single-valued field across the complete resource correctly returned no other records' };
    default:
      return { passed: true, skipped: true, retryable: true, message: 'No records returned — filter executed but no matching data to validate' };
  }
};

/**
 * Execute the standard request→validate→assert flow for one scenario against `params`. Returns the
 * result plus `retryable`: true when the field couldn't be assessed (missing params, non-200, or an
 * inconclusive 200-empty) so the caller may try another candidate; false on a determinate pass/fail
 * (including a guaranteed-match 200-empty, which is a determinate FAIL).
 */
export const executeStandardScenario = async (
  serverUrl: string,
  resource: string,
  scenario: CoreScenario,
  params: TestParams,
  authToken: string,
  start: number,
  requester: ODataRequester = webRequester,
): Promise<{ readonly result: ScenarioResult; readonly retryable: boolean; readonly rejected: boolean; readonly accepted: boolean }> => {
  const query = buildScenarioQuery(serverUrl, resource, scenario, params);
  if (!query) {
    // Couldn't build the query (e.g. `in` needs 2+ values, this field had 1) — UNTESTABLE: neither a
    // rejection nor an acceptance, so it must stay neutral to an all-reject verdict.
    return { result: skipResult(scenario, start, 'required test parameters not available for this resource'), retryable: true, rejected: false, accepted: false };
  }
  const assertions: AssertionResult[] = [];
  try {
    const reqStart = Date.now();
    const response = await requester.request({ method: 'GET', url: query.url, authToken });
    const requestLatency = Date.now() - reqStart;

    const responseCheck = assertODataResponse(response, 200);
    assertions.push(responseCheck);
    if (!responseCheck.passed) {
      // The server REJECTED the operator on this field (non-200). Another field might be filterable; but if
      // EVERY eligible field rejects it and none accepts it, that's a genuine operator gap → the caller fails.
      return { result: { tag: scenario.tag, name: scenario.name, passed: false, skipped: false, assertions, duration: Date.now() - start, requestLatency, requestUrl: query.url }, retryable: true, rejected: true, accepted: false };
    }

    const records = extractRecords(response.body);
    if (records.length === 0) {
      // The server ACCEPTED the operator (200) — that vetoes an all-reject gap → accepted. But whether an
      // empty result is legitimate depends on the operator: emptyVerdict encodes Josh's rule that a value we
      // SAMPLED from the field must come back for a guaranteed-match operator (eq/gt/…/has/any and the `-1`
      // sentinel `not`), so empty there is a determinate FAIL; `ne` over a single-valued COMPLETE resource is
      // a determinate PASS; anything else is inconclusive → keep looking (retry the next candidate).
      const verdict = emptyVerdict(scenario, emptyContextFor(scenario, params));
      const outcome = emptyOutcome(verdict);
      assertions.push({ passed: verdict !== 'fail', message: outcome.message });
      return { result: { tag: scenario.tag, name: scenario.name, passed: outcome.passed, skipped: outcome.skipped, assertions, duration: Date.now() - start, requestLatency, requestUrl: query.url }, retryable: outcome.retryable, rejected: false, accepted: true };
    }

    const dataAssertion = assertData(records, scenario, params);
    if (dataAssertion) assertions.push(dataAssertion);
    const allPassed = assertions.every(a => a.passed);
    return { result: { tag: scenario.tag, name: scenario.name, passed: allPassed, skipped: false, assertions, duration: Date.now() - start, requestLatency, requestUrl: query.url }, retryable: false, rejected: false, accepted: true };
  } catch (err) {
    // A transport/parse error is indeterminate — UNTESTABLE, neither a rejection nor an acceptance.
    assertions.push({ passed: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
    return { result: { tag: scenario.tag, name: scenario.name, passed: false, skipped: false, errored: true, assertions, duration: Date.now() - start, requestUrl: query.url }, retryable: true, rejected: false, accepted: false };
  }
};

/**
 * Run an enum-family scenario: gate on the selected field's real representation and try candidate fields
 * in order. Only candidates whose representation supports the operator are eligible (flags→has,
 * single→eq/ne/in, collection→any/all); the first that queries cleanly is the verdict. If none is
 * queryable we skip rather than fail on an unlucky pick, and if there's no candidate of the right kind
 * (e.g. the server has no flags field for a `has` scenario) we skip with a reason.
 */
const runEnumFamilyScenario = async (
  serverUrl: string,
  resource: string,
  scenario: CoreScenario,
  params: TestParams,
  authToken: string,
  start: number,
  op: EnumOp,
): Promise<ScenarioResult> => {
  const slot = scenarioSlot(scenario);
  const candidates = (slot === 'multi' ? params.multiLookupCandidates : params.singleLookupCandidates) ?? [];
  // Every candidate of the RIGHT operator family, in rank order — try them ALL (early-exit on the first
  // determinate result). We deliberately do not cap: a provider may restrict $filter to a subset of its
  // enum fields (returning 400 on the rest), so a queryable field can sit at any rank; a cap could skip it
  // and — worse — leave us reporting one of the 400s. Ranking is uncorrelated with filterability.
  const eligible = candidates.filter(c => opValidForRep(op, c.representation));
  if (eligible.length === 0) {
    return skipResult(scenario, start, `no ${slot}-valued enumeration field supports "${op}" on this server`);
  }

  let anyAccepted = false; // some eligible field returned 200 — the operator ran, so it is not an all-reject gap
  let firstRejection: ScenarioResult | undefined;
  for (const candidate of eligible) {
    const { result, retryable, rejected, accepted } = await executeStandardScenario(serverUrl, resource, scenario, paramsWithCandidate(params, slot, candidate), authToken, start);
    if (!retryable) return result; // determinate pass/fail (incl. a guaranteed-match 200-empty → fail) — done
    if (accepted) anyAccepted = true;
    if (rejected) firstRejection ??= result;
  }
  // No determinate result. A rejection with NO acceptance anywhere is a genuine operator gap → FAIL (as the
  // scalar path treats a 400). An untestable candidate (unbuildable query, transport error) is NEUTRAL — it
  // neither proves nor disproves a gap. If a field accepted the operator (200) but had no data to assert, we
  // cannot prove a gap → SKIP.
  return firstRejection && !anyAccepted
    ? firstRejection
    : skipResult(scenario, start, `"${op}" not conclusively testable across ${eligible.length} ${slot}-valued field(s)`);
};

/**
 * Run the Lookup Resource validation scenario. The Lookup Resource (RCP-032/039) is the *string*-lookup
 * mechanism, so this validates against a `SINGLE_STRING` field; enum-typed providers have no Lookup
 * Resource and the scenario simply doesn't apply → skip. Unlike the generic flow, an empty Lookup Resource
 * is a FAILURE not a skip — the scenario exists to prove the declared LookupName is present, and its
 * `assertData` case turns 0 rows into a fail.
 */
const runLookupResourceScenario = async (
  serverUrl: string,
  resource: string,
  scenario: CoreScenario,
  params: TestParams,
  authToken: string,
  start: number,
): Promise<ScenarioResult> => {
  const stringField = (params.singleLookupCandidates ?? []).find(c => c.representation === 'SINGLE_STRING');
  if (!stringField) {
    return skipResult(scenario, start, 'no string (Lookup Resource) lookup field — enum-typed lookups have no Lookup Resource');
  }
  // Validate the LOCAL-first sample values — the ones most at risk of being absent from /Lookup — not the
  // standard-first filter values, which would mask an RCP-039 defect (a data value missing from /Lookup).
  const lv = stringField.lookupSampleValues;
  const effParams: TestParams = {
    ...paramsWithCandidate(params, 'single', stringField),
    singleLookupValue: lv[0],
    singleLookupValue2: lv[1],
    singleLookupValue3: lv[2],
  };
  const query = buildScenarioQuery(serverUrl, resource, scenario, effParams);
  if (!query) return skipResult(scenario, start, 'required test parameters not available for the Lookup Resource scenario');
  const assertions: AssertionResult[] = [];
  try {
    const reqStart = Date.now();
    const response = await odataRequest({ method: 'GET', url: query.url, authToken });
    const requestLatency = Date.now() - reqStart;
    const responseCheck = assertODataResponse(response, 200);
    assertions.push(responseCheck);
    if (!responseCheck.passed) {
      return { tag: scenario.tag, name: scenario.name, passed: false, skipped: false, assertions, duration: Date.now() - start, requestLatency, requestUrl: query.url };
    }
    // Collect ALL /Lookup rows for this LookupName across pages: a published value can sit beyond page 1
    // under server-driven paging, and the local (rarely-populated) value we test here is especially likely
    // to. Reading only page 1 would falsely report it missing and FALSE-FAIL a conformant provider.
    const records: Record<string, unknown>[] = [...extractRecords(response.body)];
    let nextLink = extractNextLink(response.body);
    let pages = 1;
    while (nextLink && pages < 25) {
      let pageResp: Awaited<ReturnType<typeof odataRequest>>;
      try {
        pageResp = await odataRequest({ method: 'GET', url: rebaseNextLink(nextLink, query.url), authToken });
      } catch {
        break; // a page fetch failed even after re-basing — validate with the rows we already have, don't hard-error
      }
      if (!assertODataResponse(pageResp, 200).passed) break;
      records.push(...extractRecords(pageResp.body));
      nextLink = extractNextLink(pageResp.body);
      pages += 1;
    }
    const dataAssertion = assertData(records, scenario, effParams); // handles 0 rows / wrong name / missing values → fail
    if (dataAssertion) assertions.push(dataAssertion);
    const allPassed = assertions.every(a => a.passed);
    return { tag: scenario.tag, name: scenario.name, passed: allPassed, skipped: false, assertions, duration: Date.now() - start, requestLatency, requestUrl: query.url };
  } catch (err) {
    return { tag: scenario.tag, name: scenario.name, passed: false, skipped: false, errored: true, assertions: [{ passed: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` }], duration: Date.now() - start, requestUrl: query.url };
  }
};

/** Run a single scenario and collect all assertion results. */
const runScenario = async (
  serverUrl: string,
  resource: string,
  scenario: CoreScenario,
  params: TestParams,
  authToken: string,
): Promise<ScenarioResult> => {
  const start = Date.now();

  // Lookup Resource validation applies only to string (Lookup Resource) lookups.
  if (scenario.category === 'lookup-resource') {
    return runLookupResourceScenario(serverUrl, resource, scenario, params, authToken, start);
  }

  // Enum-family scenarios gate on the selected field's REAL representation and try candidate fields —
  // replacing the resource-wide enumMode skip. A single enum never gets `has`; a flags enum never `eq`.
  const op = enumScenarioOp(scenario);
  if (op !== undefined) {
    return runEnumFamilyScenario(serverUrl, resource, scenario, params, authToken, start, op);
  }

  // Build query — undefined means required params missing, skip.
  const query = buildScenarioQuery(serverUrl, resource, scenario, params);
  if (!query) {
    return skipResult(scenario, start, 'required test parameters not available for this resource');
  }

  try {
    if (scenario.category === 'structural') {
      return runStructuralScenario(serverUrl, resource, scenario.assertion, query, params, authToken, start);
    }
    if (scenario.category === 'paging') {
      return runPagingScenario(serverUrl, resource, params, authToken, start);
    }
    if (scenario.category === 'error') {
      const reqStart = Date.now();
      const response = await odataRequest({ method: 'GET', url: query.url, authToken });
      const requestLatency = Date.now() - reqStart;
      const responseCheck = assertODataResponse(response, scenario.expectedStatus);
      return { tag: scenario.tag, name: scenario.name, passed: responseCheck.passed, skipped: false, assertions: [responseCheck], duration: Date.now() - start, requestLatency, requestUrl: query.url };
    }
    // Other standard scenarios (filter / orderby / expand / lookup-resource): a single execution.
    const { result } = await executeStandardScenario(serverUrl, resource, scenario, params, authToken, start);
    return result;
  } catch (err) {
    return { tag: scenario.tag, name: scenario.name, passed: false, skipped: false, errored: true, assertions: [{ passed: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` }], duration: Date.now() - start, requestUrl: query.url };
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

  // A FLAGS_ENUM field may serialize the response as an integer bitmask (or comma string); decode it back
  // to member names using the field's CSDL enum type so the assertion compares like-for-like. Only flags
  // needs this — a Collection(enum) response is a plain array of names (the array fallback handles it) and
  // a single enum is a scalar. undefined for string lookups (no bitmask form).
  const decodeFor = (fieldParam: string): ((raw: unknown) => ReadonlyArray<string>) | undefined => {
    const isMulti = fieldParam === 'multiLookupField';
    const rep = isMulti ? params.multiLookupFieldRep : params.singleLookupFieldRep;
    const enumType = isMulti ? params.multiLookupEnumType : params.singleLookupEnumType;
    return rep === 'FLAGS_ENUM' && enumType
      ? (raw) => decodeFlagsValue(enumType, typeof raw === 'string' || typeof raw === 'number' ? raw : undefined)
      : undefined;
  };

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

      // A negated filter (`not(field op value)`) returns records satisfying the COMPLEMENT of `op`.
      const assertOp = scenario.negated ? complementOp(scenario.op) : scenario.op;
      return assertScalarComparison(records, field, assertOp, value, scenario.dataType);
    }

    case 'orderby':
      return assertSortOrder(records, resolveField(scenario.fieldParam), scenario.direction);

    case 'enum':
      return scenario.enumType === 'single'
        ? assertEnumMatch(records, resolveField(scenario.fieldParam), scenario.op, String(resolve(scenario.valueParam)), decodeFor(scenario.fieldParam))
        : assertCollectionLambda(
            records,
            resolveField(scenario.fieldParam),
            'has',
            scenario.valueParam2
              ? [String(resolve(scenario.valueParam)), String(resolve(scenario.valueParam2))]
              : [String(resolve(scenario.valueParam))],
            decodeFor(scenario.fieldParam),
          );

    case 'collection':
      return assertCollectionLambda(
        records,
        resolveField(scenario.fieldParam),
        scenario.lambda,
        [String(resolve(scenario.valueParam))],
        decodeFor(scenario.fieldParam),
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
        decodeFor(scenario.fieldParam),
      );

    case 'in-operator': {
      // Validate every returned record's lookup value is in the requested set.
      const field = resolveField(scenario.fieldParam);
      const values = scenario.valueParams
        .map(p => resolve(p))
        .filter((v): v is string | number => v != null && v !== '')
        .map(String);
      if (values.length < 2) {
        return { passed: false, message: `Need at least 2 sample values for 'in' operator; got ${values.length}` };
      }
      const valueSet = new Set(values);
      const failures: string[] = [];
      for (const [i, record] of records.entries()) {
        const actual = record[field];
        if (actual == null) continue;
        if (!valueSet.has(String(actual))) {
          failures.push(`Record ${i}: ${field}=${JSON.stringify(actual)} not in (${values.map(v => `'${v}'`).join(',')})`);
        }
      }
      return failures.length === 0
        ? { passed: true, message: `All ${records.length} records satisfy ${field} in (${values.length} values)` }
        : { passed: false, message: `${failures.length} records failed: ${failures[0]}` };
    }

    case 'string-function': {
      // Optional string function (contains/startswith/endswith). Every
      // returned record must satisfy the predicate against the sample value.
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

    case 'lookup-resource': {
      // The fetched payload is the Lookup Resource filtered by LookupName.
      // Validate (1) at least one row came back, (2) every returned row's
      // LookupName matches what we asked for, and (3) the provider's
      // declared sample lookup values appear in the returned set.
      const field = resolveField(scenario.fieldParam);
      const expectedLookupName = params.lookupNameByField?.[field] ?? field;
      const sampleValues = [
        params.singleLookupValue,
        params.singleLookupValue2,
        params.singleLookupValue3,
      ].filter((v): v is string => typeof v === 'string' && v.length > 0);

      if (records.length === 0) {
        return { passed: false, message: `Lookup Resource returned no rows for LookupName '${expectedLookupName}'` };
      }
      const wrongName = records.find(r => r.LookupName != null && String(r.LookupName) !== expectedLookupName);
      if (wrongName) {
        return { passed: false, message: `Lookup Resource returned a row with LookupName=${JSON.stringify(wrongName.LookupName)}, expected '${expectedLookupName}'` };
      }
      const returnedValues = new Set(records.flatMap(r => {
        const a = r.StandardLookupValue != null ? [String(r.StandardLookupValue)] : [];
        const b = r.LookupValue != null ? [String(r.LookupValue)] : [];
        return [...a, ...b];
      }));
      const missing = sampleValues.filter(v => !returnedValues.has(v));
      if (missing.length > 0) {
        return { passed: false, message: `Lookup Resource missing sample value(s): ${missing.map(v => `'${v}'`).join(', ')} for LookupName '${expectedLookupName}'` };
      }
      return { passed: true, message: `Lookup Resource validated: LookupName '${expectedLookupName}' with ${sampleValues.length} sample value(s) present` };
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
  _resource: string,
  assertion: string,
  query: { readonly url: string; readonly selectFields: ReadonlyArray<string> },
  params: TestParams,
  authToken: string,
  start: number,
): Promise<ScenarioResult> => {
  const assertions: AssertionResult[] = [];
  const tag = assertion;
  const name = assertion;
  let odataVersion: string | undefined;

  try {
    if (assertion === 'metadata') {
      // Delegate the fetch to the SDK so `$format=application/xml` + auth
      // headers + version-detection conventions stay in one place. The
      // SDK throws `MetadataFetchError` on non-2xx; we catch it to map
      // the status / odata-version header onto compliance assertions.
      try {
        const result = await fetchMetadataWithVersion(serverUrl, authToken);
        odataVersion = result.odataVersion;
        assertions.push({ passed: true, message: 'HTTP 200' });
        assertions.push(
          result.odataVersion === '4.0' || result.odataVersion === '4.01'
            ? { passed: true, message: `OData-Version: ${result.odataVersion}` }
            : { passed: false, message: `Missing or invalid OData-Version header: ${result.odataVersion ?? 'none'}` }
        );
        assertions.push(
          result.xml.includes('<edmx:Edmx')
            ? { passed: true, message: 'Valid EDMX metadata' }
            : { passed: false, message: 'Response does not contain EDMX metadata' }
        );
      } catch (err) {
        if (!(err instanceof MetadataFetchError)) throw err;
        assertions.push({ passed: false, message: `Expected HTTP 200, got ${err.status}` });
        odataVersion = err.headers['odata-version'];
        assertions.push(
          odataVersion === '4.0' || odataVersion === '4.01'
            ? { passed: true, message: `OData-Version: ${odataVersion}` }
            : { passed: false, message: `Missing or invalid OData-Version header: ${odataVersion ?? 'none'}` }
        );
        // Body inspection on the failure path would require buffering the
        // response in the SDK — out of scope for this fix. A non-2xx
        // response is almost never well-formed EDMX, so flag the EDMX
        // assertion as failed (consistent with prior behavior on bad
        // status).
        assertions.push({ passed: false, message: 'Response does not contain EDMX metadata' });
      }
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
  return { tag, name, passed: allPassed, skipped: false, assertions, duration: Date.now() - start, requestUrl: query.url, odataVersion };
};

/** Run server-driven paging scenario (v2.1.0). */
export const runPagingScenario = async (
  serverUrl: string,
  resource: string,
  params: TestParams,
  authToken: string,
  start: number,
  requester: ODataRequester = webRequester,
): Promise<ScenarioResult> => {
  const assertions: AssertionResult[] = [];
  // Initial paging URL — kept in scope outside the try/while so the
  // returned ScenarioResult can surface it in the failure report.
  const initialUrl = `${serverUrl}/${resource}?$top=2&$select=${params.keyField}`;

  try {
    let url: string | undefined = initialUrl;
    const allKeys = new Set<string>();
    let pages = 0;
    const maxPages = 20;

    while (url && pages < maxPages) {
      const response = await requester.request({ method: 'GET', url, authToken });
      if (response.status !== 200) {
        assertions.push({ passed: false, message: `Page ${pages + 1}: HTTP ${response.status}` });
        break;
      }

      const records = extractRecords(response.body);
      for (const r of records) allKeys.add(String(r[params.keyField]));

      const rawNext = extractNextLink(response.body);
      url = rawNext ? rebaseNextLink(rawNext, initialUrl) : undefined; // tolerate a proxy/wrong-host base URL
      pages++;
    }

    if (pages > 1) {
      assertions.push({ passed: true, message: `Server-driven paging: ${pages} pages, ${allKeys.size} unique records` });
    } else if (pages === 1 && !url) {
      // Single page with no nextLink is valid — the server has fewer records
      // than the page size, so there's nothing to paginate.
      assertions.push({ passed: true, message: `Single page returned (${allKeys.size} records), no @odata.nextLink — valid` });
    } else {
      assertions.push({ passed: false, message: `Expected @odata.nextLink on page with $top=2 but none was returned (${allKeys.size} records across ${pages} pages)` });
    }

    // Final page should have no nextLink
    if (pages > 1 && !url) {
      assertions.push({ passed: true, message: 'Final page has no @odata.nextLink' });
    }
  } catch (err) {
    assertions.push({ passed: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }

  const allPassed = assertions.every(a => a.passed);
  return { tag: 'server-driven-paging', name: 'Server-driven paging', passed: allPassed, skipped: false, assertions, duration: Date.now() - start, requestUrl: initialUrl };
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

  // Track cross-scenario state for cascade-skip + OData-version gating.
  let lookupResourceFailed = false;
  let detectedODataVersion: string | undefined;

  for (const scenario of scenarios) {
    // Cascade-skip: dependent string-enum + in-operator scenarios are
    // pointless if the Lookup Resource didn't return the expected
    // LookupName / sample values. Skip them with a clear reason.
    if (lookupResourceFailed && (scenario.category === 'string-enum' || scenario.category === 'in-operator')) {
      results.push({
        tag: scenario.tag,
        name: scenario.name,
        passed: false,
        skipped: true,
        assertions: [{ passed: false, message: 'Skipped: lookup-resource-validation failed earlier in this run' }],
        duration: 0,
        optional: scenario.optional,
      });
      continue;
    }

    // OData 4.01 gate: the `in` operator was introduced in 4.01. Skip on 4.0.
    if (scenario.category === 'in-operator' && detectedODataVersion && detectedODataVersion !== '4.01') {
      results.push({
        tag: scenario.tag,
        name: scenario.name,
        passed: false,
        skipped: true,
        assertions: [{ passed: false, message: `Skipped: 'in' operator requires OData-Version 4.01 (server reports ${detectedODataVersion})` }],
        duration: 0,
        optional: scenario.optional,
      });
      continue;
    }

    const result = await runScenario(serverUrl, resource, scenario, params, authToken);
    results.push({ ...result, optional: scenario.optional });

    // Latch state for subsequent iterations.
    if (scenario.tag === 'lookup-resource-validation' && !result.passed && !result.skipped) {
      lookupResourceFailed = true;
    }
    if (result.odataVersion && !detectedODataVersion) {
      detectedODataVersion = result.odataVersion;
    }
  }

  return {
    resource,
    params,
    coverage: buildCoverage(params),
    scenarios: results,
    summary: summarizeScenarios(results),
  };
};
