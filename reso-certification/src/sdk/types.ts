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
  /** HTTP request details for debugging (shown in collapsible UI). */
  readonly requestDetails?: ReadonlyArray<{
    readonly method: string;
    readonly url: string;
    readonly status?: number;
    readonly error?: string;
    readonly responseBody?: string;
  }>;
}

/**
 * A single test function within a step.
 * Takes accumulated context and returns step output with updated context.
 */
export type TestFunction<TContext extends PipelineContext = PipelineContext> =
  (context: Readonly<TContext>, onProgress: ProgressCallback) => Promise<StepOutput<TContext>>;

/** Execution mode for test functions within a step. */
export type StepMode = 'sequential' | 'parallel';

/**
 * A pipeline step — contains one or more test functions that execute
 * either sequentially or in parallel.
 *
 * Every step is a sequence of at least one function. When mode is
 * 'parallel', functions run concurrently (up to the configured
 * concurrency limit). When 'sequential' (default), they run in order.
 *
 * Context flows through: each function receives the accumulated context
 * from prior functions. In parallel mode, all functions receive the
 * same input context and their outputs are merged.
 */
export interface PipelineStep<TContext extends PipelineContext = PipelineContext> {
  /** Human-readable step name (shown in CLI output). */
  readonly name: string;
  /** Execution mode: 'sequential' (default) or 'parallel'. */
  readonly mode?: StepMode;
  /** Max concurrency when mode is 'parallel'. Defaults to Infinity. */
  // TODO: implement concurrency limit for parallel mode
  readonly concurrency?: number;
  /**
   * Test functions to execute within this step.
   * If omitted, `run` is used as the single function (backward compat).
   */
  readonly functions?: ReadonlyArray<TestFunction<TContext>>;
  /**
   * Single-function shorthand (backward compat).
   * Equivalent to `functions: [run]` with mode 'sequential'.
   */
  readonly run?: TestFunction<TContext>;
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
  readonly requestDetails?: ReadonlyArray<{
    readonly method: string;
    readonly url: string;
    readonly status?: number;
    readonly error?: string;
    readonly responseBody?: string;
  }>;
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
  /** Provider Unique Organization Identifier — used for output directory structure. */
  readonly providerUoi?: string;
  /** Provider Unique System Identifier — used for output directory structure. */
  readonly providerUsi?: string;
  /** Recipient Unique Organization Identifier — used for output directory structure. */
  readonly recipientUoi?: string;
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
  /** Delay between replication requests in seconds (default: 1). Set to 0 for local testing. */
  readonly requestDelay?: number;
  /** Wait time in minutes after receiving HTTP 429 (default: 15). */
  readonly rateLimitWait?: number;
  /** Run replication strategies in parallel (default: false). Enable for faster local testing. */
  readonly parallelReplicate?: boolean;
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
