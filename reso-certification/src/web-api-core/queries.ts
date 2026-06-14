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
  LookupResourceValidationScenario,
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
    filterExpr = `not(${field} eq ${formattedValue})`;
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
    filterExpr = `${field} ${scenario.op} '${value}'`;
  } else if (scenario.valueParam2) {
    const value2 = resolveParam(params, scenario.valueParam2);
    if (value2 == null) return undefined;
    filterExpr = `${field} has '${value}' and ${field} has '${value2}'`;
  } else {
    filterExpr = `${field} has '${value}'`;
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
  const value = resolveParam(params, scenario.valueParam);
  if (!field || value == null) return undefined;

  const selectFields = [params.keyField, field];
  const filterExpr = `${field}/${scenario.lambda}(x:x eq '${value}')`;
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
    filterExpr = `${field} ${scenario.op} '${value}'`;
  } else {
    const value2 = scenario.valueParam2 ? resolveParam(params, scenario.valueParam2) : undefined;
    const valExpr = value2
      ? `x eq '${value}' or x eq '${value2}'`
      : `x eq '${value}'`;
    filterExpr = `${field}/${scenario.op}(x:${valExpr})`;
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
  const valueList = values.map(v => `'${v}'`).join(',');
  const filterExpr = `${field} in (${valueList})`;
  const url = `${serverUrl}/${resource}?$filter=${encodeURIComponent(filterExpr)}&$select=${selectFields.join(',')}`;
  return { url, selectFields };
};

// GET /Lookup?$filter=LookupName eq 'X'. Used to validate that the provider's
// Lookup Resource carries the LookupName the provider supplied AND the sample
// lookup values they listed. Sample-value presence check happens in the test
// runner against the returned payload, not here.
const buildLookupResourceUrl = (
  serverUrl: string,
  params: TestParams,
  scenario: LookupResourceValidationScenario,
): QuerySpec | undefined => {
  const field = resolveField(params, scenario.fieldParam);
  if (!field) return undefined;
  // Per RCP-039, providers must use RESO.OData.Metadata.LookupName on
  // Edm.String enum fields. The runner resolves the LookupName from the
  // metadata annotation on `field`. The URL filter uses that LookupName.
  // We delegate the actual annotation lookup to the test runner so this
  // builder stays a pure URL constructor; the runner will pass the
  // resolved LookupName via a future param. For now produce a sentinel
  // URL using the field name as a placeholder for the LookupName.
  const lookupName = params.lookupNameByField?.[field] ?? field;
  const filterExpr = `LookupName eq '${lookupName}'`;
  const url = `${serverUrl}/Lookup?$filter=${encodeURIComponent(filterExpr)}&$select=LookupName,LookupValue,StandardLookupValue`;
  return { url, selectFields: ['LookupName', 'LookupValue', 'StandardLookupValue'] };
};

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
    case 'select':
      return {
        url: `${serverUrl}/${resource}?$select=${params.keyField}`,
        selectFields: [params.keyField],
      };
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
  const filterExpr = `${scenario.func}(${field},'${value}')`;
  const url = `${serverUrl}/${resource}?$filter=${encodeURIComponent(filterExpr)}&$select=${selectFields.join(',')}`;
  return { url, selectFields };
};

// ── Main dispatcher ──

/**
 * Build the OData query URL for a scenario.
 * Returns undefined if required test params are missing (scenario should be skipped).
 */
export const buildScenarioQuery = (
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
    case 'lookup-resource':
      return buildLookupResourceUrl(serverUrl, params, scenario);
    case 'expand':
      return buildExpandUrl(serverUrl, resource, params, scenario);
    case 'paging':
      return { url: `${serverUrl}/${resource}?$top=1&$count=true`, selectFields: [params.keyField] };
  }
};
