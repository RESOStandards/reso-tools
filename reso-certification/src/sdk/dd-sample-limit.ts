/**
 * How many records a Data Dictionary run samples per resource, and which sample limits certify.
 *
 * RESO samples up to 100,000 records per resource, the same "up to" RESO Common Format asks for. A server with fewer
 * records gives all it has. Providers asked to go higher for a more accurate sample, so a limit at or above the
 * default certifies; one below it measures less than certification samples and is for local testing (Josh,
 * 2026-11-09: "we let them go higher, just not lower unless they don't have records").
 *
 * The verdict, the refusal before a cloud run and the refusal of the `--limit` flag all ask `isDDLimitBelowDefault`,
 * so the rule is decided in one place.
 */

/** Records sampled per resource when the configuration sets no limit. */
export const DD_DEFAULT_SAMPLE_LIMIT = 100000;

/** The default as a reader sees it, for messages. */
export const DD_DEFAULT_SAMPLE_LIMIT_TEXT = DD_DEFAULT_SAMPLE_LIMIT.toLocaleString('en-US');

/**
 * True when a configuration set a sample limit that does not certify: anything but a whole number at or above the
 * default. An absent limit is the default and certifies. Fails closed, so NaN, Infinity, fractions, zero and
 * negatives count as below the default.
 */
export const isDDLimitBelowDefault = (limit: number | undefined): boolean =>
  limit !== undefined && !(Number.isSafeInteger(limit) && limit >= DD_DEFAULT_SAMPLE_LIMIT);
