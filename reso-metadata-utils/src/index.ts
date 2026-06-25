/**
 * @reso-standards/reso-metadata-utils — RESO OData metadata processing utilities.
 *
 * The deps-requiring side of the RESO metadata split (reso-tools #221): CSDL parse + validate,
 * EDMX → metadata-report serialization, and metadata fetching. (XSD validation lands later under a
 * Node-only subpath.) Symbols migrate in here from reso-client and reso-certification. reso-common
 * (the zero-dep ResoMetadata model + EDMX generation) is a sibling, not a dependency — nothing here
 * imports it.
 */

// CSDL parser, validator, and types — moved from reso-client/csdl (reso-tools #221, Stage 1).
export {
  parseCsdlXml,
  discoverResources,
  getEntityType,
  getEnumType,
  getComplexType,
  getFieldsForResource,
  getFieldsForEntityType,
  getAllFields
} from './csdl/parser.js';
export { validateCsdl } from './csdl/validator.js';
export type {
  CsdlSchema,
  CsdlEntityType,
  CsdlProperty,
  CsdlNavigationProperty,
  CsdlReferentialConstraint,
  CsdlComplexType,
  CsdlEnumType,
  CsdlEnumMember,
  CsdlEntityContainer,
  CsdlEntitySet,
  CsdlNavigationPropertyBinding,
  CsdlSingleton,
  CsdlActionImport,
  CsdlFunctionImport,
  CsdlParameter,
  CsdlReturnType,
  CsdlAction,
  CsdlFunction,
  CsdlValidationError,
  CsdlResourceInfo,
  CsdlValidationResult,
  FieldAnnotation,
  FieldInfo
} from './csdl/types.js';

// Metadata-report serializer — EDMX/CSDL → RESO metadata-report.json (← reso-certification, #221 Stage 2a).
export { serializeMetadataReport, generateMetadataReport } from './serializer.js';
export type {
  MetadataReport,
  MetadataReportField,
  MetadataReportLookup,
  MetadataReportResource,
  MetadataReportModel,
  MetadataReportOperation
} from './serializer.js';

// Metadata fetcher — fetch + version-detect + parse $metadata from an OData server (← reso-client, #221 Stage 3).
export { fetchRawMetadata, fetchRawMetadataWithVersion, fetchAndParseMetadata, MetadataFetchError } from './fetcher.js';
export type { MetadataFetchOptions, MetadataFetchResult } from './fetcher.js';
