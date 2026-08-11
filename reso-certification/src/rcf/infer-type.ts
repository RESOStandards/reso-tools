/**
 * Per-value DD type inference for RESO Common Format (RCF) schema inference.
 *
 * RCF payloads carry values, not a schema. To run the DD-2.0 machinery (schema
 * validation + variations) against RCF data we must INFER a DD-2.0 metadata
 * report from the sampled records. This module is the leaf: turn a single
 * sampled JSON value into an OData/DD `Edm.*` type descriptor, purely
 * structurally (no reference metadata). The aggregation layer combines many of
 * these across a field's sampled values.
 *
 * Clean-room reimplementation from the RESO Common Format reference behavior;
 * the rules (integer width by range, Decimal scale/precision by digit count,
 * ISO date/datetime probing) are chosen so an inferred report matches what the
 * reference tooling produced, which is what downstream schema/variations expect.
 */

/** A structural type descriptor inferred from one or more sampled values. */
export interface InferredType {
  /** The Edm.* type for a scalar, or the sentinel `'null'` / `'object'`. Absent for a collection. */
  readonly type?: string;
  /** Element type descriptors, present when the value was an array. */
  readonly types?: ReadonlyArray<InferredType>;
  readonly isCollection?: boolean;
  /** True when the value is (or contains) a nested object — a candidate expansion. */
  readonly isExpansion?: boolean;
  readonly nullable?: boolean;
  /** Fractional-digit count for `Edm.Decimal`. */
  readonly scale?: number;
  /** Total-digit count (dot removed) for `Edm.Decimal`. */
  readonly precision?: number;
}

const INT16_MIN = -32768;
const INT16_MAX = 32767;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// ISO 8601 date-time with a required timezone offset (Z or ±HH:MM); fractional seconds optional.
const ISO_DATETIME_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A strict `YYYY-MM-DD` that is also a real calendar date (round-trips through UTC). */
export const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** A strict ISO 8601 date-time with a timezone offset that is also a real instant. */
export const isValidIsoDateTimeOffset = (value: string): boolean =>
  ISO_DATETIME_OFFSET.test(value) && !Number.isNaN(Date.parse(value));

/**
 * Classify a JS number: integers narrow to the smallest Edm integer that holds
 * them (Int16 → Int32 → Int64); non-integers become Edm.Decimal with scale =
 * fractional-digit count and precision = total-digit count (dot removed).
 */
export const analyzeNumber = (n: number): InferredType => {
  if (Number.isInteger(n)) {
    if (n >= INT16_MIN && n <= INT16_MAX) return { type: 'Edm.Int16' };
    if (n >= INT32_MIN && n <= INT32_MAX) return { type: 'Edm.Int32' };
    return { type: 'Edm.Int64' };
  }
  const str = Math.abs(n).toString();
  // Exponential notation (very small/large magnitudes) has no meaningful fixed
  // digit count — still Edm.Decimal, but without asserting scale/precision.
  if (str.includes('e') || str.includes('E')) return { type: 'Edm.Decimal' };
  const [intPart, fracPart = ''] = str.split('.');
  return { type: 'Edm.Decimal', scale: fracPart.length, precision: intPart.length + fracPart.length };
};

/**
 * Infer a type descriptor from one sampled JSON value.
 * - array   → `{ isCollection, types: [...], isExpansion: any element is }`
 * - null    → `{ type: 'null', nullable: true }`
 * - object  → `{ type: 'object', isExpansion: true }`
 * - boolean → `Edm.Boolean`; number → {@link analyzeNumber}
 * - string  → `Edm.Date` / `Edm.DateTimeOffset` (ISO probe) else `Edm.String`
 */
export const inferType = (value: unknown): InferredType => {
  if (Array.isArray(value)) {
    const types = value.map(inferType);
    return { isCollection: true, types, isExpansion: types.some(t => t.isExpansion === true) };
  }
  if (value === null) return { type: 'null', nullable: true };
  switch (typeof value) {
    case 'boolean':
      return { type: 'Edm.Boolean' };
    case 'number':
      return analyzeNumber(value);
    case 'string':
      if (isValidIsoDate(value)) return { type: 'Edm.Date' };
      if (isValidIsoDateTimeOffset(value)) return { type: 'Edm.DateTimeOffset' };
      return { type: 'Edm.String' };
    case 'object':
      // typeof null is 'object' but null is handled above; this is a real nested object.
      return { type: 'object', isExpansion: true };
    default:
      // undefined/function/symbol cannot appear in parsed JSON; treat as a string leaf.
      return { type: 'Edm.String' };
  }
};
