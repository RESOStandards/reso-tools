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
 * Rough client-side pre-check for the `/compute` compressed payload. The Lambda
 * sync limit is 6 MB on the whole *event* (body + the envelope API Gateway injects:
 * headers, `requestContext`, authorizer context) — which the client can't measure
 * or predict precisely. So this only catches *obviously* oversized bodies to avoid
 * a wasted upload; the gateway's **413** (caught in `service.ts`) is the precise
 * backstop for the envelope edge. Durable fix for the giants: reso-tools #227.
 */
export const MAX_COMPUTE_PAYLOAD_BYTES = 6 * 1024 * 1024;

/** Shared user-facing message for both the client-side pre-check and a gateway 413. */
export const PAYLOAD_TOO_LARGE_MESSAGE =
  'This metadata report is too large for the variations service. Please contact dev@reso.org.';
