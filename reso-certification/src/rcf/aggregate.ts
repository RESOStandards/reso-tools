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

const withNullable = (base: AggregatedFieldType, nullable: boolean): AggregatedFieldType => (nullable ? { ...base, nullable: true } : base);

/** A local field's type, gathered a value at a time, so a field's values never have to be held together. */
export interface FieldTypeFold {
  readonly add: (value: unknown) => void;
  readonly result: () => AggregatedFieldType;
}

/**
 * Fold a local field's values into a single type descriptor, one value at a time. Recurses element-wise for
 * collections. `nullable` reflects the whole field (any null/blank observation), independent of collection depth.
 * The result is the same whatever the number of values: each part is a count, a flag, a set of types or a maximum.
 */
export const createFieldTypeFold = (): FieldTypeFold => {
  let nullable = false;
  let valid = 0;
  // The elements of every array observation, folded as a field of their own. Present once any array is seen.
  let elements: FieldTypeFold | undefined;
  let objectSeen = false;
  // Over the scalar observations: what they are typed as, the deepest scale, the widest integer part, the longest string.
  const types = new Set<string>();
  let scale = 0;
  let intDigits = 0;
  let maxLength = 0;

  const add = (value: unknown): void => {
    if (!isValidValue(value)) {
      nullable = true;
      return;
    }
    valid += 1;
    if (Array.isArray(value)) {
      elements ??= createFieldTypeFold();
      for (const element of value) elements.add(element);
      return;
    }
    if (typeof value === 'object') {
      objectSeen = true;
      return;
    }
    const inferred = inferType(value);
    if (typeof inferred.type === 'string') types.add(inferred.type);
    if ((inferred.scale ?? 0) > scale) scale = inferred.scale ?? 0;
    if (typeof value === 'number') intDigits = Math.max(intDigits, Math.abs(Math.trunc(value)).toString().length);
    if (typeof value === 'string') maxLength = Math.max(maxLength, value.length);
  };

  const result = (): AggregatedFieldType => {
    if (valid === 0) return withNullable({ type: 'Edm.String' }, nullable);

    // Collection: any observation is an array → the aggregate of the flattened element values.
    if (elements) return { ...elements.result(), isCollection: true, ...(nullable ? { nullable: true } : {}) };

    // Nested object → an expansion / custom complex type.
    if (objectSeen) return withNullable({ type: 'Custom Type', isExpansion: true }, nullable);

    const observed = [...types];
    // Numeric: all integers → widest; any decimal in the mix → Decimal with max scale/precision.
    if (observed.every(t => t in INT_WIDTH)) return withNullable({ type: widestInt(observed) }, nullable);
    if (observed.every(t => t in INT_WIDTH || t === 'Edm.Decimal')) {
      // precision must cover the widest integer part PLUS the deepest fractional part. Taking
      // independent maxes (and letting integers contribute 0) under-counts, e.g. [12345, 1.5]
      // would give precision 2, which cannot hold 12345.
      const precision = intDigits + scale;
      return withNullable({ type: 'Edm.Decimal', ...(scale ? { scale } : {}), ...(precision ? { precision } : {}) }, nullable);
    }

    // A single homogeneous temporal type is kept; strings (or any string/temporal mix) → Edm.String
    // with the max observed length.
    if (observed.length === 1 && (observed[0] === 'Edm.Date' || observed[0] === 'Edm.DateTimeOffset' || observed[0] === 'Edm.Boolean')) {
      return withNullable({ type: observed[0] }, nullable);
    }
    if (observed.every(t => t === 'Edm.String' || t === 'Edm.Date' || t === 'Edm.DateTimeOffset')) {
      return withNullable({ type: 'Edm.String', ...(maxLength ? { maxLength } : {}) }, nullable);
    }

    // Anything else (genuinely mixed incompatible types) → Edm.String is the safe container.
    return withNullable({ type: 'Edm.String' }, nullable);
  };

  return { add, result };
};

/** Fold a local field's values into a single type descriptor (see {@link createFieldTypeFold}). */
export const aggregateFieldType = (values: ReadonlyArray<unknown>): AggregatedFieldType => {
  const fold = createFieldTypeFold();
  for (const value of values) fold.add(value);
  return fold.result();
};
