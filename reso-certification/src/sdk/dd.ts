/**
 * Data Dictionary SDK pipeline.
 *
 * Replaces the Commander-based DD workflow with direct calls to
 * cert-utils inner functions (replicate, findVariations) using
 * our own metadata serializer and Lookup Resource fetcher.
 */

import { writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveAuthToken } from '../test-runner/auth.js';
import { fetchMetadata } from '../test-runner/metadata.js';
import { generateMetadataReport } from '../metadata/serializer.js';
import { fetchAndMergeLookupResource } from '../metadata/lookup-resource.js';
import type { DDConfig, PipelineStep, StepResult, TestFunction } from './types.js';
import { createPipeline } from './pipeline.js';
import { createGenericReportGenerator, createDetailedReportGenerator, writeReports } from './reports.js';
import type { PipelineResult } from './types.js';
import { validateMetadata, formatValidationSummary, collectValidationErrors } from './metadata-validation.js';

// ── Cert-utils imports (local copy for modification) ──

// @ts-expect-error — legacy CJS, no type declarations
import certUtils from '../../legacy-cert-utils/index.js';
// @ts-expect-error — legacy CJS
import certUtilsCommon from '../../legacy-cert-utils/common.js';
// @ts-expect-error — legacy CJS
import certUtilsReplicationUtils from '../../legacy-cert-utils/lib/replication/utils.js';

const { replicate, findVariations } = certUtils;
const { createReplicationStateServiceInstance } = certUtilsCommon;
const { REPLICATION_STRATEGIES } = certUtilsReplicationUtils;

// ── Constants ──

const DEFAULT_LIMIT = 100000;
const DEFAULT_PAGE_SIZE_V17 = 100;
const DEFAULT_PAGE_SIZE_V20 = 1000;
const DEFAULT_YEARS_BACK = 3;
const DEFAULT_RESULTS_PATH = '.reso-cert';

/** Build the cert-utils compatible output directory path. */
const buildOutputPath = (config: DDConfig): string => {
  const resultsPath = config.options?.outputDir ?? join(process.cwd(), DEFAULT_RESULTS_PATH);
  const providerUoi = config.providerUoi ?? `LOCAL-${Date.now()}`;
  const providerUsi = config.providerUsi ?? 'LOCAL-SYSTEM';
  const recipientUoi = config.recipientUoi ?? 'LOCAL-RECIPIENT';
  return join(resultsPath, `data-dictionary-${config.version}`, `${providerUoi}-${providerUsi}`, recipientUoi, 'current');
};

/** Archive existing current results before a new run. */
const archiveCurrentResults = async (currentPath: string): Promise<void> => {
  if (!existsSync(currentPath)) return;
  const archivedDir = join(dirname(currentPath), 'archived', new Date().toISOString().replace(/[:.]/g, ''));
  await mkdir(dirname(archivedDir), { recursive: true });
  await rename(currentPath, archivedDir);
};

// ── Pipeline Context ──

interface DDContext {
  readonly serverUrl: string;
  readonly version: '1.7' | '2.0' | '2.1';
  readonly outputPath: string;
  readonly authToken?: string;
  readonly metadataReportPath?: string;
  readonly lookupResourceAvailable?: boolean;
  readonly lookupRecordCount?: number;
  readonly variationsFound?: boolean;
  readonly replicationResults?: unknown;
  readonly [key: string]: unknown;
}

// ── Pipeline Steps ──

const healthCheck: PipelineStep<DDContext> = {
  name: 'Health check',
  run: async (ctx, onProgress) => {
    // Fetch the OData service document with auth credentials
    const url = ctx.serverUrl;
    const headers: Record<string, string> = ctx.authToken
      ? { Authorization: `Bearer ${ctx.authToken}` }
      : {};
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(url, { headers });
        if (response.ok) {
          return { context: ctx, summary: `Server is ready at ${ctx.serverUrl}` };
        }
      } catch { /* network error — retry */ }
      await new Promise(resolve => setTimeout(resolve, 2000));
      onProgress({ step: 'Health check', status: 'running', message: `Waiting for server (attempt ${i + 1})...` });
    }
    return { context: ctx, status: 'failed', errors: [`Server at ${ctx.serverUrl} did not respond after ${maxAttempts} attempts`] };
  },
};

const resolveAuth = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Resolve authentication',
  run: async (ctx) => {
    const authToken = await resolveAuthToken(config.server.auth);
    return { context: { ...ctx, authToken }, summary: 'Auth credentials present' };
  },
});

const generateMetadata = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Generate metadata report',
  run: async (ctx, onProgress) => {
    await mkdir(ctx.outputPath, { recursive: true });

    // Fetch and validate EDMX metadata
    onProgress({ step: 'Generate metadata report', status: 'running', message: `Fetching ${ctx.serverUrl}/$metadata` });
    const edmxXml = await fetchMetadata(ctx.serverUrl, ctx.authToken!);

    // XSD + semantic validation
    const validation = await validateMetadata(edmxXml);
    const validationErrors = collectValidationErrors(validation);

    const baseReport = generateMetadataReport(edmxXml, ctx.version);

    // Write raw metadata XML
    const metadataXmlPath = join(ctx.outputPath, 'metadata.xml');
    await writeFile(metadataXmlPath, edmxXml);

    // Write base metadata report
    const baseReportPath = join(ctx.outputPath, 'metadata-report.json');
    await writeFile(baseReportPath, JSON.stringify(baseReport, null, 2));

    // Fetch Lookup Resource and merge if available
    onProgress({ step: 'Generate metadata report', status: 'running', message: 'Checking Lookup Resource...' });
    const { report, lookupResourceAvailable, lookupRecordCount, rawRecords } = await fetchAndMergeLookupResource(
      baseReport,
      ctx.serverUrl,
      ctx.authToken!,
    );

    let metadataReportPath = baseReportPath;

    if (lookupResourceAvailable && rawRecords) {
      // Write raw lookup resource data
      const { serializeLookupResourceDump } = await import('../metadata/lookup-resource.js');
      const lookupDump = serializeLookupResourceDump(rawRecords);
      await writeFile(join(ctx.outputPath, 'lookup-resource-lookup-metadata.json'), JSON.stringify(lookupDump, null, 2));

      // Write processed (merged) metadata report
      metadataReportPath = join(ctx.outputPath, 'metadata-report.processed.json');
      await writeFile(metadataReportPath, JSON.stringify(report, null, 2));
    }

    const lookupMsg = lookupResourceAvailable
      ? ` + ${lookupRecordCount.toLocaleString()} Lookup Resource records merged`
      : ' (no Lookup Resource)';

    const artifacts = [
      { label: 'Metadata XML', path: metadataXmlPath },
      { label: 'Metadata report', path: metadataReportPath },
    ];

    return {
      context: { ...ctx, metadataReportPath, lookupResourceAvailable, lookupRecordCount },
      summary: `${report.resources.length} resources, ${report.fields.length.toLocaleString()} fields, ${report.lookups.length.toLocaleString()} lookups${lookupMsg}. ${formatValidationSummary(validation)}`,
      counts: { resources: report.resources.length, fields: report.fields.length, lookups: report.lookups.length },
      artifacts,
      ...(validationErrors.length > 0 ? { errors: validationErrors } : {}),
      ...(!validation.xsdValid || !validation.semanticValid ? { status: 'failed' as const } : {}),
    };
  },
});

const runVariations = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Check variations',
  run: async (ctx, onProgress) => {
    if (ctx.version !== '2.0' && ctx.version !== '2.1') {
      return { context: ctx, status: 'skipped', summary: 'Variations only checked for DD 2.0' };
    }

    const { variations } = await findVariations({
      pathToMetadataReportJson: ctx.metadataReportPath,
      fromCli: true,
      strictMode: config.strictMode ?? false,
    });

    const hasVariations = Object.values(variations as Record<string, unknown[]>).some(
      (v: unknown[]) => v?.length > 0
    );

    if (config.strictMode && hasVariations) {
      return {
        context: { ...ctx, variationsFound: true },
        status: 'failed',
        errors: ['Found variations during testing'],
      };
    }

    return {
      context: { ...ctx, variationsFound: hasVariations },
      summary: hasVariations ? 'Variations found (non-strict mode)' : 'No variations found',
    };
  },
});

/** Build common replication settings from pipeline context. */
const buildReplicationSettings = (ctx: DDContext, config: DDConfig) => ({
  bearerToken: ctx.authToken,
  serviceRootUri: ctx.serverUrl,
  shouldGenerateReports: true,
  version: ctx.version,
  strictMode: config.strictMode ?? false,
  pathToMetadataReportJson: ctx.metadataReportPath,
  REPLICATION_STATE_SERVICE: ctx.replicationStateService,
  fromCli: true,
  limit: config.limit ?? DEFAULT_LIMIT,
  jsonSchemaValidation: config.strictMode ?? true,
  batchExpand: config.batchExpand ?? false,
  outputPath: ctx.outputPath,
  throwOnError: true,
  secondsDelayBetweenRequests: config.requestDelay ?? 1,
  rateLimitedWaitTimeMinutes: config.rateLimitWait ?? 15,
});

// ── Replication test functions ──
// These are individual async functions that can be composed into a step.
// Run sequentially by default, or in parallel when concurrency > 1.

/** Initialize replication state service and copy schema validation settings. */
const initReplicationState: TestFunction<DDContext> = async (ctx) => {
  if (!ctx.replicationStateService) {
    const settingsFile = 'schema-validation-settings.json';
    if (!existsSync(settingsFile)) {
      const packageRoot = join(dirname(new URL(import.meta.url).pathname), '..', '..');
      const sourcePaths = [
        join(packageRoot, settingsFile),
        join(packageRoot, 'legacy-cert-utils', settingsFile),
      ];
      const sourcePath = sourcePaths.find(p => existsSync(p));
      if (sourcePath) {
        await copyFile(sourcePath, settingsFile);
      }
    }
    return { context: { ...ctx, replicationStateService: createReplicationStateServiceInstance() } };
  }
  return { context: ctx };
};

/** Humanize a duration in ms to a short readable string. */
const humanizeMs = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
};

/** Humanize bytes to a short readable string. */
const humanizeBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

/**
 * Format replication progress as structured JSON for the UI bar chart.
 * The UI detects JSON detail strings and renders them as a real-time chart.
 * Falls back to a plain text summary for non-UI consumers.
 */
const formatReplicationProgress = (info: Record<string, unknown>): string => {
  const resourceStats = info.resourceStats as ReadonlyArray<Record<string, unknown>> | undefined;
  const totalFetched = Number(info.totalRecordsFetched ?? 0);
  const throughput = info.throughput != null ? Number(info.throughput) : null;
  const meanMs = info.meanResponseMs != null ? Number(info.meanResponseMs) : null;
  const totalBytes = info.totalBytes != null ? Number(info.totalBytes) : null;
  const anomalies = Number(info.anomalyCount ?? 0);

  const resources = (resourceStats ?? []).map((r) => ({
    name: String(r.resourceName ?? ''),
    records: Number(r.recordCount ?? 0),
    bytes: Number(r.bytes ?? 0),
  }));

  return JSON.stringify({
    _type: 'replication-progress',
    resources,
    totalRecords: totalFetched,
    totalBytes,
    throughput,
    meanResponseMs: meanMs,
    anomalyCount: anomalies,
  });
};

/** Build the onProgress adapter and a stats collector for a replication run. */
const replicationProgressAdapter = (onProgress: import('./types.js').ProgressCallback) => {
  let lastInfo: Record<string, unknown> = {};
  return {
    callback: (info: Record<string, unknown>) => {
      lastInfo = info;
      onProgress({ step: 'sub:replicate', status: 'running', message: formatReplicationProgress(info) });
    },
    getLastStats: () => ({
      totalRecordsFetched: Number(lastInfo.totalRecordsFetched ?? 0),
      meanResponseMs: Number(lastInfo.meanResponseMs ?? 0),
      throughput: Number(lastInfo.throughput ?? 0),
      anomalyCount: Number(lastInfo.anomalyCount ?? 0),
      totalRequests: Number(lastInfo.totalRequests ?? 0),
    }),
  };
};

const replicateTimestampDesc = (config: DDConfig): TestFunction<DDContext> =>
  async (ctx, onProgress) => {
    const pageSize = ctx.version === '1.7' ? DEFAULT_PAGE_SIZE_V17 : DEFAULT_PAGE_SIZE_V20;
    const progress = replicationProgressAdapter(onProgress);
    await replicate({
      ...buildReplicationSettings(ctx, config),
      jsonSchemaValidation: ctx.version !== '1.7' ? (config.strictMode ?? true) : false,
      top: pageSize,
      strategy: REPLICATION_STRATEGIES.TIMESTAMP_DESC,
      onProgress: progress.callback,
    });
    const stats = progress.getLastStats();
    return { context: ctx, summary: `TIMESTAMP_DESC with $top=${pageSize}`, counts: stats };
  };

const replicateNextLink = (config: DDConfig): TestFunction<DDContext> =>
  async (ctx, onProgress) => {
    const progress = replicationProgressAdapter(onProgress);
    await replicate({
      ...buildReplicationSettings(ctx, config),
      maxPageSize: DEFAULT_PAGE_SIZE_V20,
      strategy: REPLICATION_STRATEGIES.NEXT_LINK,
      onProgress: progress.callback,
    });
    const stats = progress.getLastStats();
    return { context: ctx, summary: `NEXT_LINK with maxPageSize=${DEFAULT_PAGE_SIZE_V20}`, counts: stats };
  };

const replicateNextLinkFiltered = (config: DDConfig): TestFunction<DDContext> =>
  async (ctx, onProgress) => {
    const cutoffDate = new Date(new Date().getFullYear() - DEFAULT_YEARS_BACK, 0).toISOString();
    const progress = replicationProgressAdapter(onProgress);
    await replicate({
      ...buildReplicationSettings(ctx, config),
      maxPageSize: DEFAULT_PAGE_SIZE_V20,
      strategy: REPLICATION_STRATEGIES.NEXT_LINK,
      filter: `ModificationTimestamp ge ${cutoffDate}`,
      orderby: 'ModificationTimestamp asc',
      onProgress: progress.callback,
    });
    const stats = progress.getLastStats();
    return { context: ctx, summary: `NEXT_LINK + ModificationTimestamp filter (${DEFAULT_YEARS_BACK}yr lookback)`, counts: stats };
  };

/** Build the replication step with all strategies as test functions. */
const replicateAndValidate = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Replicate and validate',
  // Init must run first (sequential), then replication strategies can run
  // in parallel if enabled. Default is sequential to avoid overloading servers.
  mode: 'sequential',
  functions: [
    initReplicationState,
    ...(config.parallelReplicate
      ? [async (ctx: Readonly<DDContext>, onProgress: import('./types.js').ProgressCallback) => {
          // Run all replication strategies in parallel
          const fns = [
            replicateTimestampDesc(config),
            ...(config.version !== '1.7' ? [
              replicateNextLink(config),
              replicateNextLinkFiltered(config),
            ] : []),
          ];
          const results = await Promise.all(fns.map(fn => fn(ctx, onProgress)));
          const summaries = results.map(r => r.summary).filter(Boolean);
          return { context: ctx, summary: summaries.join('; ') };
        }]
      : [
          replicateTimestampDesc(config),
          ...(config.version !== '1.7' ? [
            replicateNextLink(config),
            replicateNextLinkFiltered(config),
          ] : []),
        ]
    ),
  ],
});

/** Serialize DD pipeline results into a human-readable remarks string. */
const serializeDDRemarks = (result: PipelineResult): string => {
  const metaStep = result.steps.find(s => s.name === 'Generate metadata report');
  const parts: string[] = [];
  if (metaStep?.counts) {
    parts.push(`${metaStep.counts.resources} resources, ${(metaStep.counts.fields ?? 0).toLocaleString()} fields, ${(metaStep.counts.lookups ?? 0).toLocaleString()} lookups`);
  }
  parts.push(`Data Dictionary compliance test ${result.status}`);
  return `${parts.join('. ')}.`;
};

/** Create DD report generators. */
const ddReportGenerators = (version: string) => [
  createGenericReportGenerator('Data Dictionary', version, serializeDDRemarks),
  createDetailedReportGenerator('Data Dictionary', version, serializeDDRemarks),
];

const writeComplianceReports = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Write compliance reports',
  run: async (ctx, onProgress) => {
    const generators = ddReportGenerators(config.version);
    const pipelineResult = {
      status: 'passed' as const,
      endorsement: 'dd',
      steps: ctx.pipelineSteps as ReadonlyArray<StepResult> ?? [],
      context: ctx,
      duration: 0,
    };
    const written = await writeReports(pipelineResult, generators, ctx.outputPath, onProgress);
    return {
      context: { ...ctx, reports: written },
      summary: `${written.length} reports written`,
      artifacts: written.map(r => ({ label: r.name, path: r.path })),
    };
  },
});

// ── Pipeline Assembly ──

/** Create the DD compliance test pipeline. */
export const createDDPipeline = (config: DDConfig) =>
  createPipeline<DDContext>('dd', [
    resolveAuth(config),
    ...(config.options?.skipHealthCheck ? [] : [healthCheck]),
    generateMetadata(config),
    ...(config.version !== '1.7' ? [runVariations(config)] : []),
    replicateAndValidate(config),
    writeComplianceReports(config),
  ]);

/** Run DD compliance tests with a single function call. */
export const runDDCompliance = async (
  config: DDConfig,
  onProgress?: (progress: import('./types.js').StepProgress) => void,
) => {
  const outputPath = buildOutputPath(config);

  // Archive previous results before starting
  await archiveCurrentResults(outputPath);

  const pipeline = createDDPipeline(config);
  const initialContext: DDContext = {
    serverUrl: config.server.url,
    version: config.version,
    outputPath,
  };

  return pipeline.run(
    initialContext,
    onProgress,
    { failFast: config.options?.failFast ?? true },
  );
};
