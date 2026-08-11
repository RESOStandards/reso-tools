/**
 * Local-field type aggregation for RCF schema inference (C3).
 *
 * A local (non-DD) field is observed across many sampled records; `inferType`
 * types each value. This folds those per-value types into ONE field descriptor:
 * widen integers to the largest observed width, take the max Decimal
 * scale/precision and the max string length, mark nullable when any value was
 * null/blank, and detect collections and expansions. When observations disagree
 * irreconcilably, `Edm.String` is the safe container.
 *
 * DD (reference) fields never come here — their types come from reference
 * metadata (ground truth). This is only for fields absent from the reference.
 */

import { inferType } from './infer-type.js';
import { isValidValue } from './values.js';

export interface AggregatedFieldType {
  readonly type: string;
  readonly isCollection?: boolean;
  readonly isExpansion?: boolean;
  readonly nullable?: boolean;
  readonly maxLength?: number;
  readonly scale?: number;
  readonly precision?: number;
}

/** Edm integer widths, smallest → largest, for widening. */
const INT_WIDTH: Readonly<Record<string, number>> = { 'Edm.Int16': 1, 'Edm.Int32': 2, 'Edm.Int64': 3 };

const widestInt = (types: ReadonlyArray<string>): string =>
  types.reduce((widest, t) => ((INT_WIDTH[t] ?? 0) > (INT_WIDTH[widest] ?? 0) ? t : widest), 'Edm.Int16');

// Max of a numeric list by reduction, NOT `Math.max(0, ...nums)`: a collection field flattens to its
// element values, which can exceed the argument-count limit (~125k in V8) and overflow the call stack.
const maxOf = (nums: ReadonlyArray<number>): number => nums.reduce((m, n) => (n > m ? n : m), 0);

const withNullable = (base: AggregatedFieldType, nullable: boolean): AggregatedFieldType =>
  nullable ? { ...base, nullable: true } : base;

/**
 * Fold a local field's raw sampled values into a single type descriptor.
 * Recurses element-wise for collections. `nullable` reflects the whole field
 * (any null/blank observation), independent of collection depth.
 */
export const aggregateFieldType = (values: ReadonlyArray<unknown>): AggregatedFieldType => {
  const nullable = values.some(v => !isValidValue(v));
  const valid = values.filter(isValidValue);
  if (valid.length === 0) return withNullable({ type: 'Edm.String' }, nullable);

  // Collection: any observation is an array → aggregate the flattened element values.
  const arrays = valid.filter(Array.isArray);
  if (arrays.length > 0) {
    const elementAgg = aggregateFieldType(arrays.flat());
    return { ...elementAgg, isCollection: true, ...(nullable ? { nullable: true } : {}) };
  }

  // Nested object → an expansion / custom complex type.
  if (valid.some(v => typeof v === 'object')) {
    return withNullable({ type: 'Custom Type', isExpansion: true }, nullable);
  }

  const inferred = valid.map(inferType);
  const types = [...new Set(inferred.map(t => t.type).filter((t): t is string => typeof t === 'string'))];

  // Numeric: all integers → widest; any decimal in the mix → Decimal with max scale/precision.
  if (types.every(t => t in INT_WIDTH)) {
    return withNullable({ type: widestInt(types) }, nullable);
  }
  if (types.every(t => t in INT_WIDTH || t === 'Edm.Decimal')) {
    const scale = maxOf(inferred.map(t => t.scale ?? 0));
    // precision must cover the widest integer part PLUS the deepest fractional part — taking
    // independent maxes (and letting integers contribute 0) under-counts, e.g. [12345, 1.5]
    // would give precision 2, which cannot hold 12345.
    const intDigits = maxOf(valid.map(v => (typeof v === 'number' ? Math.abs(Math.trunc(v)).toString().length : 0)));
    const precision = intDigits + scale;
    return withNullable(
      { type: 'Edm.Decimal', ...(scale ? { scale } : {}), ...(precision ? { precision } : {}) },
      nullable,
    );
  }

  // A single homogeneous temporal type is kept; strings (or any string/temporal mix) → Edm.String
  // with the max observed length.
  if (types.length === 1 && (types[0] === 'Edm.Date' || types[0] === 'Edm.DateTimeOffset' || types[0] === 'Edm.Boolean')) {
    return withNullable({ type: types[0] }, nullable);
  }
  if (types.every(t => t === 'Edm.String' || t === 'Edm.Date' || t === 'Edm.DateTimeOffset')) {
    const maxLength = maxOf(valid.map(v => (typeof v === 'string' ? v.length : 0)));
    return withNullable({ type: 'Edm.String', ...(maxLength ? { maxLength } : {}) }, nullable);
  }

  // Anything else (genuinely mixed incompatible types) → Edm.String is the safe container.
  return withNullable({ type: 'Edm.String' }, nullable);
};
