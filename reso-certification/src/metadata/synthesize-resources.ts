/**
 * Synthesize the top-level `resources[]` block on a parsed metadata
 * report when it is missing or empty.
 *
 * Why this exists: cert metadata reports for DD 2.0 and 2.1 do not
 * carry a top-level `resources[]` block. That concept arrives in
 * DD 2.2. Anything that consumes a metadata report and needs to know
 * which entity sets to register (e.g., the Reference Server's
 * metadata loader) has to derive the resource list from the next
 * best source: distinct values in `fields[].resourceName`.
 *
 * This helper bridges the DD 2.0/2.1 → 2.2 gap mechanically. It is
 * idempotent — a report that already has a populated `resources[]`
 * block (DD 2.2+ or one that was previously adapted) is returned
 * unchanged.
 *
 * Convention: the synthesized resources are sorted alphabetically by
 * `resourceName` so the output is stable across runs and friendly to
 * diffs. The shape matches the rest of `reso-certification`'s
 * `MetadataReportResource` type — `{ resourceName: string }` —
 * exactly the same shape the EDMX serializer emits when building
 * a report from scratch (see `serializer.ts`).
 */

import type { MetadataReport, MetadataReportResource } from './serializer.js';

/** True if the report's `resources[]` is missing, undefined, or empty. */
const needsSynthesis = (report: MetadataReport): boolean =>
  !report.resources || report.resources.length === 0;

/**
 * Return a metadata report with a populated top-level `resources[]`
 * block. Idempotent — if the input already has a non-empty
 * `resources[]`, the input is returned unchanged.
 *
 * The synthesized resource list is sorted alphabetically and
 * deduplicated.
 */
export const synthesizeResourcesFromFields = (report: MetadataReport): MetadataReport => {
  if (!needsSynthesis(report)) return report;

  // Distinct resource names, sorted for stable output. Empty/undefined
  // resourceName values (which would represent malformed fields) are
  // skipped rather than producing a `{ resourceName: '' }` entry.
  const distinctNames = Array.from(
    new Set(
      report.fields
        .map(f => f.resourceName)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    )
  ).sort();

  const resources: ReadonlyArray<MetadataReportResource> = distinctNames.map(resourceName => ({
    resourceName,
  }));

  return {
    ...report,
    resources,
  };
};
