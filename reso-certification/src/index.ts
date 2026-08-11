// ── Test Runner (shared infrastructure) ──

// Validators
export {
  validateODataVersionHeader,
  validateStatusCode,
  validateStatusCodeRange,
  validateEntityIdHeader,
  validateLocationHeader,
  validatePreferenceApplied,
  validateJsonResponse,
  validateEmptyResponse,
  validateODataAnnotation,
  validateResponseContainsPayload,
  validateODataError
} from './test-runner/validators.js';

// Reporter
export { formatConsoleReport, formatJsonReport } from './test-runner/reporter.js';

// Client
export { odataRequest, buildResourceUrl } from './test-runner/client.js';
export type { RequestOptions } from './test-runner/client.js';

// Auth
export { resolveAuthToken, fetchAccessToken } from './test-runner/auth.js';

// Metadata
export {
  fetchMetadata,
  loadMetadataFromFile,
  parseMetadataXml,
  getEntityType,
  validatePayloadAgainstMetadata,
  toResoFields
} from './test-runner/metadata.js';

// Helpers
export { extractPrimaryKey, stripPrimaryKey, makeSchemaAssertion, buildScenarioResult } from './test-runner/helpers.js';

// Edm type validator
export { validateValueAgainstEdm, validateRecordAgainstMetadata } from './test-runner/edm-validator.js';

// Payload field inspection
export {
  isEnumProperty,
  extractPayloadFields,
  extractEnumerations,
  extractExpansions,
} from './test-runner/payload-fields.js';
export type { EnumerationDetail } from './test-runner/payload-fields.js';

// Types
export type {
  AuthConfig,
  TestConfig,
  TestReport,
  ScenarioResult,
  TestAssertion,
  TestStatus,
  ParsedMetadata,
  EntityType,
  EntityProperty,
  MockServerOptions,
  ODataResponse
} from './test-runner/types.js';

export type { ValidationFailure } from '@reso-standards/reso-validation';

// ── Add/Edit (RCP-010) ──

export { runAllScenarios } from './add-edit/index.js';
export { generateComplianceReport } from './add-edit/index.js';
export type { ComplianceReport, ScenarioDetail, ReportConfig } from './add-edit/compliance-report.js';
export { startMockServer, stopMockServer } from './add-edit/index.js';
export type { PayloadSet, DeletePayload, ScenarioName } from './add-edit/types.js';

// ── EntityEvent (RCP-027) ──

export { runAllEntityEventScenarios } from './entity-event/index.js';
export { generateEntityEventComplianceReport } from './entity-event/index.js';
export { validateEventData } from './entity-event/index.js';
export type {
  EntityEventComplianceReport,
  EntityEventScenarioDetail,
  EntityEventReportConfig
} from './entity-event/compliance-report.js';
export type {
  EntityEventConfig,
  EntityEventMode,
  EntityEventScenarioName,
  EntityEventRecord,
  DataValidationResult,
  EntityEventTestReport
} from './entity-event/types.js';

// ── Web API Core ──

export {
  allScenarios,
  scenariosForVersion,
  runCoreResourceScenarios,
  resolveTestParams,
  WELL_KNOWN_RESOURCES,
} from './web-api-core/index.js';

// ── SDK ──

export {
  runComplianceTests,
  runAddEditCompliance,
  runEntityEventCompliance,
  runCoreCompliance,
  createPipeline,
  writeReports,
} from './sdk/index.js';

export type {
  ComplianceConfig,
  AddEditConfig,
  CoreConfig,
  DDConfig,
  BaseComplianceConfig,
  PipelineResult,
  StepResult,
  StepProgress,
  ProgressCallback,
} from './sdk/types.js';

// ── Variations (standalone; also used by the DD pipeline) ──

export { computeVariationsViaService, isVariationsAuthError, findVariations } from './variations/index.js';
export type {
  ComputeVariationsViaServiceInput,
  VariationsServiceReport,
  VariationsServiceErrorCode,
  FindVariationsInput,
} from './variations/index.js';

// ── Metadata source (--from-server: fetch $metadata from a live endpoint + serialize) ──

export { fetchMetadataReportFromServer } from './sdk/metadata-source.js';
export type { FetchMetadataReportFromServerInput } from './sdk/metadata-source.js';

// ── Metadata Report ──
// The serializer (serializeMetadataReport/generateMetadataReport + MetadataReport*) moved to
// @reso-standards/reso-metadata-utils (reso-tools #221). Import from there directly.

// ── Data Dictionary (stub) ──

export { DATA_DICTIONARY_VERSION } from './data-dictionary/index.js';
