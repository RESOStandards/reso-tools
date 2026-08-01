/**
 * Web API Core scenario definitions — all 45+ scenarios as typed data.
 *
 * Each scenario maps to one OData operation + one assertion primitive.
 * A single generic runner executes them all.
 */

/** Comparison operators for scalar filters. */
export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le';

/** Logical connectors for compound filters. */
export type LogicalOp = 'and' | 'or';

/** Sort direction. */
export type SortDirection = 'asc' | 'desc';

/** OData data types for filter comparison. */
export type DataType = 'integer' | 'decimal' | 'date' | 'datetime';

/** Scenario categories. */
export type ScenarioCategory = 'structural' | 'filter' | 'orderby' | 'enum' | 'collection' | 'error' | 'string-enum' | 'paging' | 'expand';

/** Minimum version required for a scenario. */
export type MinVersion = '2.0.0' | '2.1.0';

// ── Scenario type variants ──

interface BaseScenario {
  readonly tag: string;
  readonly name: string;
  readonly minVersion: MinVersion;
  /** When true, this scenario is an "Optional Test": its failure never affects
   *  the Core verdict (it renders Passed / Not Supported / Not Tested instead).
   *  Absent = required (the default). */
  readonly optional?: boolean;
}

export interface StructuralScenario extends BaseScenario {
  readonly category: 'structural';
  readonly assertion: 'metadata' | 'service-document' | 'fetch-by-key' | 'select' | 'top' | 'skip' | 'count';
}

export interface FilterScenario extends BaseScenario {
  readonly category: 'filter';
  readonly dataType: DataType;
  readonly op: ComparisonOp;
  /** Which test param to use for the field name. */
  readonly fieldParam: string;
  /** Which test param to use for the comparison value. */
  readonly valueParam: string;
  /** Compound filter with a logical connector. */
  readonly compound?: { readonly op2: ComparisonOp; readonly valueParam2: string; readonly logical: LogicalOp };
  /** Wraps the filter in not(). */
  readonly negated?: boolean;
}

export interface OrderByScenario extends BaseScenario {
  readonly category: 'orderby';
  readonly fieldParam: string;
  readonly direction: SortDirection;
  /** Additional filter applied alongside the orderby. */
  readonly filter?: { readonly fieldParam: string; readonly op: ComparisonOp; readonly valueParam: string; readonly dataType: DataType };
}

export interface EnumScenario extends BaseScenario {
  readonly category: 'enum';
  readonly enumType: 'single' | 'multi';
  readonly op: 'has' | 'eq' | 'ne';
  readonly fieldParam: string;
  readonly valueParam: string;
  /** Second value for multi-value has+and. */
  readonly valueParam2?: string;
}

export interface CollectionScenario extends BaseScenario {
  readonly category: 'collection';
  readonly lambda: 'any' | 'all';
  readonly fieldParam: string;
  readonly valueParam: string;
}

export interface ErrorScenario extends BaseScenario {
  readonly category: 'error';
  readonly expectedStatus: number;
}

export interface StringEnumScenario extends BaseScenario {
  readonly category: 'string-enum';
  readonly enumType: 'single' | 'multi';
  readonly op: 'eq' | 'ne' | 'any' | 'all';
  readonly fieldParam: string;
  readonly valueParam: string;
  readonly valueParam2?: string;
}

/** String function filters (contains / startswith / endswith). Optional: per
 *  the workgroup these are not required for Core certification. */
export interface StringFunctionScenario extends BaseScenario {
  readonly category: 'string-function';
  readonly func: 'contains' | 'startswith' | 'endswith';
  readonly fieldParam: string;
  readonly valueParam: string;
}

export interface PagingScenario extends BaseScenario {
  readonly category: 'paging';
  readonly assertion: 'nextLink';
}

export interface ExpandScenario extends BaseScenario {
  readonly category: 'expand';
  readonly fieldParam: string;
}

export interface InOperatorScenario extends BaseScenario {
  readonly category: 'in-operator';
  readonly enumType: 'single';
  readonly fieldParam: string;
  /** List of value parameters to put inside the `in (…)` clause. Per RCP-039
   *  the example uses three values; minimum 2 to be meaningful. Gated on the
   *  server advertising OData-Version 4.01 in the response header — the test
   *  runner skips this scenario for 4.0-only servers. */
  readonly valueParams: ReadonlyArray<string>;
}

export interface LookupResourceValidationScenario extends BaseScenario {
  readonly category: 'lookup-resource';
  readonly assertion: 'lookup-resource-validation';
  /** Which LookupName to fetch and validate. Per RCP-039 the provider supplies
   *  the LookupName + sample values; this scenario runs first among string-enum
   *  tests so cascade-skip can short-circuit dependent scenarios if the
   *  Lookup Resource doesn't carry the expected name/values. */
  readonly fieldParam: string;
  readonly valueParam: string;
  readonly valueParam2?: string;
}

export type CoreScenario =
  | StructuralScenario
  | FilterScenario
  | OrderByScenario
  | EnumScenario
  | CollectionScenario
  | ErrorScenario
  | StringEnumScenario
  | StringFunctionScenario
  | PagingScenario
  | ExpandScenario
  | InOperatorScenario
  | LookupResourceValidationScenario;

// ── v2.0.0 Scenarios (45 total) ──

const structuralScenarios: ReadonlyArray<StructuralScenario> = [
  { tag: 'metadata-validation', name: 'Validate server metadata', category: 'structural', assertion: 'metadata', minVersion: '2.0.0' },
  { tag: 'service-document', name: 'Service document request', category: 'structural', assertion: 'service-document', minVersion: '2.0.0' },
  { tag: 'fetch-by-key', name: 'Fetch by key field', category: 'structural', assertion: 'fetch-by-key', minVersion: '2.0.0' },
  { tag: 'select', name: '$select query support', category: 'structural', assertion: 'select', minVersion: '2.0.0' },
  { tag: 'top', name: '$top query support', category: 'structural', assertion: 'top', minVersion: '2.0.0' },
  { tag: 'skip', name: '$skip query support', category: 'structural', assertion: 'skip', minVersion: '2.0.0' },
  { tag: 'count', name: '$count query support', category: 'structural', assertion: 'count', minVersion: '2.0.0' },
];

const integerFilterScenarios: ReadonlyArray<FilterScenario> = [
  { tag: 'filter-int-and', name: 'Integer: and', category: 'filter', dataType: 'integer', op: 'gt', fieldParam: 'integerField', valueParam: 'integerValueLow', compound: { op2: 'lt', valueParam2: 'integerValueHigh', logical: 'and' }, minVersion: '2.0.0' },
  { tag: 'filter-int-or', name: 'Integer: or', category: 'filter', dataType: 'integer', op: 'gt', fieldParam: 'integerField', valueParam: 'integerValueLow', compound: { op2: 'lt', valueParam2: 'integerValueHigh', logical: 'or' }, minVersion: '2.0.0' },
  // `not(field le -1)` — the `-1` sentinel (below the non-negative floor) matches every record, so an empty
  // result is a guaranteed-match defect. Value = integerNotSentinel (−1 for a non-negative field; below the
  // sampled min for a signed one), computed at sampling time so the guarantee holds for the actual field.
  { tag: 'filter-int-not', name: 'Integer: not()', category: 'filter', dataType: 'integer', op: 'le', fieldParam: 'integerField', valueParam: 'integerNotSentinel', negated: true, minVersion: '2.0.0' },
  { tag: 'filter-int-eq', name: 'Integer: eq', category: 'filter', dataType: 'integer', op: 'eq', fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0' },
  { tag: 'filter-int-ne', name: 'Integer: ne', category: 'filter', dataType: 'integer', op: 'ne', fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0' },
  { tag: 'filter-int-gt', name: 'Integer: gt', category: 'filter', dataType: 'integer', op: 'gt', fieldParam: 'integerField', valueParam: 'integerValueMin', minVersion: '2.0.0' },
  { tag: 'filter-int-ge', name: 'Integer: ge', category: 'filter', dataType: 'integer', op: 'ge', fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0' },
  { tag: 'filter-int-lt', name: 'Integer: lt', category: 'filter', dataType: 'integer', op: 'lt', fieldParam: 'integerField', valueParam: 'integerValueMax', minVersion: '2.0.0' },
  { tag: 'filter-int-le', name: 'Integer: le', category: 'filter', dataType: 'integer', op: 'le', fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0' },
];

const decimalFilterScenarios: ReadonlyArray<FilterScenario> = [
  { tag: 'filter-decimal-ne', name: 'Decimal: ne', category: 'filter', dataType: 'decimal', op: 'ne', fieldParam: 'decimalField', valueParam: 'decimalValueLow', minVersion: '2.0.0' },
  { tag: 'filter-decimal-gt', name: 'Decimal: gt', category: 'filter', dataType: 'decimal', op: 'gt', fieldParam: 'decimalField', valueParam: 'decimalValueMin', minVersion: '2.0.0' },
  { tag: 'filter-decimal-ge', name: 'Decimal: ge', category: 'filter', dataType: 'decimal', op: 'ge', fieldParam: 'decimalField', valueParam: 'decimalValueLow', minVersion: '2.0.0' },
  { tag: 'filter-decimal-lt', name: 'Decimal: lt', category: 'filter', dataType: 'decimal', op: 'lt', fieldParam: 'decimalField', valueParam: 'decimalValueMax', minVersion: '2.0.0' },
  { tag: 'filter-decimal-le', name: 'Decimal: le', category: 'filter', dataType: 'decimal', op: 'le', fieldParam: 'decimalField', valueParam: 'decimalValueHigh', minVersion: '2.0.0' },
];

const dateFilterScenarios: ReadonlyArray<FilterScenario> = [
  { tag: 'filter-date-eq', name: 'Date: eq', category: 'filter', dataType: 'date', op: 'eq', fieldParam: 'dateField', valueParam: 'dateValue', minVersion: '2.0.0' },
  { tag: 'filter-date-ne', name: 'Date: ne', category: 'filter', dataType: 'date', op: 'ne', fieldParam: 'dateField', valueParam: 'dateValue', minVersion: '2.0.0' },
  { tag: 'filter-date-gt', name: 'Date: gt', category: 'filter', dataType: 'date', op: 'gt', fieldParam: 'dateField', valueParam: 'dateValueMin', minVersion: '2.0.0' },
  { tag: 'filter-date-ge', name: 'Date: ge', category: 'filter', dataType: 'date', op: 'ge', fieldParam: 'dateField', valueParam: 'dateValue', minVersion: '2.0.0' },
  { tag: 'filter-date-lt', name: 'Date: lt', category: 'filter', dataType: 'date', op: 'lt', fieldParam: 'dateField', valueParam: 'dateValueMax', minVersion: '2.0.0' },
  { tag: 'filter-date-le', name: 'Date: le', category: 'filter', dataType: 'date', op: 'le', fieldParam: 'dateField', valueParam: 'dateValue', minVersion: '2.0.0' },
];

const datetimeFilterScenarios: ReadonlyArray<FilterScenario> = [
  { tag: 'filter-datetime-gt', name: 'Timestamp: gt', category: 'filter', dataType: 'datetime', op: 'gt', fieldParam: 'timestampField', valueParam: 'datetimeValue', minVersion: '2.0.0' },
  { tag: 'filter-datetime-ge', name: 'Timestamp: ge', category: 'filter', dataType: 'datetime', op: 'ge', fieldParam: 'timestampField', valueParam: 'datetimeValue', minVersion: '2.0.0' },
  { tag: 'filter-datetime-lt-now', name: 'Timestamp: lt now()', category: 'filter', dataType: 'datetime', op: 'lt', fieldParam: 'timestampField', valueParam: 'now', minVersion: '2.0.0' },
  { tag: 'filter-datetime-le-now', name: 'Timestamp: le now()', category: 'filter', dataType: 'datetime', op: 'le', fieldParam: 'timestampField', valueParam: 'now', minVersion: '2.0.0' },
  { tag: 'filter-datetime-ne-now', name: 'Timestamp: ne now()', category: 'filter', dataType: 'datetime', op: 'ne', fieldParam: 'timestampField', valueParam: 'now', minVersion: '2.0.0' },
];

const orderByScenarios: ReadonlyArray<OrderByScenario> = [
  { tag: 'orderby-timestamp-asc', name: 'OrderBy: asc', category: 'orderby', fieldParam: 'timestampField', direction: 'asc', minVersion: '2.0.0' },
  { tag: 'orderby-timestamp-desc', name: 'OrderBy: desc', category: 'orderby', fieldParam: 'timestampField', direction: 'desc', minVersion: '2.0.0' },
  { tag: 'orderby-timestamp-asc-filter-int-gt', name: 'OrderBy: asc + int filter', category: 'orderby', fieldParam: 'timestampField', direction: 'asc', filter: { fieldParam: 'integerField', op: 'gt', valueParam: 'integerValueLow', dataType: 'integer' }, minVersion: '2.0.0' },
  { tag: 'orderby-timestamp-desc-filter-int-gt', name: 'OrderBy: desc + int filter', category: 'orderby', fieldParam: 'timestampField', direction: 'desc', filter: { fieldParam: 'integerField', op: 'gt', valueParam: 'integerValueLow', dataType: 'integer' }, minVersion: '2.0.0' },
];

const enumScenarios: ReadonlyArray<EnumScenario> = [
  { tag: 'filter-enum-single-has', name: 'Single enum: has', category: 'enum', enumType: 'single', op: 'has', fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.0.0' },
  { tag: 'filter-enum-single-eq', name: 'Single enum: eq', category: 'enum', enumType: 'single', op: 'eq', fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.0.0' },
  { tag: 'filter-enum-ne', name: 'Single enum: ne', category: 'enum', enumType: 'single', op: 'ne', fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.0.0' },
  { tag: 'filter-enum-multi-has', name: 'Multi enum: has', category: 'enum', enumType: 'multi', op: 'has', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', minVersion: '2.0.0' },
  { tag: 'filter-enum-multi-has-and', name: 'Multi enum: has + and', category: 'enum', enumType: 'multi', op: 'has', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', valueParam2: 'multiLookupValue2', minVersion: '2.0.0' },
];

const collectionScenarios: ReadonlyArray<CollectionScenario> = [
  { tag: 'filter-coll-enum-any', name: 'Collection: any()', category: 'collection', lambda: 'any', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', minVersion: '2.0.0' },
  { tag: 'filter-coll-enum-all', name: 'Collection: all()', category: 'collection', lambda: 'all', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', minVersion: '2.0.0' },
];

const errorScenarios: ReadonlyArray<ErrorScenario> = [
  { tag: 'response-code-400', name: '400 Bad Request', category: 'error', expectedStatus: 400, minVersion: '2.0.0' },
  { tag: 'response-code-404', name: '404 Not Found', category: 'error', expectedStatus: 404, minVersion: '2.0.0' },
];

// ── v2.1.0 Additional Scenarios ──

const stringEnumScenarios: ReadonlyArray<StringEnumScenario> = [
  { tag: 'filter-string-enum-single-eq', name: 'String enum: eq', category: 'string-enum', enumType: 'single', op: 'eq', fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.1.0' },
  { tag: 'filter-string-enum-single-ne', name: 'String enum: ne', category: 'string-enum', enumType: 'single', op: 'ne', fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.1.0' },
  { tag: 'filter-string-enum-multi-any', name: 'String enum collection: any()', category: 'string-enum', enumType: 'multi', op: 'any', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', valueParam2: 'multiLookupValue2', minVersion: '2.1.0' },
  { tag: 'filter-string-enum-multi-all', name: 'String enum collection: all()', category: 'string-enum', enumType: 'multi', op: 'all', fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', valueParam2: 'multiLookupValue2', minVersion: '2.1.0' },
];

// String function filters — OPTIONAL ("Optional Tests"): not required for Core
// certification per the workgroup. A failure renders "Not Supported", never a
// Core fail. Restored from the pre-RCP-039 set, now tagged optional.
const stringFunctionScenarios: ReadonlyArray<StringFunctionScenario> = [
  { tag: 'filter-string-contains', name: 'String: contains()', category: 'string-function', func: 'contains', fieldParam: 'stringField', valueParam: 'stringValue', minVersion: '2.1.0', optional: true },
  { tag: 'filter-string-startswith', name: 'String: startswith()', category: 'string-function', func: 'startswith', fieldParam: 'stringField', valueParam: 'stringValue', minVersion: '2.1.0', optional: true },
  { tag: 'filter-string-endswith', name: 'String: endswith()', category: 'string-function', func: 'endswith', fieldParam: 'stringField', valueParam: 'stringValue', minVersion: '2.1.0', optional: true },
];

const pagingScenarios: ReadonlyArray<PagingScenario> = [
  { tag: 'server-driven-paging', name: 'Server-driven paging (nextLink)', category: 'paging', assertion: 'nextLink', minVersion: '2.1.0' },
];

const expandScenarios: ReadonlyArray<ExpandScenario> = [
  { tag: 'expand', name: '$expand navigation property', category: 'expand', fieldParam: 'expandField', minVersion: '2.1.0' },
];

// Runs first among string-enum tests; cascade-skip applies to dependent
// scenarios if the LookupName / sample values aren't present in the
// Lookup Resource. Per RCP-039.
const lookupResourceScenarios: ReadonlyArray<LookupResourceValidationScenario> = [
  { tag: 'lookup-resource-validation', name: 'Lookup Resource: LookupName and sample values present', category: 'lookup-resource', assertion: 'lookup-resource-validation', fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.1.0' },
];

// OData 4.01 in-operator. Gated on the response advertising OData-Version 4.01.
// Per RCP-039: `GET /Property?$filter=StandardStatus in ('Active', 'Pending', 'Sold')`.
const inOperatorScenarios: ReadonlyArray<InOperatorScenario> = [
  { tag: 'filter-string-enum-single-in', name: 'String enum: in (...)', category: 'in-operator', enumType: 'single', fieldParam: 'singleLookupField', valueParams: ['singleLookupValue', 'singleLookupValue2', 'singleLookupValue3'], minVersion: '2.1.0' },
];

// ── All Scenarios ──

export const allScenarios: ReadonlyArray<CoreScenario> = [
  ...structuralScenarios,
  ...integerFilterScenarios,
  ...decimalFilterScenarios,
  ...dateFilterScenarios,
  ...datetimeFilterScenarios,
  ...orderByScenarios,
  ...enumScenarios,
  ...collectionScenarios,
  ...errorScenarios,
  ...lookupResourceScenarios,
  ...stringEnumScenarios,
  ...stringFunctionScenarios,
  ...inOperatorScenarios,
  ...pagingScenarios,
  ...expandScenarios,
];

/** Get scenarios applicable to a given version. */
export const scenariosForVersion = (version: '2.0.0' | '2.1.0'): ReadonlyArray<CoreScenario> =>
  version === '2.0.0'
    ? allScenarios.filter(s => s.minVersion === '2.0.0')
    : allScenarios;
