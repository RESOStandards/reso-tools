/**
 * Metadata report generation — EDMX to RESO metadata-report.json
 * with optional Lookup Resource merge.
 */

// The metadata-report serializer moved to @reso-standards/reso-metadata-utils (reso-tools #221).
// Import serializeMetadataReport/generateMetadataReport + the MetadataReport* types from there.

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
