/**
 * Shared certification constants — endorsement types, labels, step
 * definitions, environment URLs, and mappings between API and SDK
 * identifiers.
 *
 * Single source of truth for all cert-related string constants.
 */

// ── SDK endorsement types (used in config builder, job manager) ──────

export type CertEndorsement = 'dd' | 'core' | 'add-edit' | 'entity-event';

export const CERT_ENDORSEMENT_LABELS: Readonly<Record<CertEndorsement, string>> = {
  dd: 'Data Dictionary',
  core: 'Web API Core',
  'add-edit': 'Web API Add/Edit',
  'entity-event': 'EntityEvent',
};

export const CERT_ENDORSEMENT_COLORS: Readonly<Record<CertEndorsement, string>> = {
  dd: 'blue',
  core: 'green',
  'add-edit': 'amber',
  'entity-event': 'purple',
};

// ── DD version options ───────────────────────────────────────────────

export type DDVersion = '1.7' | '2.0' | '2.1';
export type CoreVersion = '2.0.0' | '2.1.0';

export const DEFAULT_DD_VERSION: DDVersion = '2.0';
export const DEFAULT_CORE_VERSION: CoreVersion = '2.0.0';

export const ENDORSEMENT_DEFAULT_VERSIONS: Readonly<Record<CertEndorsement, string>> = {
  dd: DEFAULT_DD_VERSION,
  core: DEFAULT_CORE_VERSION,
  'add-edit': '2.0.0',
  'entity-event': '1.0.0',
};

// ── Enum modes (Core endorsement) ────────────────────────────────────

export type EnumMode = 'auto' | 'isflags' | 'collections' | 'string';

export const ENUM_MODE_LABELS: Readonly<Record<EnumMode, string>> = {
  auto: 'Auto-detect',
  isflags: 'IsFlags',
  collections: 'Collections',
  string: 'String + Lookup',
};

// ── Scenario display names ───────────────────────────────────────────

const KNOWN_SCENARIO_NAMES: Readonly<Record<string, string>> = {
  'metadata-valid': 'Metadata Validation',
  'read-only-enforced': 'Read-Only Enforcement',
  'event-structure': 'Event Structure',
  'sequence-monotonic': 'Sequence Monotonic',
  'query-filter': 'Query: $filter',
  'query-orderby-top-skip': 'Query: $orderby, $top, $skip',
  'query-count': 'Query: $count',
  'incremental-sync': 'Incremental Sync',
  'create-triggers-event': 'Create Triggers Event',
  'update-triggers-event': 'Update Triggers Event',
  'delete-triggers-event': 'Delete Triggers Event',
  'data-validation': 'Data Validation',
};

/** Humanize kebab-case scenario tags into readable names. */
export const humanizeScenarioName = (name: string): string =>
  KNOWN_SCENARIO_NAMES[name] ?? name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// ── Common step names ────────────────────────────────────────────────

export const STEP_HEALTH_CHECK = 'Health check';
export const STEP_RESOLVE_AUTH = 'Resolve authentication';
export const STEP_FETCH_METADATA = 'Fetch metadata';

// ── Step tooltips ────────────────────────────────────────────────────

export const STEP_TOOLTIPS: Readonly<Record<string, string>> = {
  [STEP_RESOLVE_AUTH]: 'Validates that credentials are present in the config. No credentials are exchanged with the server at this step.',
};

// ── Pipeline step definitions per endorsement ────────────────────────

export const DD_STEPS: ReadonlyArray<string> = [
  'Health check',
  'Resolve authentication',
  'Generate metadata report',
  'Check variations',
  'Replicate: TIMESTAMP_DESC',
  'Replicate: NEXT_LINK',
  'Replicate: NEXT_LINK + filter',
  'Write compliance reports',
];

export const CORE_STEPS: ReadonlyArray<string> = [
  'Health check',
  'Resolve authentication',
  'Fetch metadata',
  'Run Core scenarios',
  'Write compliance reports',
];

export const ADD_EDIT_STEPS: ReadonlyArray<string> = [
  'Health check',
  'Resolve authentication',
  'Fetch metadata',
  'Sample records',
  'Generate payloads',
  'Run Add/Edit scenarios',
  'Write compliance reports',
];

export const ENTITY_EVENT_STEPS: ReadonlyArray<string> = [
  'Health check',
  'Resolve authentication',
  'Fetch metadata',
  'Generate payloads',
  'Run EntityEvent scenarios',
  'Write compliance reports',
];

export const STEPS_BY_ENDORSEMENT: Readonly<Record<string, ReadonlyArray<string>>> = {
  'Data Dictionary': DD_STEPS,
  'Web API Core': CORE_STEPS,
  'Web API Add/Edit': ADD_EDIT_STEPS,
  EntityEvent: ENTITY_EVENT_STEPS,
};

export const stepsForEndorsement = (endorsement: string): ReadonlyArray<string> =>
  STEPS_BY_ENDORSEMENT[endorsement] ?? DD_STEPS;

// ── Environment URLs (for cloud submission) ──────────────────────────

export type CertEnvironment = 'certqa' | 'certstg' | 'production';

export const CERT_ENV_LABELS: Readonly<Record<CertEnvironment, string>> = {
  certqa: 'QA (certqa.reso.org)',
  certstg: 'Staging (certstg.reso.org)',
  production: 'Production (certification.reso.org)',
};

export const CERT_ENV_SHORT_LABELS: Readonly<Record<CertEnvironment, string>> = {
  certqa: 'QA',
  certstg: 'Staging',
  production: 'Production',
};

export const SERVICES_URLS: Readonly<Record<CertEnvironment, string>> = {
  certqa: 'https://services-qa.reso.org',
  certstg: 'https://services-stg.reso.org',
  production: 'https://services.reso.org',
};

// ── Job / step status types ──────────────────────────────────────────

export type JobStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export const JOB_STATUS_COLORS: Readonly<Record<JobStatus, string>> = {
  queued: 'text-gray-500 dark:text-gray-400',
  running: 'text-blue-600 dark:text-blue-400',
  passed: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  cancelled: 'text-gray-400 dark:text-gray-500',
};

export const STEP_STATUS_ICONS: Readonly<Record<StepStatus, string>> = {
  pending: '○',
  running: '◉',
  passed: '✓',
  failed: '✗',
  skipped: '–',
};

export const STEP_STATUS_COLORS: Readonly<Record<StepStatus, string>> = {
  pending: 'text-gray-400 dark:text-gray-500',
  running: 'text-blue-500 dark:text-blue-400',
  passed: 'text-green-500 dark:text-green-400',
  failed: 'text-red-500 dark:text-red-400',
  skipped: 'text-gray-300 dark:text-gray-600',
};

// ── Concurrency ──────────────────────────────────────────────────────

export const DEFAULT_CONCURRENCY = 1;
export const MAX_LOCAL_CONCURRENCY = 4;
export const MEMORY_WARNING_THRESHOLD = 2;
