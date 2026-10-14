/**
 * Shared value predicates for RCF schema inference.
 */

/**
 * True when a value should count toward inference — not null/undefined, and, for
 * a string, not blank (empty or whitespace-only). Used to filter observations
 * before typing and enum detection.
 */
export const isValidValue = (value: unknown): boolean =>
  value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0);

/**
 * True when a string is a canonical numeric literal — a number-as-string (`"12"`, `"-3.5"`,
 * `"0"`), which is NOT an enumeration member and should be dropped from enum detection/emission.
 *
 * A zero-padded / leading-zero code (`"01"`, `"007"`, a postal `"01234"`) is a legitimate string
 * enumeration value: it does not round-trip through `Number` (`String(Number("01")) === "1" !== "01"`),
 * so it is NOT treated as numeric and is kept. This is why a plain `Number.isNaN(Number(v))` check
 * is wrong — it silently drops leading-zero codes.
 */
export const isNumericToken = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed !== '' && String(Number(trimmed)) === trimmed;
};
