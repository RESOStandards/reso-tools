import type { AuthConfig } from '../test-runner/types.js';

// ── Pipeline ──

/** Progress status for a pipeline step. */
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/** Progress update emitted by each pipeline step. */
export interface StepProgress {
  readonly step: string;
  readonly status: StepStatus;
  readonly message?: string;
  readonly duration?: number;
  readonly artifacts?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
}

/** Callback for receiving step progress updates. */
export type ProgressCallback = (progress: StepProgress) => void;

/** Context accumulated across pipeline steps. Each step can read from and add to this. */
export type PipelineContext = Record<string, unknown>;

/** Output returned by a pipeline step. */
export interface StepOutput<TContext extends PipelineContext = PipelineContext> {
  /** Updated context for the next step. */
  readonly context: TContext;
  /** Step-level status. Defaults to 'passed' if omitted. */
  readonly status?: StepStatus;
  /** One-line summary of what the step did. */
  readonly summary?: string;
  /** Key params that were used (for reporting). */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Output file locations. */
  readonly artifacts?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  /** Numeric tallies (e.g., { resources: 14, fields: 1727 }). */
  readonly counts?: Readonly<Record<string, number>>;
  /** Error messages (for failed or partially failed steps). */
  readonly errors?: ReadonlyArray<string>;
}

/** A single step in a compliance test pipeline. */
export interface PipelineStep<TContext extends PipelineContext = PipelineContext> {
  /** Human-readable step name (shown in CLI output). */
  readonly name: string;
  /** Execute the step. Receives accumulated context and returns step output with updated context. */
  readonly run: (context: Readonly<TContext>, onProgress: ProgressCallback) => Promise<StepOutput<TContext>>;
}

/** Options for pipeline execution. */
export interface PipelineOptions {
  /** If true (default), stop on first step failure. If false, continue and collect all failures. */
  readonly failFast?: boolean;
}

/** Detailed result of a completed pipeline step. */
export interface StepResult {
  readonly name: string;
  readonly endorsement: string;
  readonly strategy?: string;
  readonly status: StepStatus;
  readonly duration: number;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly summary?: string;
  readonly artifacts?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly counts?: Readonly<Record<string, number>>;
  readonly errors?: ReadonlyArray<string>;
}

/** Result of a completed pipeline execution. */
export interface PipelineResult<TContext extends PipelineContext = PipelineContext> {
  readonly status: 'passed' | 'failed';
  readonly endorsement: string;
  readonly steps: ReadonlyArray<StepResult>;
  readonly context: TContext;
  readonly duration: number;
}

// ── Compliance Config ──

/** Base configuration shared by all endorsements. */
export interface BaseComplianceConfig {
  readonly server: {
    readonly url: string;
    readonly auth: AuthConfig;
  };
  readonly options?: {
    readonly failFast?: boolean;
    readonly outputDir?: string;
    readonly verbose?: boolean;
    readonly skipHealthCheck?: boolean;
  };
}

/**
 * Data Dictionary endorsement config.
 *
 * @note RESO no longer certifies providers on DD 1.7. Version '1.7' is
 * deprecated and retained only for historical compatibility.
 * The CLI enforces DD 2.0+. To run DD 1.7 via the SDK:
 * ```typescript
 * await runDDCompliance({ endorsement: 'dd', version: '1.7', server: { ... } });
 * ```
 */
export interface DDConfig extends BaseComplianceConfig {
  readonly endorsement: 'dd';
  readonly version: '1.7' | '2.0' | '2.1';
  readonly limit?: number;
  readonly strictMode?: boolean;
  /** Batch all expansions for a resource into a single $expand request (default: false). */
  readonly batchExpand?: boolean;
  /** Provider Unique Organization Identifier. */
  readonly providerUoi?: string;
  /** Provider Unique System Identifier. */
  readonly providerUsi?: string;
  /** Recipient Unique Organization Identifier. */
  readonly recipientUoi?: string;
}

/** Inline payloads for Add/Edit config. */
export interface InlinePayloads {
  readonly createSucceeds?: Record<string, unknown>;
  readonly createFails?: Record<string, unknown>;
  readonly updateSucceeds?: Record<string, unknown>;
  readonly updateFails?: Record<string, unknown>;
  readonly deleteSucceeds?: Record<string, unknown>;
  readonly deleteFails?: Record<string, unknown>;
}

/** Add/Edit (RCP-010) endorsement config. */
export interface AddEditConfig extends BaseComplianceConfig {
  readonly endorsement: 'add-edit';
  readonly resource: string;
  readonly payloadsDir?: string;
  readonly payloads?: InlinePayloads;
  readonly metadataPath?: string;
  readonly specVersion?: string;
}

/** EntityEvent (RCP-027) endorsement config. */
export interface EntityEventConfig extends BaseComplianceConfig {
  readonly endorsement: 'entity-event';
  readonly mode?: 'observe' | 'full';
  readonly writableResource?: string;
  readonly payloadsDir?: string;
  readonly maxEvents?: number;
  readonly batchSize?: number;
  readonly pollInterval?: number;
  readonly pollTimeout?: number;
}

/** Web API Core endorsement config. */
export interface CoreConfig extends BaseComplianceConfig {
  readonly endorsement: 'core';
  readonly version?: '2.0.0' | '2.1.0';
  readonly resources?: ReadonlyArray<string>;
  readonly enumMode?: 'auto' | 'isflags' | 'collections' | 'string';
  readonly metadataPath?: string;
  readonly fullCoverage?: boolean;
}

/** Discriminated union of all endorsement configs. */
export type ComplianceConfig = DDConfig | AddEditConfig | EntityEventConfig | CoreConfig;
