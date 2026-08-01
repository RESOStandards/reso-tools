/**
 * Web API Core assertion primitives.
 *
 * Five primitives cover all 45+ scenarios. Each returns a result
 * with passed/failed status and a diagnostic message.
 */

import type { ODataResponse } from '../test-runner/types.js';
import type { ComparisonOp, DataType, SortDirection } from './scenarios.js';

/** Result of a single assertion. */
export interface AssertionResult {
  readonly passed: boolean;
  readonly message: string;
}

// ── Comparison operators ──

const numericOps: Readonly<Record<ComparisonOp, (a: number, b: number) => boolean>> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  ge: (a, b) => a >= b,
  lt: (a, b) => a < b,
  le: (a, b) => a <= b,
};

const temporalOps: Readonly<Record<ComparisonOp, (a: string, b: string) => boolean>> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  ge: (a, b) => a >= b,
  lt: (a, b) => a < b,
  le: (a, b) => a <= b,
};

/** Get the appropriate comparison function for a data type and operator. */
const compareValue = (actual: unknown, op: ComparisonOp, expected: unknown, dataType: DataType): boolean => {
  if (actual == null) return true; // null values are excluded from filter results by OData spec

  switch (dataType) {
    case 'integer':
    case 'decimal':
      return numericOps[op](Number(actual), Number(expected));
    case 'date':
    case 'datetime':
      return temporalOps[op](String(actual), String(expected));
  }
};

// ── Assertion Primitives ──

/**
 * Assert that every record's field value satisfies a comparison.
 * Covers all integer, decimal, date, and datetime filter scenarios.
 */
export const assertScalarComparison = (
  records: ReadonlyArray<Record<string, unknown>>,
  field: string,
  op: ComparisonOp,
  value: unknown,
  dataType: DataType,
): AssertionResult => {
  const failures: string[] = [];

  for (const [i, record] of records.entries()) {
    const actual = record[field];
    if (actual == null) continue;
    if (!compareValue(actual, op, value, dataType)) {
      failures.push(`Record ${i}: ${field}=${JSON.stringify(actual)} does not satisfy ${op} ${JSON.stringify(value)}`);
    }
  }

  return failures.length === 0
    ? { passed: true, message: `All ${records.length} records satisfy ${field} ${op} ${JSON.stringify(value)}` }
    : { passed: false, message: `${failures.length}/${records.length} records failed: ${failures[0]}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''}` };
};

/**
 * Assert that field values are monotonically sorted.
 * Covers orderby-timestamp-asc/desc scenarios.
 */
export const assertSortOrder = (
  records: ReadonlyArray<Record<string, unknown>>,
  field: string,
  direction: SortDirection,
): AssertionResult => {
  const values = records.map(r => r[field]).filter(v => v != null);

  for (let i = 1; i < values.length; i++) {
    const prev = String(values[i - 1]);
    const curr = String(values[i]);
    const ordered = direction === 'asc' ? prev <= curr : prev >= curr;
    if (!ordered) {
      return {
        passed: false,
        message: `Sort order violated at position ${i}: ${prev} should be ${direction === 'asc' ? '<=' : '>='} ${curr}`,
      };
    }
  }

  return { passed: true, message: `${values.length} values correctly sorted ${direction}` };
};

/**
 * Assert single-value enumeration filtering.
 * Covers enum has/eq/ne scenarios.
 */
export const assertEnumMatch = (
  records: ReadonlyArray<Record<string, unknown>>,
  field: string,
  op: 'has' | 'eq' | 'ne',
  value: string,
  /** Decode a response value into member names for `has` — a flags enum may serialize as an integer
   *  bitmask. Omitted for `eq`/`ne`, whose single-member string compares directly. */
  decode?: (raw: unknown) => ReadonlyArray<string>,
): AssertionResult => {
  const failures: string[] = [];

  for (const [i, record] of records.entries()) {
    const actual = record[field];
    if (actual == null) continue;

    const actualStr = String(actual);
    const matches = op === 'has'
      ? (decode ? decode(actual) : actualStr.split(',').map(s => s.trim())).includes(value)
      : op === 'eq'
        ? actualStr === value
        : actualStr !== value;

    if (!matches) {
      failures.push(`Record ${i}: ${field}=${JSON.stringify(actual)} does not satisfy ${op} ${JSON.stringify(value)}`);
    }
  }

  return failures.length === 0
    ? { passed: true, message: `All ${records.length} records satisfy enum ${op} ${JSON.stringify(value)}` }
    : { passed: false, message: `${failures.length} records failed enum check: ${failures[0]}` };
};

/**
 * Assert multi-value enumeration / collection lambda operations.
 * Covers has on multi-value fields, any(), and all() scenarios.
 */
export const assertCollectionLambda = (
  records: ReadonlyArray<Record<string, unknown>>,
  field: string,
  op: 'has' | 'any' | 'all',
  values: ReadonlyArray<string>,
  /** Decode a response value into member names — a flags enum may serialize as an integer bitmask or a
   *  comma-joined string. Supplied for flags fields so the assertion compares like-for-like; omitted for
   *  string collections, where the array / comma fallback below is correct. */
  decode?: (raw: unknown) => ReadonlyArray<string>,
): AssertionResult => {
  const failures: string[] = [];
  // Drop empty / literal-"undefined" values (a retried candidate may have fewer than N distinct values);
  // comparing against them would false-fail every record.
  const checkValues = values.filter((v): v is string => typeof v === 'string' && v.length > 0 && v !== 'undefined');
  if (checkValues.length === 0) {
    return { passed: false, message: `${op}(): no valid comparison values available` };
  }

  for (const [i, record] of records.entries()) {
    const actual = record[field];
    if (actual == null) continue;

    const items: ReadonlyArray<string> = decode
      ? decode(actual)
      : Array.isArray(actual)
        ? (actual as unknown[]).map(String)
        : String(actual).split(',').map(s => s.trim());

    const matches = op === 'any'
      ? checkValues.some(v => items.includes(v)) // any(x: x eq A [or B]) — at least one element is a requested value
      : op === 'has'
        ? checkValues.every(v => items.includes(v)) // has A [and has B] — EVERY requested flag must be set (AND)
        : items.every(item => checkValues.includes(item)); // all(x: x eq A [or B]) — EVERY element is within {values}

    if (!matches) {
      failures.push(`Record ${i}: ${field}=${JSON.stringify(actual)} does not satisfy ${op}(${checkValues.join(', ')})`);
    }
  }

  return failures.length === 0
    ? { passed: true, message: `All ${records.length} records satisfy collection ${op}` }
    : { passed: false, message: `${failures.length} records failed: ${failures[0]}` };
};

/**
 * Assert structural OData response properties.
 * Checks status code, OData-Version header, and valid JSON.
 */
export const assertODataResponse = (
  response: ODataResponse,
  expectedStatus: number,
): AssertionResult => {
  if (response.status !== expectedStatus) {
    return { passed: false, message: `Expected HTTP ${expectedStatus}, got ${response.status}` };
  }

  if (expectedStatus >= 400) {
    return { passed: true, message: `Server returned expected ${expectedStatus}` };
  }

  const odataVersion = response.headers['odata-version'];
  if (!odataVersion) {
    return { passed: false, message: 'Missing OData-Version response header' };
  }
  if (odataVersion !== '4.0' && odataVersion !== '4.01') {
    return { passed: false, message: `Invalid OData-Version: ${odataVersion} (expected 4.0 or 4.01)` };
  }

  if (response.body == null) {
    return { passed: false, message: 'Response body is null' };
  }

  return { passed: true, message: `HTTP ${expectedStatus}, OData-Version ${odataVersion}` };
};

/**
 * Assert that response has results (non-empty value array).
 */
export const assertHasResults = (body: unknown): AssertionResult => {
  const records = extractRecords(body);
  return records.length > 0
    ? { passed: true, message: `${records.length} records returned` }
    : { passed: false, message: 'No records in response' };
};

/**
 * Assert string comparison results (contains, startswith, endswith).
 */
export const assertStringComparison = (
  records: ReadonlyArray<Record<string, unknown>>,
  field: string,
  op: 'eq' | 'ne',
  value: string,
): AssertionResult => {
  const failures: string[] = [];

  for (const [i, record] of records.entries()) {
    const actual = record[field];
    if (actual == null) continue;
    const actualStr = String(actual);
    const matches = op === 'eq' ? actualStr === value : actualStr !== value;
    if (!matches) {
      failures.push(`Record ${i}: ${field}=${JSON.stringify(actualStr)} does not satisfy ${op} ${JSON.stringify(value)}`);
    }
  }

  return failures.length === 0
    ? { passed: true, message: `All ${records.length} records satisfy string ${op}` }
    : { passed: false, message: `${failures.length} records failed: ${failures[0]}` };
};

// ── Helpers ──

/** Extract the records array from an OData response body. */
export const extractRecords = (body: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (body == null || typeof body !== 'object') return [];
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.value)) return obj.value as ReadonlyArray<Record<string, unknown>>;
  // Singleton result (fetch-by-key)
  if ('value' in obj) return [];
  return [obj as Record<string, unknown>];
};

/** Extract @odata.count from response body. */
export const extractCount = (body: unknown): number | undefined => {
  if (body == null || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const count = obj['@odata.count'];
  return typeof count === 'number' ? count : undefined;
};

/** Extract @odata.nextLink from response body. */
export const extractNextLink = (body: unknown): string | undefined => {
  if (body == null || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const link = obj['@odata.nextLink'];
  return typeof link === 'string' ? link : undefined;
};
