/**
 * Reference EDMX generation — turns a cert-side MetadataReport (the DD reference projection)
 * into EDMX XML via the shared, universal generateEdmx in @reso-standards/reso-common.
 *
 * This is how the certification self-test obtains the reference metadata: generate EDMX from
 * the DD source in BOTH enum representations, then run the same checks against it that we run
 * against providers. A cert MetadataReport is a structural superset of reso-common's
 * ResoMetadata, so the bridge is a thin normalization — lookup annotations default to [], and
 * resources get the wikiPageURL/payloads that generateEdmx does not read but the type requires.
 */
import { generateEdmx } from '@reso-standards/reso-common';
import type { EnumMode, ResoMetadata } from '@reso-standards/reso-common';
import type { MetadataReport } from './serializer.js';

/** Adapt a cert MetadataReport to reso-common's ResoMetadata (the generateEdmx input shape). */
export const metadataReportToResoMetadata = (report: MetadataReport): ResoMetadata => ({
  description: report.description,
  version: report.version,
  generatedOn: report.generatedOn,
  resources: report.resources.map(r => ({ resourceName: r.resourceName, wikiPageURL: '', payloads: [] })),
  fields: report.fields,
  lookups: report.lookups.map(l => ({
    lookupName: l.lookupName,
    lookupValue: l.lookupValue,
    type: l.type,
    annotations: l.annotations ?? [],
  })),
});

/** Generate reference EDMX XML for the given resources from a DD MetadataReport. */
export const generateReferenceEdmx = (
  report: MetadataReport,
  targetResources: ReadonlyArray<string>,
  enumMode: EnumMode,
): string => generateEdmx(metadataReportToResoMetadata(report), targetResources, enumMode);
