/**
 * Reference artifact set — assembles the full bundle of artifacts the certification self-test
 * runs against the reference, mirroring what the DD pipeline produces for a provider but
 * GENERATED from the DD reference instead of fetched from a server: the EDMX, the canonical
 * metadata report, and (for the string representation) the synthesized Lookup Resource dump plus
 * the pre-merge base report.
 *
 * The thesis: run the same DD checks against this bundle that we run against providers — and it
 * must come back silent, because the reference follows its own rules.
 *
 * Pure (no file I/O): returns the bundle in memory. Writing the artifacts to disk is the CI
 * self-test harness's concern.
 */
import type { EnumMode } from '@reso-standards/reso-common';
import { generateReferenceEdmx } from './reference-edmx.js';
import { generateMetadataReport } from './serializer.js';
import type { MetadataReport } from './serializer.js';
import {
  synthesizeLookupResourceRecords,
  serializeLookupResourceDump,
  mergeWithLookupResource,
} from './lookup-resource.js';
import type { LookupResourceDump } from './lookup-resource.js';

/** The reference artifact set for one enum representation. */
export interface ReferenceArtifacts {
  readonly enumMode: EnumMode;
  /** The reference EDMX — what a provider would serve at /$metadata. */
  readonly edmx: string;
  /** The canonical metadata report — merged for the string rep, base for enum-type. */
  readonly metadataReport: MetadataReport;
  /** The pre-merge base report — string representation only (the metadata-report.raw.json equivalent). */
  readonly rawReport?: MetadataReport;
  /** The synthesized Lookup Resource dump — string representation only. */
  readonly lookupResourceDump?: LookupResourceDump;
}

/**
 * Generate the reference artifact set for one enum representation from a DD reference report.
 *
 * - **enum-type**: enum values live in the EDMX (EnumType members); the canonical report is the
 *   direct serialization of that EDMX. No Lookup Resource.
 * - **string**: enum values live in the Lookup Resource; synthesize that dataset from the
 *   reference, serialize the dump, and merge it into the base report to get the canonical report.
 */
export const generateReferenceArtifacts = (
  report: MetadataReport,
  targetResources: ReadonlyArray<string>,
  enumMode: EnumMode,
  version: string,
): ReferenceArtifacts => {
  const edmx = generateReferenceEdmx(report, targetResources, enumMode);
  const base = generateMetadataReport(edmx, version);

  if (enumMode === 'enum-type') {
    return { enumMode, edmx, metadataReport: base };
  }

  const lookupRecords = synthesizeLookupResourceRecords(report);
  const lookupResourceDump = serializeLookupResourceDump(lookupRecords, version);
  const metadataReport = mergeWithLookupResource(base, lookupRecords);
  return { enumMode, edmx, metadataReport, rawReport: base, lookupResourceDump };
};
