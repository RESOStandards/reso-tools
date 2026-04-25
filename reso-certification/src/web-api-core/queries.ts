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
    case 'expand':
      return buildExpandUrl(serverUrl, resource, params, scenario);
    case 'paging':
      return { url: `${serverUrl}/${resource}?$top=1&$count=true`, selectFields: [params.keyField] };
  }
};
