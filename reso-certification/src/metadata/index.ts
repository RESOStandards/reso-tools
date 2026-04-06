/**
 * Metadata report generation — EDMX to RESO metadata-report.json.
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
