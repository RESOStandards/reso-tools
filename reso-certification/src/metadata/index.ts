/**
 * Metadata report generation — EDMX to RESO metadata-report.json
 * with optional Lookup Resource merge.
 */

export {
  serializeMetadataReport,
  generateMetadataReport,
} from './serializer.js';

export type {
  MetadataReport,
  MetadataReportField,
  MetadataReportLookup,
  MetadataReportResource,
} from './serializer.js';

export { synthesizeResourcesFromFields } from './synthesize-resources.js';

export {
  fetchLookupResource,
  mergeWithLookupResource,
  fetchAndMergeLookupResource,
  serializeLookupResourceDump,
} from './lookup-resource.js';

export type {
  RawLookupRecord,
  LookupResourceDump,
} from './lookup-resource.js';
