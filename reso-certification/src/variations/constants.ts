/**
 * Variations defaults. These mirror the frozen v3.0.0 `findVariations` values
 * so the thin-client swap keeps identical behavior at the call sites (CLI flag
 * defaults, output filename). The DD version default matches the legacy `2.0`.
 */

/** Fuzzy-match threshold passed to the service when a caller omits one. */
export const DEFAULT_FUZZINESS = 0.25;

/** Data Dictionary version assumed when a caller omits one. */
export const DEFAULT_DD_VERSION = '2.0';

/** Report filename written into the output directory (unchanged from legacy). */
export const VARIATIONS_REPORT_FILENAME = 'data-dictionary-variations.json';

/**
 * Max compressed request payload for the `/compute` call. The Lambda synchronous
 * invocation payload is capped at 6 MB, and the `base64(gzip)` body is essentially
 * the whole event — so a report that compresses over this fails at the gateway.
 * The client flags it with an actionable message instead of a cryptic 4xx. The
 * durable fix (presigned-URL or chunked upload) is tracked in reso-tools #227.
 */
export const MAX_COMPUTE_PAYLOAD_BYTES = 6 * 1024 * 1024;
