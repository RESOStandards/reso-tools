import type { BucketedVariations } from '@reso-standards/reso-common';
import { CURRENT_DD_VERSION } from '../sdk/dd-versions.js';
import type { DDVersion } from '../sdk/dd-versions.js';
/**
 * Variations defaults. These mirror the frozen v3.0.0 `findVariations` values
 * so the thin-client swap keeps identical behavior at the call sites (CLI flag
 * defaults, output filename). The DD version default matches the legacy `2.0`.
 */

/** Fuzzy-match threshold passed to the service when a caller omits one. */
export const DEFAULT_FUZZINESS = 0.25;

/** Data Dictionary version assumed when a caller omits one. */
export const DEFAULT_DD_VERSION: DDVersion = CURRENT_DD_VERSION;

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
export const PAYLOAD_TOO_LARGE_MESSAGE = 'This metadata report is too large for the variations service. Please contact dev@reso.org.';

// ── The level buckets a Data Dictionary run writes ───────────────────────────
//
// A variations report on disk is BUCKETED BY LEVEL -- `resources`, `fields`, `lookups`,
// `expansions`, `complexTypes` -- not a flat `changes` array. `changes` is the shape the service
// STORES, built on its side from these buckets, and 0 of the 28 reports on this machine carry one.
// Code that reads `.changes` off an on-disk report gets `undefined`.
//
// The key set is BOUND to reso-common's own declaration rather than restated. reso-common already
// spells these five out twice (`BucketedVariations` and `PreparedVariations`) and `src/sdk/dd.ts`
// a third time in its counts literal; a fourth copy that could drift silently is the hazard here,
// because a bucket this list omits is a whole level of variations that every consumer below would
// skip without error.

/** The five buckets, in the order a report declares them, so entry ordering is stable. */
export const VARIATION_LEVEL_KEYS = ['resources', 'fields', 'lookups', 'expansions', 'complexTypes'] as const satisfies ReadonlyArray<
  keyof BucketedVariations
>;

export type VariationLevelKey = (typeof VARIATION_LEVEL_KEYS)[number];

// A bucket added to reso-common and not added above is a COMPILE ERROR here, not a silent skip.
// `satisfies` above catches a key that should not be there; this catches one that is missing.
type MissingBucket = Exclude<keyof BucketedVariations, VariationLevelKey>;
const _everyBucketCovered: MissingBucket extends never ? true : ['unhandled variation bucket', MissingBucket] = true;
void _everyBucketCovered;

/**
 * One entry in a level bucket, as the file on disk actually carries it.
 *
 * Deliberately OPEN, and deliberately not reso-common's `VariationEntry`. Those interfaces have no
 * index signature and declare none of what a real report carries -- `enforcement` arrives via
 * `Bucketed<T>`, and the service adds `inReview`, `isOriginator`, `reviewFor`, `reviewState` and
 * `status`, none of which are declared anywhere. Nor do they declare the three fields the review
 * flow WRITES (`ignore`, `remove`, `flaggedForFastTrack`) or `conversations`. `level` is declared
 * required there and is absent from entries in older reports on disk.
 *
 * So this type describes the artifact rather than the ideal, and narrows only the fields that are
 * read or written here. Reusing the stricter type would mean a cast at every access, which is the
 * same thing with the checking switched off.
 */
export interface ReportEntry {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  /** The legacy camel form. A lookup entry may carry THIS INSTEAD OF `lookupValue`. */
  readonly legacyODataValue?: string;
  readonly ignore?: boolean;
  readonly remove?: boolean;
  readonly flaggedForFastTrack?: boolean;
  readonly conversations?: ReadonlyArray<{ readonly timestamp: string; readonly to: string; readonly message: string }>;
  readonly [key: string]: unknown;
}

/** The buckets of a report, each optional: a run omits a bucket it found nothing for. */
export type LevelBuckets = { readonly [K in VariationLevelKey]?: ReadonlyArray<ReportEntry> };

/** Entries a report carries across every bucket. The report's real size. */
export const countBucketedEntries = (report: LevelBuckets): number =>
  VARIATION_LEVEL_KEYS.reduce((n, key) => n + (Array.isArray(report[key]) ? (report[key] as ReadonlyArray<ReportEntry>).length : 0), 0);
