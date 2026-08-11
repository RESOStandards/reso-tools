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
