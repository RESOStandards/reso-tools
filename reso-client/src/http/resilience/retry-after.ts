/**
 * Retry-After header parsing and validation per RFC 9110 §10.2.3:
 *
 *   Retry-After  = HTTP-date / delay-seconds
 *   delay-seconds = 1*DIGIT   (a non-negative integer, in seconds)
 *
 * HTTP-date is RFC 9110 §5.6.7 (IMF-fixdate plus the obsolete forms). Validation
 * is separate from resolution: the client honors a valid header for backoff, while
 * the certification layer separately judges whether a server's header is spec-legal.
 */

/**
 * Whether a Retry-After value is well-formed. A numeric value that is not a
 * non-negative integer (negative, decimal) is rejected as malformed delay-seconds
 * rather than being rescued by the lenient date parser.
 */
export const isValidRetryAfter = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (/^\d+$/.test(trimmed)) return true;
  if (/^[+-]?\d*\.?\d+$/.test(trimmed)) return false;
  return !Number.isNaN(Date.parse(trimmed));
};

/**
 * Resolves a Retry-After header into a wait in milliseconds, or `null` when the
 * header is absent or unparseable (the caller then falls back to its backoff).
 * delay-seconds → that many seconds; HTTP-date → the interval until that date
 * (never negative). `now` is injectable so the HTTP-date branch is deterministic
 * in tests.
 */
export const parseRetryAfterMs = (value: string | undefined, now: number = Date.now()): number | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - now);
};
