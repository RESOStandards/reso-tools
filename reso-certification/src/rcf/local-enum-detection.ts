/**
 * Local-field enum-vs-free-text detection for RCF schema inference.
 *
 * The one genuinely-hard inference call. A local (non-DD) string field's values
 * are all `Edm.String`, but the field is either an *enumeration* (a bounded,
 * repeating set of values → emit local lookups) or *free text* (Remarks, Address
 * → a plain string field, no lookups). The only signal is repetition: an enum's
 * distinct value set is bounded and repeats as records accumulate; free text's
 * distinct set grows ~linearly with the sample.
 *
 * DD fields never reach here — their lookup-ness is known from reference
 * metadata. This applies ONLY to local fields, and the cost is asymmetric:
 * mis-flagging high-cardinality free text (Remarks) as an enum dumps thousands
 * of "lookup values" into the report and the /compute payload, while missing a
 * real local enum only costs a few variation suggestions. So the bias is
 * deliberately conservative — return 'enum' only on clear evidence, else 'free-text'.
 *
 * Thresholds are tunable constants with defaults chosen to be safe; they are
 * meant to be calibrated against real RCF samples during the e2e phase.
 */

import { isValidValue } from './values.js';

/** Minimum observed values before a verdict is trustworthy — never decide on a tiny sample. */
export const ENUM_MIN_SAMPLE = 30;
/** distinct / total at or below this reads as a bounded, repeating (enum) set. */
export const ENUM_MAX_DISTINCT_RATIO = 0.5;
/** A local enum's value set is bounded; beyond this many distinct values it is free text. */
export const ENUM_MAX_DISTINCT = 250;

export interface StringFieldStats {
  /** Count of usable (non-blank, non-numeric-looking) string observations. */
  readonly total: number;
  /** Distinct usable values among them. */
  readonly distinct: number;
}

/**
 * Reduce a field's raw sampled values to enum-detection stats: keep non-blank
 * strings, drop numeric-looking strings (those are numbers-as-strings, not enum
 * members), and count total vs distinct.
 */
export const stringFieldStats = (values: ReadonlyArray<unknown>): StringFieldStats => {
  const usable = values.filter(
    (v): v is string => typeof v === 'string' && isValidValue(v) && Number.isNaN(Number(v)),
  );
  return { total: usable.length, distinct: new Set(usable).size };
};

/**
 * Decide whether a local string field reads as an enumeration or free text.
 * Conservative — every gate must pass to return 'enum', otherwise 'free-text'.
 */
export const classifyStringField = (stats: StringFieldStats): 'enum' | 'free-text' => {
  if (stats.total < ENUM_MIN_SAMPLE) return 'free-text'; // not enough evidence
  if (stats.distinct <= 1) return 'free-text'; // a constant is not a useful enumeration
  if (stats.distinct > ENUM_MAX_DISTINCT) return 'free-text'; // unbounded → free text
  return stats.distinct / stats.total <= ENUM_MAX_DISTINCT_RATIO ? 'enum' : 'free-text';
};
