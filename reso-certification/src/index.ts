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
  extractExpansions
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
  WELL_KNOWN_RESOURCES
} from './web-api-core/index.js';

// ── SDK ──

export {
  runComplianceTests,
  runRcfCompliance,
  fingerprintRcfInput,
  runAddEditCompliance,
  addEditRunProblems,
  runEntityEventCompliance,
  runCoreCompliance,
  createPipeline,
  writeReports
} from './sdk/index.js';

export type { RcfInputFingerprint } from './rcf/fingerprint.js';

// The versions a caller gets when it names none, so another host defaults to what the CLI does.
export { CURRENT_CORE_VERSION } from './sdk/core-versions.js';
export { CURRENT_DD_VERSION } from './sdk/dd-versions.js';

export type {
  ComplianceConfig,
  RcfConfig,
  AddEditConfig,
  CoreConfig,
  DDConfig,
  BaseComplianceConfig,
  PipelineResult,
  StepResult,
  StepProgress,
  ProgressCallback
} from './sdk/types.js';

// ── Variations (standalone; also used by the DD pipeline) ──

export { computeVariationsViaService, isVariationsAuthError, findVariations, VARIATIONS_HANDLER_ENV } from './variations/index.js';
export type {
  ComputeVariationsRequest,
  ComputeVariationsViaServiceInput,
  VariationDeprecation,
  VariationsServiceReport,
  VariationsServiceErrorCode,
  FindVariationsInput
} from './variations/index.js';

// ── Cloud runs (start a run in RESO's cloud; read where each stands) ──

export {
  CLOUD_ENDORSEMENT,
  listCloudRunStatus,
  requestUploadSlot,
  reserveCloudRun,
  submitCloudRun,
  uploadToSlot
} from './cloud/runs.js';
export {
  ENTITY_EVENT_VERSION,
  cloudEndorsementOf,
  cloudEntryOf,
  cloudTargetOf,
  cloudVersionOf,
  isSuccessfulRun,
  localRunRecordOf,
  rcfLocalRunRecordOf,
  whyNoCloudRunBeforeRun
} from './cloud/local-run.js';
export type {
  AddEditCloudConfigEntry,
  AnyCloudConfigEntry,
  AnyLocalRunRecord,
  CloudConfigEntry,
  CloudEntryOf,
  CloudEntryOptions,
  CloudEntryResult,
  CloudRunConfig,
  DDCloudConfigEntry,
  EntityEventCloudConfigEntry,
  LocalRunRecord,
  LocalRunRecordFor,
  RcfCloudConfigEntry,
  RcfLocalRunRecord,
  ServerCloudConfigEntry,
  ServerCloudRunConfig
} from './cloud/local-run.js';
export { RCF_UPLOAD_MAX_BYTES, packRcfInput } from './cloud/rcf-pack.js';
export type { PackRcfResult, PackedRcfInput } from './cloud/rcf-pack.js';
export { reserveForLocalRun, startCloudRun, whyNotSuccessful } from './cloud/start.js';
export type { CloudLocalRun, ReserveForLocalRunInput, StartCloudRunDeps, StartCloudRunInput } from './cloud/start.js';

// ── Live updates on cloud runs (follow them as they change, instead of polling) ──

export {
  CLOUD_UPDATES_HEARTBEAT,
  CLOUD_UPDATES_PROTOCOL,
  CLOUD_UPDATE_KIND,
  DEFAULT_CLOUD_UPDATES_POLICY,
  backoffDelayMs,
  isCloudUpdateEvent,
  parseCloudUpdate,
  subscribeToCloudUpdates
} from './cloud/updates.js';
export type {
  CloudTokenProvider,
  CloudUpdateEvent,
  CloudUpdateKind,
  CloudUpdatesPolicy,
  CloudUpdatesSocket,
  CloudUpdatesSocketFactory,
  CloudUpdatesState,
  CloudUpdatesStateDetail,
  CloudUpdatesStats,
  CloudUpdatesSubscription,
  SubscribeToCloudUpdatesOptions
} from './cloud/updates.js';
export { bearerTokenProvider, cliCredentialsTokenProvider, sessionTokenProvider } from './cloud/update-tokens.js';
export { CLOUD_UPDATES_URL_VARIABLE, ensureSecureWebSocketUrl, resolveCloudUpdatesUrl } from './sdk/common.js';
export type {
  AcceptedCloudRun,
  CloudEndorsementName,
  CloudRunRecipient,
  CloudRunReservation,
  CloudRunStatusInput,
  CloudRunStatusPage,
  CloudRunStatusRow,
  CloudRunTarget,
  ReserveCloudRunInput,
  SubmitCloudRunInput,
  UploadSlot,
  UploadSlotInput
} from './cloud/runs.js';

// ── Metadata source (--from-server: fetch $metadata from a live endpoint + serialize) ──

export { fetchMetadataReportFromServer } from './sdk/metadata-source.js';
export type { FetchMetadataReportFromServerInput } from './sdk/metadata-source.js';

// ── Metadata Report ──
// The serializer (serializeMetadataReport/generateMetadataReport + MetadataReport*) moved to
// @reso-standards/reso-metadata-utils (reso-tools #221). Import from there directly.

// ── Data Dictionary (stub) ──

export { DATA_DICTIONARY_VERSION } from './data-dictionary/index.js';

// ── RESO Analytics (compare two runs) ──

export {
  ALL_RESOURCES,
  COMPARISON_SCHEMA_VERSION,
  METRIC_DEFINITIONS,
  TIMING_TOLERANCE_PERCENT,
  compareRunMetrics,
  compareRuns,
  findPreviousRun,
  formatChange,
  formatValue,
  isNoPreviousRunError,
  readRunMetrics,
  renderComparisonText,
  runMetricsFromReports,
  runPlacement
} from './analytics/index.js';
export type {
  ChangeUnit,
  ChangeVerdict,
  Metric,
  MetricChange,
  MetricDirection,
  MetricKind,
  RenderOptions,
  RunComparison,
  RunInfo,
  RunMetrics,
  RunReports
} from './analytics/index.js';
