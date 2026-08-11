/**
 * RCF (RESO Common Format) schema inference.
 *
 * RCF payloads carry values, not a schema. To run the DD-2.0 machinery (schema
 * validation + variations) against RCF data, this package INFERS a DD-2.0
 * metadata report from sampled records: per-value typing, local-field
 * aggregation, and — the only genuinely-hard call — enum-vs-free-text detection
 * for local string fields. DD fields take their types from reference metadata
 * (ground truth); only local fields are inferred. `inferMetadataReport` is the
 * entry point.
 */

export { inferType, analyzeNumber, isValidIsoDate, isValidIsoDateTimeOffset, type InferredType } from './infer-type.js';
export { isValidValue } from './values.js';
export {
  stringFieldStats,
  classifyStringField,
  ENUM_MIN_SAMPLE,
  ENUM_MAX_DISTINCT_RATIO,
  ENUM_MAX_DISTINCT,
  type StringFieldStats,
} from './local-enum-detection.js';
export { aggregateFieldType, type AggregatedFieldType } from './aggregate.js';
export {
  inferMetadataReport,
  assembleReport,
  buildPayloadCache,
  type ReferenceMap,
  type ReferenceField,
  type ReferenceLookupEntry,
  type PayloadCache,
  type InferMetadataReportInput,
} from './assemble-report.js';
export {
  buildKindMatcher,
  DEFAULT_KIND_MATCH_OPTIONS,
  type KindMatcher,
  type KindMatch,
  type KindMatchInput,
  type KindMatchOptions,
} from './kind-match.js';
