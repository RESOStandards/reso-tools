/**
 * OData query URL builder for Web API Core scenarios.
 *
 * Builds the correct OData URL for each scenario type from resolved TestParams.
 */

import type { TestParams } from './sampling.js';
import type {
  CoreScenario,
  FilterScenario,
  OrderByScenario,
  EnumScenario,
  CollectionScenario,
  ErrorScenario,
  StringEnumScenario,
  StringFunctionScenario,
  InOperatorScenario,
  ExpandScenario,
} from './scenarios.js';

/** Result of building a query: the URL and the select fields. */
export interface QuerySpec {
  readonly url: string;
  readonly selectFields: ReadonlyArray<string>;
}

/** Resolve a param reference (e.g., 'integerValueLow') to its actual value. */
const resolveParam = (params: TestParams, paramName: string): string | number | undefined => {
  if (paramName === 'now') return 'now()';
  return (params as unknown as Record<string, string | number | undefined>)[paramName];
};

/** Resolve a field param to the actual field name. */
const resolveField = (params: TestParams, fieldParam: string): string | undefined =>
  (params as unknown as Record<string, string | undefined>)[fieldParam];

/** Format a value for an OData $filter expression. */
const formatFilterValue = (value: string | number | undefined, dataType: string): string => {
  if (value === 'now()') return 'now()';
  if (value == null) return 'null';
  if (dataType === 'integer') return String(value);
  if (dataType === 'decimal') return String(value);
  if (dataType === 'date') return String(value);
  if (dataType === 'datetime') return String(value);
  return `'${String(value)}'`;
};

/** OData string literal: wrap in single quotes, doubling any embedded single quote (OData 4.01). A member
 *  value with an apostrophe (common in local MLS values) would otherwise emit malformed OData. */
const odataString = (value: string | number): string => `'${String(value).replace(/'/g, "''")}'`;

/**
 * The record-derived value set for a scenario whose operator can be made GUARANTEED-MATCH by querying over ONE
 * real record's own collection — so an empty result becomes a determinate defect instead of a skip. Applies to:
 *
 *  - **collection `all()`** and **string-enum `all()`** — `all(x: x eq v1 or … or vn)` matches a record iff its
 *    collection ⊆ {v1..vn}; over a record's OWN full collection that record matches by construction. Full set.
 *  - **FLAGS `has A and has B`** — both flags co-present on one record are guaranteed; the first two of the
 *    record's members are co-present by construction. Needs ≥2 members.
 *
 * `any()` is excluded — it is already guaranteed-match over a single sampled value (fail-on-empty), so a
 * record-derived set buys it nothing. Returns undefined when the substituted candidate carried no subset (or too
 * few members for has-and); the operator then keeps its prior arbitrary-value query AND its skip-on-empty verdict.
 * This is the ONE source of truth shared by the query builder, the data assertion, and the empty-result verdict —
 * they must agree on the exact value set or the "guaranteed match" claim breaks.
 */
export const recordDerivedSet = (scenario: CoreScenario, params: TestParams): ReadonlyArray<string> | undefined => {
  const subset = params.multiLookupSubsetValues;
  if (!subset || subset.length === 0) return undefined;
  if (scenario.category === 'collection') return scenario.lambda === 'all' ? subset : undefined;
  if (scenario.category === 'string-enum') return scenario.op === 'all' ? subset : undefined;
  if (scenario.category === 'enum') return scenario.valueParam2 !== undefined && subset.length >= 2 ? subset.slice(0, 2) : undefined;
  return undefined;
};

// ── Filter URL builders ──

const buildFilterUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  scenario: FilterScenario,
): QuerySpec | undefined => {
  const field = resolveField(params, scenario.fieldParam);
  const value = resolveParam(params, scenario.valueParam);
  if (!field || value == null) return undefined;

  const selectFields = [params.keyField, field];
  const formattedValue = formatFilterValue(value, scenario.dataType);

  let filterExpr: string;

  if (scenario.negated) {
    // Honor the scenario's operator: the `not` test is `not(field le -1)` (the `-1` sentinel), which returns
    // every non-negative record → guaranteed non-empty, so an empty result is a determinate operator defect.
    filterExpr = `not(${field} ${scenario.op} ${formattedValue})`;
  } else if (scenario.compound) {
    const value2 = resolveParam(params, scenario.compound.valueParam2);
    if (value2 == null) return undefined;
    const formatted2 = formatFilterValue(value2, scenario.dataType);
    filterExpr = `${field} ${scenario.op} ${formattedValue} ${scenario.compound.logical} ${field} ${scenario.compound.op2} ${formatted2}`;
  } else {
    filterExpr = `${field} ${scenario.op} ${formattedValue}`;
  }

  const url = `${serverUrl}/${resource}?$filter=${encodeURIComponent(filterExpr)}&$select=${selectFields.join(',')}`;
  return { url, selectFields };
};

const buildOrderByUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  scenario: OrderByScenario,
): QuerySpec | undefined => {
  const field = resolveField(params, scenario.fieldParam);
  if (!field) return undefined;

  const selectFields = [params.keyField, field];
  let url = `${serverUrl}/${resource}?$orderby=${field} ${scenario.direction}&$select=${selectFields.join(',')}`;

  if (scenario.filter) {
    const filterField = resolveField(params, scenario.filter.fieldParam);
    const filterValue = resolveParam(params, scenario.filter.valueParam);
    if (!filterField || filterValue == null) return undefined;
    selectFields.push(filterField);
    const formatted = formatFilterValue(filterValue, scenario.filter.dataType);
    url += `&$filter=${encodeURIComponent(`${filterField} ${scenario.filter.op} ${formatted}`)}`;
  }

  return { url, selectFields };
};

const buildEnumUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  scenario: EnumScenario,
): QuerySpec | undefined => {
  const field = resolveField(params, scenario.fieldParam);
  const value = resolveParam(params, scenario.valueParam);
  if (!field || value == null) return undefined;

  const selectFields = [params.keyField, field];
  let filterExpr: string;

  if (scenario.enumType === 'single') {
    filterExpr = `${field} ${scenario.op} ${odataString(value)}`;
  } else if (scenario.valueParam2) {
    // `has A and has B` over two flags CO-PRESENT on one real record is guaranteed to return it; else the prior
    // two most-frequent values (which may live on different records → legitimately empty → skip).
    const derived = recordDerivedSet(scenario, params);
    if (derived) {
      filterExpr = derived.map(v => `${field} has ${odataString(v)}`).join(' and ');
    } else {
      const value2 = resolveParam(params, scenario.valueParam2);
      if (value2 == null) return undefined;
      filterExpr = `${field} has ${odataString(value)} and ${field} has ${odataString(value2)}`;
    }
  } else {
    filterExpr = `${field} has ${odataString(value)}`;
  }

  const url = `${serverUrl}/${resource}?$filter=${encodeURIComponent(filterExpr)}&$select=${selectFields.join(',')}`;
  return { url, selectFields };
};

const buildCollectionUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  scenario: CollectionScenario,
): QuerySpec | undefined => {
  const field = resolveField(params, scenario.fieldParam);
  if (!field) return undefined;

  const selectFields = [params.keyField, field];
  // all() over one record's OWN full collection is guaranteed to return that record (its members ⊆ the set) —
  // a determinate check rather than a skip-on-empty. any() and the no-subset fallback query one sampled value.
  const derived = recordDerivedSet(scenario, params);
  const filterExpr = derived
    ? `${field}/${scenario.lambda}(x:${derived.map(v => `x eq ${odataString(v)}`).join(' or ')})` // scenario.lambda is 'all' here (recordDerivedSet's contract)
    : ((): string | undefined => {
        const value = resolveParam(params, scenario.valueParam);
        return value == null ? undefined : `${field}/${scenario.lambda}(x:x eq ${odataString(value)})`;
      })();
  if (filterExpr === undefined) return undefined;
  const url = `${serverUrl}/${resource}?$filter=${encodeURIComponent(filterExpr)}&$select=${selectFields.join(',')}`;
  return { url, selectFields };
};

const buildStringEnumUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  scenario: StringEnumScenario,
): QuerySpec | undefined => {
  const field = resolveField(params, scenario.fieldParam);
  const value = resolveParam(params, scenario.valueParam);
  if (!field || value == null) return undefined;

  const selectFields = [params.keyField, field];
  let filterExpr: string;

  if (scenario.enumType === 'single') {
    filterExpr = `${field} ${scenario.op} ${odataString(value)}`;
  } else {
    // all() over one record's OWN full collection is guaranteed to return that record; else the prior 1-2 sampled
    // values (any() can't be record-guaranteed and recordDerivedSet excludes it).
    const derived = recordDerivedSet(scenario, params);
    if (derived) {
      const valExpr = derived.map(v => `x eq ${odataString(v)}`).join(' or ');
      filterExpr = `${field}/${scenario.op}(x:${valExpr})`;
    } else {
      const value2 = scenario.valueParam2 ? resolveParam(params, scenario.valueParam2) : undefined;
      const valExpr = value2
        ? `x eq ${odataString(value)} or x eq ${odataString(value2)}`
        : `x eq ${odataString(value)}`;
      filterExpr = `${field}/${scenario.op}(x:${valExpr})`;
    }
  }

  const url = `${serverUrl}/${resource}?$filter=${encodeURIComponent(filterExpr)}&$select=${selectFields.join(',')}`;
  return { url, selectFields };
};

// Build `$filter=Field in ('A','B','C')` against the resource being tested.
// Skipped at runtime when the server's response advertises OData-Version 4.0
// only (the `in` operator was introduced in 4.01); the gate lives in test-runner.
const buildInOperatorUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  scenario: InOperatorScenario,
): QuerySpec | undefined => {
  const field = resolveField(params, scenario.fieldParam);
  if (!field) return undefined;

  const values = scenario.valueParams
    .map(p => resolveParam(params, p))
    .filter((v): v is string => v != null && v !== '');
  // Need at least two values to make `in` meaningful; otherwise it degenerates to `eq`.
  if (values.length < 2) return undefined;

  const selectFields = [params.keyField, field];
  const valueList = values.map(odataString).join(',');
  const filterExpr = `${field} in (${valueList})`;
  const url = `${serverUrl}/${resource}?$filter=${encodeURIComponent(filterExpr)}&$select=${selectFields.join(',')}`;
  return { url, selectFields };
};

// GET /Lookup?$filter=LookupName eq 'X' — the Lookup Resource query shape, built directly by the runner's
// per-candidate presence fetch (test-runner.ts `validateStringLookupCandidate`). Select-ALL only (no $select):
// StandardLookupValue and LegacyODataValue are NOT universally declared, and $select-ing an undeclared column
// returns 400 for the whole scenario (a false-FAIL that cascade-skips the dependent string-enum/`in` tests). Core
// does not gate on SLV (a Data Dictionary concern — see the registry lookup-resource node), so naming columns buys
// nothing: select-all still returns SLV / LegacyODataValue WHEN the provider declares them (for the report-only
// value classification), and can never 400 on their absence.
export const buildLookupUrl = (serverUrl: string, lookupName: string): string =>
  `${serverUrl}/Lookup?$filter=${encodeURIComponent(`LookupName eq '${lookupName}'`)}`;

const buildExpandUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  scenario: ExpandScenario,
): QuerySpec | undefined => {
  const expandField = resolveField(params, scenario.fieldParam);
  if (!expandField) return undefined;

  const selectFields = [params.keyField];
  const url = `${serverUrl}/${resource}?$expand=${expandField}&$top=5`;
  return { url, selectFields };
};

const buildErrorUrl = (
  serverUrl: string,
  resource: string,
  scenario: ErrorScenario,
): QuerySpec => {
  const url = scenario.expectedStatus === 400
    ? `${serverUrl}/${resource}?$filter=INVALIDFIELD eq 'bad'`
    : `${serverUrl}/ResourceNotFound`;
  return { url, selectFields: [] };
};

// ── Structural query builders ──

const buildStructuralUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  assertion: string,
): QuerySpec | undefined => {
  switch (assertion) {
    case 'metadata':
      // URL kept for the scenario dispatcher (so it knows this assertion
      // can run). The actual fetch is delegated to the SDK in
      // `test-runner.ts` so the `$format=application/xml` query param +
      // header conventions live in one place (the reso-client SDK's
      // `fetchRawMetadataWithVersion`). Don't be tempted to mirror that
      // formatting here — it'll drift.
      return { url: `${serverUrl}/$metadata`, selectFields: [] };
    case 'service-document':
      return { url: serverUrl, selectFields: [] };
    case 'fetch-by-key':
      return { url: `${serverUrl}/${resource}('${params.keyValue}')`, selectFields: [params.keyField] };
    case 'select': {
      // Project a MULTI-field list (key + a sampled data field), not just the key. A key-only $select degenerates
      // to "a key projection returns rows" and can't catch a server that mishandles a real multi-field projection.
      // Commander parity (filter/`select`): it selects key + a data field and checks the data actually comes back.
      // The data field is a value we SAMPLED (so it's declared in metadata and known-populated), avoiding a
      // sparse-field false-fail; if none is available the list is key-only and the projection check is N/A.
      const dataField = params.timestampField ?? params.integerField ?? params.decimalField ?? params.dateField ?? params.singleLookupField;
      const selectFields = dataField ? [params.keyField, dataField] : [params.keyField];
      return {
        url: `${serverUrl}/${resource}?$select=${selectFields.join(',')}`,
        selectFields,
      };
    }
    case 'top':
      return {
        url: `${serverUrl}/${resource}?$top=5&$select=${params.keyField}`,
        selectFields: [params.keyField],
      };
    case 'skip':
      return {
        url: `${serverUrl}/${resource}?$top=5&$select=${params.keyField}`,
        selectFields: [params.keyField],
      };
    case 'count':
      return {
        url: `${serverUrl}/${resource}?$top=5&$count=true&$select=${params.keyField}`,
        selectFields: [params.keyField],
      };
    default:
      return undefined;
  }
};

// String function filter: $filter=contains|startswith|endswith(Field,'value').
// Optional ("Optional Tests") — restored alongside the RCP-039 work.
const buildStringFunctionUrl = (
  serverUrl: string,
  resource: string,
  params: TestParams,
  scenario: StringFunctionScenario,
): QuerySpec | undefined => {
  const field = resolveField(params, scenario.fieldParam);
  const value = resolveParam(params, scenario.valueParam);
  if (!field || value == null) return undefined;

  const selectFields = [params.keyField, field];
  const filterExpr = `${scenario.func}(${field},${odataString(value)})`;
  const url = `${serverUrl}/${resource}?$filter=${encodeURIComponent(filterExpr)}&$select=${selectFields.join(',')}`;
  return { url, selectFields };
};

// ── Main dispatcher ──

/**
 * Build the OData query URL for a scenario.
 * Returns undefined if required test params are missing (scenario should be skipped).
 */
const buildQueryForCategory = (
  serverUrl: string,
  resource: string,
  scenario: CoreScenario,
  params: TestParams,
): QuerySpec | undefined => {
  switch (scenario.category) {
    case 'structural':
      return buildStructuralUrl(serverUrl, resource, params, scenario.assertion);
    case 'filter':
      return buildFilterUrl(serverUrl, resource, params, scenario);
    case 'orderby':
      return buildOrderByUrl(serverUrl, resource, params, scenario);
    case 'enum':
      return buildEnumUrl(serverUrl, resource, params, scenario);
    case 'collection':
      return buildCollectionUrl(serverUrl, resource, params, scenario);
    case 'error':
      return buildErrorUrl(serverUrl, resource, scenario);
    case 'string-enum':
      return buildStringEnumUrl(serverUrl, resource, params, scenario);
    case 'string-function':
      return buildStringFunctionUrl(serverUrl, resource, params, scenario);
    case 'in-operator':
      return buildInOperatorUrl(serverUrl, resource, params, scenario);
    case 'expand':
      return buildExpandUrl(serverUrl, resource, params, scenario);
    case 'paging':
      return { url: `${serverUrl}/${resource}?$top=1&$count=true`, selectFields: [params.keyField] };
  }
};

// ── OriginatingSystem (OSN/OSID) scoping ──
// Multi-tenant providers (e.g. MLS Grid) commingle many orgs behind one endpoint; some also REQUIRE an
// OriginatingSystemName filter and 400 without it. Certifying a recipient org must therefore scope resource
// queries to that org rather than reading "from the top" (huge, slow, and validating the wrong data). DD
// replication already does this via prepareFilterExpression; this mirrors it for Core.
// WIRED (resource-aware): the run config (originatingSystemName/Id, from the CLI `--config` / flags) flows
// through resolveTestParams, which sets the OSN/OSID params ONLY for resources whose metadata actually carries
// the field — so the clause is never ANDed into a resource that lacks it (e.g. PropertyGreenVerification,
// ContactListings, Showing), which would false-fail with a 400. resolveTestParams also scopes its own sample
// fetch with the same clause, so a provider that REQUIRES the filter can be sampled at all. Inert when no
// OriginatingSystem is configured. The scoped-category set below stays provisional pending live validation.

/** The metadata field names carrying the originating system on a resource — used both to build the filter
 *  clause and (in resolveTestParams) for the resource-aware field-presence check. */
export const ORIGINATING_SYSTEM_NAME_FIELD = 'OriginatingSystemName';
export const ORIGINATING_SYSTEM_ID_FIELD = 'OriginatingSystemID';

/** Resource-data filter categories that must be OriginatingSystem-scoped. Excludes `lookup-resource`
 *  (/Lookup has no OriginatingSystem field), `error` (deliberate 404), `expand`, `structural` (key/metadata),
 *  and `paging`. PROVISIONAL — confirm fetch-by-key / count / paging against a real provider before finalizing. */
const ORIGINATING_SYSTEM_SCOPED_CATEGORIES: ReadonlySet<string> = new Set([
  'filter', 'orderby', 'enum', 'collection', 'string-enum', 'string-function', 'in-operator',
]);

/** The OriginatingSystemName (preferred) or OriginatingSystemID `$filter` clause for raw values, or '' when
 *  neither is set — the single source of the OSN-over-OSID precedence, shared by the scenario-query scoping
 *  ({@link originatingSystemClause}) and resolveTestParams' sample-fetch scoping. */
export const originatingSystemFilterClause = (name?: string, id?: string): string => {
  if (name && name.length > 0) return `${ORIGINATING_SYSTEM_NAME_FIELD} eq ${odataString(name)}`;
  if (id && id.length > 0) return `${ORIGINATING_SYSTEM_ID_FIELD} eq ${odataString(id)}`;
  return '';
};

/** The OriginatingSystem clause for a run's resolved params (delegates to {@link originatingSystemFilterClause}). */
const originatingSystemClause = (params: TestParams): string =>
  originatingSystemFilterClause(params.originatingSystemName, params.originatingSystemId);

/** AND a clause into a URL's existing `$filter` (wrapping the original in parens), or add `$filter` when the
 *  URL has none. Operates on the built URL so it applies uniformly regardless of which builder produced it. */
const andUrlFilter = (url: string, clause: string): string => {
  const [base, query = ''] = url.split('?');
  const parts = query ? query.split('&') : [];
  const idx = parts.findIndex(p => p.startsWith('$filter='));
  if (idx === -1) {
    return `${base}?${[`$filter=${encodeURIComponent(clause)}`, ...parts].join('&')}`;
  }
  const existing = decodeURIComponent(parts[idx].slice('$filter='.length));
  parts[idx] = `$filter=${encodeURIComponent(`(${existing}) and ${clause}`)}`;
  return `${base}?${parts.join('&')}`;
};

/** Scope a resource-data query to the recipient's OriginatingSystem when one is configured; a no-op for the
 *  non-scoped categories and when no OriginatingSystem is set (inert until wired from the run config). */
const scopeToOriginatingSystem = (
  spec: QuerySpec | undefined,
  scenario: CoreScenario,
  params: TestParams,
): QuerySpec | undefined => {
  if (!spec || !ORIGINATING_SYSTEM_SCOPED_CATEGORIES.has(scenario.category)) return spec;
  const clause = originatingSystemClause(params);
  return clause ? { ...spec, url: andUrlFilter(spec.url, clause) } : spec;
};

/**
 * Build the OData URL for a Core scenario, then scope resource-data queries to the recipient's
 * OriginatingSystem (multi-tenant correctness). Inert until an OriginatingSystem is set on the params.
 */
export const buildScenarioQuery = (
  serverUrl: string,
  resource: string,
  scenario: CoreScenario,
  params: TestParams,
): QuerySpec | undefined =>
  scopeToOriginatingSystem(buildQueryForCategory(serverUrl, resource, scenario, params), scenario, params);
