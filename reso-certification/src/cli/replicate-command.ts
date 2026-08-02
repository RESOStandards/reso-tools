/**
 * Testable core for the `reso-cert replicate` command — the sampling / replication cert step.
 *
 * Pulls OData records from a live endpoint using one of the four replication strategies and writes a
 * data-availability report (and, optionally, the raw pages) to an output directory. Wraps the carried legacy
 * replication engine (`src/legacy/lib/replication`) the same way the `dd` pipeline does (`src/sdk/dd.ts`):
 * a pre-resolved bearer token, one fresh replication-state instance, and `throwOnError: true` so failures
 * surface as a rejected promise (→ CLI exit code) instead of the engine's default `process.exit(1)`.
 *
 * The legacy `replicate` returns nothing — all results are side effects (files on disk, a mutated state
 * singleton, an `onProgress` callback). This core captures the final `onProgress` payload so the command can
 * report record counts and throughput, and validates the strategy up front (the engine only rejects an unknown
 * strategy per-page, deep inside the run).
 */

import { resolve } from 'node:path';

// Legacy CJS engine, imported exactly as src/sdk/dd.ts does (default import + destructure, no createRequire).
// @ts-expect-error — legacy CJS, no type declarations
import certUtils from '../legacy/index.js';
// @ts-expect-error — legacy CJS
import certUtilsCommon from '../legacy/common.js';
// @ts-expect-error — legacy CJS
import certUtilsReplicationUtils from '../legacy/lib/replication/utils.js';

const { replicate } = certUtils as {
  replicate: (opts: Record<string, unknown>) => Promise<void>;
};
const { createReplicationStateServiceInstance } = certUtilsCommon as {
  createReplicationStateServiceInstance: () => unknown;
};
const { REPLICATION_STRATEGIES } = certUtilsReplicationUtils as {
  REPLICATION_STRATEGIES: Readonly<Record<string, string>>;
};

/** The four accepted replication strategies, sourced from the legacy engine (never hardcoded). */
export const REPLICATION_STRATEGY_VALUES: ReadonlyArray<string> = Object.values(REPLICATION_STRATEGIES);

const DEFAULT_DD_VERSION = '2.0';

export interface ReplicationStats {
  readonly totalRecordsFetched: number;
  readonly meanResponseMs: number;
  readonly throughput: number;
  readonly totalRequests: number;
}

export interface ReplicateResult {
  readonly strategy: string;
  readonly stats: ReplicationStats;
  /** Absolute directory the report(s) and any raw pages were written to. */
  readonly outputDir: string;
}

const toNumber = (v: unknown): number => (v == null ? 0 : Number(v));

// The legacy engine only emits onProgress past a 500ms throttle with no final flush, so the captured stats
// reflect the last throttled tick — accurate for a real run (seconds long), but empty for a sub-500ms run.
// The authoritative record counts live in the written report / saved pages; these stats are the CLI summary.
const extractStats = (info: Record<string, unknown>): ReplicationStats => ({
  totalRecordsFetched: toNumber(info.totalRecordsFetched),
  meanResponseMs: toNumber(info.meanResponseMs),
  throughput: toNumber(info.throughput),
  totalRequests: toNumber(info.totalRequests),
});

export interface ReplicateOptions {
  readonly serviceRootUri: string;
  readonly strategy: string;
  readonly bearerToken: string;
  /** Single-resource mode: replicate this resource (with optional expansions). */
  readonly resourceName?: string;
  readonly expansions?: string;
  /** Report-driven mode: replicate every resource in this metadata report. Takes precedence over resourceName. */
  readonly metadataReportPath?: string;
  readonly filter?: string;
  readonly top?: number;
  readonly orderby?: string;
  readonly maxPageSize?: number;
  readonly limit?: number;
  readonly outputPath: string;
  readonly version?: string;
  readonly jsonSchemaValidation?: boolean;
  readonly strictMode?: boolean;
  /** Write every raw response page to <outputPath>/reso-replication-output/… (default false). */
  readonly shouldSaveResults?: boolean;
  /** Write the data-availability report(s) (default true). */
  readonly shouldGenerateReports?: boolean;
  readonly originatingSystemName?: string;
  readonly originatingSystemId?: string;
  readonly secondsDelayBetweenRequests?: number;
  readonly onProgress?: (info: Record<string, unknown>) => void;
}

/**
 * Run one replication pass. Validates the strategy, then invokes the legacy engine with a fresh state instance
 * and `throwOnError: true`. Resolves with the captured final stats and the resolved output directory; rejects
 * (rather than exiting the process) when the engine errors.
 */
export const runReplicate = async (opts: ReplicateOptions): Promise<ReplicateResult> => {
  if (!REPLICATION_STRATEGY_VALUES.includes(opts.strategy)) {
    throw new Error(
      `Unknown strategy '${opts.strategy}'. Must be one of: ${REPLICATION_STRATEGY_VALUES.join(', ')}.`,
    );
  }
  if (!opts.metadataReportPath && !opts.resourceName) {
    throw new Error('Provide either --resource <name> (single-resource) or --metadata <path> (report-driven).');
  }
  // Schema validation (and the data-availability report) need the metadata to generate the schema and know
  // every resource's fields, so they are report-driven-mode only.
  if (opts.jsonSchemaValidation && !opts.metadataReportPath) {
    throw new Error('Schema validation (--json-schema-validation / --strict) requires a metadata report (--metadata) — the schema is generated from it.');
  }

  const replicationStateService = createReplicationStateServiceInstance();
  let lastInfo: Record<string, unknown> = {};

  await replicate({
    serviceRootUri: opts.serviceRootUri,
    strategy: opts.strategy,
    bearerToken: opts.bearerToken,
    // Report-driven mode wins (legacy enumerates every resource in the report); otherwise single-resource params.
    pathToMetadataReportJson: opts.metadataReportPath ?? '',
    resourceName: opts.resourceName,
    expansions: opts.expansions,
    filter: opts.filter,
    top: opts.top,
    orderby: opts.orderby,
    maxPageSize: opts.maxPageSize,
    limit: opts.limit,
    outputPath: opts.outputPath,
    version: opts.version ?? DEFAULT_DD_VERSION,
    jsonSchemaValidation: opts.jsonSchemaValidation ?? false,
    strictMode: opts.strictMode ?? false,
    shouldSaveResults: opts.shouldSaveResults ?? false,
    shouldGenerateReports: opts.shouldGenerateReports ?? true,
    originatingSystemName: opts.originatingSystemName,
    originatingSystemId: opts.originatingSystemId,
    secondsDelayBetweenRequests: opts.secondsDelayBetweenRequests ?? 1,
    REPLICATION_STATE_SERVICE: replicationStateService,
    // Reject instead of process.exit(1) so the CLI action controls the exit code; keep the top-level loggers
    // quiet (fromCli: false) and surface our own summary.
    throwOnError: true,
    fromCli: false,
    onProgress: (info: Record<string, unknown>) => {
      lastInfo = info;
      opts.onProgress?.(info);
    },
  });

  return { strategy: opts.strategy, stats: extractStats(lastInfo), outputDir: resolve(opts.outputPath) };
};
