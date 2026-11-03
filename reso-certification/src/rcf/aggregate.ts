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

/**
 * A local field's type, gathered a value at a time so a field's values never have to be held together. Every part is a
 * count, a flag, a set of types or a maximum, so the state is the same whatever the number of values, and two states
 * merge into the one their values would give together.
 */
export interface FieldTypeState {
  nullable: boolean;
  valid: number;
  /** The elements of every array observation, folded as a field of their own. Present once any array is seen. */
  elements?: FieldTypeState;
  objectSeen: boolean;
  /** Over the scalar observations: what they are typed as, the deepest scale, the widest integer part, the longest string. */
  readonly types: Set<string>;
  scale: number;
  intDigits: number;
  maxLength: number;
}

export const newFieldTypeState = (): FieldTypeState => ({
  nullable: false,
  valid: 0,
  objectSeen: false,
  types: new Set<string>(),
  scale: 0,
  intDigits: 0,
  maxLength: 0
});

/** Fold one value into a field's type state. Recurses element-wise for collections. */
export const addToFieldType = (state: FieldTypeState, value: unknown): void => {
  if (!isValidValue(value)) {
    state.nullable = true;
    return;
  }
  state.valid += 1;
  if (Array.isArray(value)) {
    const elements = state.elements ?? newFieldTypeState();
    state.elements = elements;
    for (const element of value) addToFieldType(elements, element);
    return;
  }
  if (typeof value === 'object') {
    state.objectSeen = true;
    return;
  }
  const inferred = inferType(value);
  if (typeof inferred.type === 'string') state.types.add(inferred.type);
  state.scale = Math.max(state.scale, inferred.scale ?? 0);
  if (typeof value === 'number') state.intDigits = Math.max(state.intDigits, Math.abs(Math.trunc(value)).toString().length);
  if (typeof value === 'string') state.maxLength = Math.max(state.maxLength, value.length);
};

/** The type state of two fields' values taken together. */
export const mergeFieldTypes = (a: FieldTypeState, b: FieldTypeState): FieldTypeState => {
  const elements = a.elements && b.elements ? mergeFieldTypes(a.elements, b.elements) : (a.elements ?? b.elements);
  return {
    nullable: a.nullable || b.nullable,
    valid: a.valid + b.valid,
    ...(elements ? { elements } : {}),
    objectSeen: a.objectSeen || b.objectSeen,
    types: new Set([...a.types, ...b.types]),
    scale: Math.max(a.scale, b.scale),
    intDigits: Math.max(a.intDigits, b.intDigits),
    maxLength: Math.max(a.maxLength, b.maxLength)
  };
};

/**
 * A field's single type descriptor from its folded values. `nullable` reflects the whole field (any null/blank
 * observation), independent of collection depth.
 */
export const fieldTypeOf = (state: FieldTypeState): AggregatedFieldType => {
  const { nullable } = state;
  if (state.valid === 0) return withNullable({ type: 'Edm.String' }, nullable);

  // Collection: any observation is an array → the aggregate of the flattened element values.
  if (state.elements) return { ...fieldTypeOf(state.elements), isCollection: true, ...(nullable ? { nullable: true } : {}) };

  // Nested object → an expansion / custom complex type.
  if (state.objectSeen) return withNullable({ type: 'Custom Type', isExpansion: true }, nullable);

  const observed = [...state.types];
  // Numeric: all integers → widest; any decimal in the mix → Decimal with max scale/precision.
  if (observed.every(t => t in INT_WIDTH)) return withNullable({ type: widestInt(observed) }, nullable);
  if (observed.every(t => t in INT_WIDTH || t === 'Edm.Decimal')) {
    // precision must cover the widest integer part PLUS the deepest fractional part. Taking
    // independent maxes (and letting integers contribute 0) under-counts, e.g. [12345, 1.5]
    // would give precision 2, which cannot hold 12345.
    const { scale } = state;
    const precision = state.intDigits + scale;
    return withNullable({ type: 'Edm.Decimal', ...(scale ? { scale } : {}), ...(precision ? { precision } : {}) }, nullable);
  }

  // A single homogeneous temporal type is kept; strings (or any string/temporal mix) → Edm.String
  // with the max observed length.
  if (observed.length === 1 && (observed[0] === 'Edm.Date' || observed[0] === 'Edm.DateTimeOffset' || observed[0] === 'Edm.Boolean')) {
    return withNullable({ type: observed[0] }, nullable);
  }
  if (observed.every(t => t === 'Edm.String' || t === 'Edm.Date' || t === 'Edm.DateTimeOffset')) {
    const { maxLength } = state;
    return withNullable({ type: 'Edm.String', ...(maxLength ? { maxLength } : {}) }, nullable);
  }

  // Anything else (genuinely mixed incompatible types) → Edm.String is the safe container.
  return withNullable({ type: 'Edm.String' }, nullable);
};

/** Fold a local field's values into a single type descriptor. */
export const aggregateFieldType = (values: ReadonlyArray<unknown>): AggregatedFieldType => {
  const state = newFieldTypeState();
  for (const value of values) addToFieldType(state, value);
  return fieldTypeOf(state);
};
