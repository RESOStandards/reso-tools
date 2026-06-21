/**
 * Data Dictionary SDK pipeline.
 *
 * Replaces the Commander-based DD workflow with direct calls to
 * cert-utils inner functions (replicate, findVariations) using
 * our own metadata serializer and Lookup Resource fetcher.
 */

import { writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveAuthToken } from '../test-runner/auth.js';
import { fetchMetadataWithVersion, persistMetadataXml } from '../test-runner/metadata.js';
import { generateMetadataReport } from '../metadata/serializer.js';
import type { MetadataReport } from '../metadata/serializer.js';
import { runDdMetadataChecks } from '../metadata/dd-metadata-checks.js';
import type { DdReference } from '../metadata/dd-metadata-checks.js';
import { fetchAndMergeLookupResource } from '../metadata/lookup-resource.js';
import type { BaseTestContext, DDConfig, PipelineStep, StepResult, TestFunction } from './types.js';
import type { DDVersion } from './dd-versions.js';
import { createPipeline } from './pipeline.js';
import { createGenericReportGenerator, createDetailedReportGenerator, writeReports, prepareOutputDir } from './reports.js';
import type { PipelineResult } from './types.js';
import { validateMetadata, formatValidationSummary, collectValidationErrors } from './metadata-validation.js';

// ── Cert-utils imports (local copy for modification) ──

// @ts-expect-error — legacy CJS, no type declarations
import certUtils from '../legacy/index.js';
// @ts-expect-error — legacy CJS
import certUtilsCommon from '../legacy/common.js';
// @ts-expect-error — legacy CJS
import certUtilsReplicationUtils from '../legacy/lib/replication/utils.js';
// @ts-expect-error — legacy CJS (reference metadata loader)
import certUtilsEtl from '../etl/index.cjs';

const { replicate, findVariations } = certUtils;
const { createReplicationStateServiceInstance } = certUtilsCommon;
const { REPLICATION_STRATEGIES } = certUtilsReplicationUtils;
const { getReferenceMetadata } = certUtilsEtl as { getReferenceMetadata: (version: string) => DdReference };

// ── Constants ──

const DEFAULT_LIMIT = 100000;
const DEFAULT_PAGE_SIZE_V17 = 100;
const DEFAULT_PAGE_SIZE_V20 = 1000;
const DEFAULT_YEARS_BACK = 3;

// ── Pipeline Context ──

interface DDContext extends BaseTestContext {
  readonly version: DDVersion;
  readonly metadataReportPath?: string;
  /** The merged metadata report, threaded so the DD metadata gate runs without re-reading the file. */
  readonly metadataReport?: MetadataReport;
  readonly ddMetadataValid?: boolean;
  readonly lookupResourceAvailable?: boolean;
  readonly lookupRecordCount?: number;
  readonly variationsFound?: boolean;
  readonly replicationResults?: unknown;
  readonly [key: string]: unknown;
}

// ── Pipeline Steps ──

/** OData service check — fetches the service document to confirm the server is reachable and speaks OData. */
const serviceCheck: PipelineStep<DDContext> = {
  name: 'Service check',
  run: async (ctx, onProgress) => {
    const url = ctx.serverUrl;
    // Identifying User-Agent + explicit Accept so servers behind WAFs
    // (e.g. MLS Grid) do not reject the request based on the
    // unidentified default User-Agent ('node') that undici emits.
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'RESO-Cert/0.11',
    };
    if (ctx.authToken) headers['Authorization'] = `Bearer ${ctx.authToken}`;
    const maxAttempts = 10;
    let lastStatus: number | undefined;
    let lastBody: string | undefined;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(url, { headers });
        if (response.ok) {
          return { context: ctx, summary: 'OData service is ready', requestDetails: [{ method: 'GET', url }] };
        }
        lastStatus = response.status;
        try { lastBody = (await response.text()).slice(0, 500); } catch { /* ignore body read errors */ }
      } catch (err) {
        lastBody = err instanceof Error ? err.message : String(err);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      onProgress({ step: 'Service check', status: 'running', message: `Waiting for server (attempt ${i + 1})...` });
    }
    const errorDetail = lastStatus
      ? `HTTP ${lastStatus}${lastBody ? ` — ${lastBody}` : ''}`
      : `No response after ${maxAttempts} attempts${lastBody ? ` (last error: ${lastBody})` : ''}`;
    return { context: ctx, status: 'failed', errors: [`OData service did not respond: ${errorDetail}`], requestDetails: [{ method: 'GET', url, error: errorDetail }] };
  },
};

const resolveAuth = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Resolve authentication',
  run: async (ctx) => {
    const authToken = await resolveAuthToken(config.server.auth);
    const requestDetails = config.server.auth.mode === 'client_credentials'
      ? [{ method: 'POST', url: config.server.auth.tokenUrl }]
      : [];
    return { context: { ...ctx, authToken }, summary: 'Auth credentials present', requestDetails };
  },
});

const generateMetadata = (_config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Generate metadata report',
  run: async (ctx, onProgress) => {
    // outputPath is prepped by runDDCompliance before the pipeline
    // starts (build + archive + mkdir via prepareOutputDir). No local
    // mkdir needed here.

    // Fetch and validate EDMX metadata (also detects OData version)
    onProgress({ step: 'sub:metadata', status: 'running', message: 'Fetching OData XML metadata...' });
    const { xml: edmxXml, odataVersion } = await fetchMetadataWithVersion(ctx.serverUrl, ctx.authToken!);
    if (odataVersion) {
      onProgress({ step: 'sub:metadata', status: 'running', message: `Detected OData version: ${odataVersion}` });
    }

    // XSD + semantic validation
    onProgress({ step: 'sub:metadata', status: 'running', message: 'Validating CSDL XML (XSD + semantic checks)...' });
    const validation = await validateMetadata(edmxXml);
    const validationErrors = collectValidationErrors(validation);

    onProgress({ step: 'sub:metadata', status: 'running', message: 'Generating metadata report...' });
    const baseReport = generateMetadataReport(edmxXml, ctx.version);
    onProgress({ step: 'sub:metadata', status: 'running', message: `Found ${baseReport.resources.length} resources, ${baseReport.fields.length.toLocaleString()} fields, ${baseReport.lookups.length.toLocaleString()} lookups` });

    // Persist raw EDMX next to the report files (shared helper, same
    // semantics as every other compliance pipeline).
    const metadataXmlPath = await persistMetadataXml(ctx.outputPath, edmxXml);

    // Fetch Lookup Resource and merge if available
    const lookupUrl = `${ctx.serverUrl}/Lookup`;
    onProgress({ step: 'sub:metadata', status: 'running', message: 'Fetching Lookup Resource...' });
    const { report, lookupResourceAvailable, lookupRecordCount, rawRecords } = await fetchAndMergeLookupResource(
      baseReport,
      ctx.serverUrl,
      ctx.authToken!,
      (count) => onProgress({ step: 'sub:metadata', status: 'running', message: `Fetching Lookup Resource... ${count.toLocaleString()} records` }),
      odataVersion,
    );

    if (lookupResourceAvailable) {
      onProgress({ step: 'sub:metadata', status: 'running', message: `Lookup Resource: ${lookupRecordCount.toLocaleString()} records found. Merging...` });
    } else {
      onProgress({ step: 'sub:metadata', status: 'running', message: 'Lookup Resource not available (HTTP 404)' });
    }

    // The canonical metadata report is ALWAYS metadata-report.json. `report` is the
    // merged result when a Lookup Resource is present, otherwise the base report
    // unchanged — so downstream always reads metadata-report.json and never has to
    // choose between a base file and a ".processed" file (this inverts the old scheme
    // where metadata-report.json was the base and metadata-report.processed.json the
    // merged variant). When a merge actually happens we also keep the pre-merge
    // snapshot as metadata-report.raw.json; with no Lookup Resource the two would be
    // byte-identical, so raw is written only when it differs.
    const metadataReportPath = join(ctx.outputPath, 'metadata-report.json');
    await writeFile(metadataReportPath, JSON.stringify(report, null, 2));

    if (lookupResourceAvailable && rawRecords) {
      // Write raw lookup resource data
      const { serializeLookupResourceDump } = await import('../metadata/lookup-resource.js');
      const lookupDump = serializeLookupResourceDump(rawRecords);
      await writeFile(join(ctx.outputPath, 'lookup-resource-lookup-metadata.json'), JSON.stringify(lookupDump, null, 2));

      // Pre-merge metadata report (provenance): the base before the Lookup Resource merge.
      await writeFile(join(ctx.outputPath, 'metadata-report.raw.json'), JSON.stringify(baseReport, null, 2));
    }

    const lookupMsg = lookupResourceAvailable
      ? ` + ${lookupRecordCount.toLocaleString()} Lookup Resource records merged`
      : ' (no Lookup Resource)';

    const artifacts = [
      { label: 'Metadata XML', path: metadataXmlPath },
      { label: 'Metadata report', path: metadataReportPath },
    ];

    return {
      context: { ...ctx, metadataReportPath, metadataReport: report, lookupResourceAvailable, lookupRecordCount, odataVersion },
      summary: `${report.resources.length} resources, ${report.fields.length.toLocaleString()} fields, ${report.lookups.length.toLocaleString()} lookups${lookupMsg}. ${formatValidationSummary(validation)}`,
      counts: { resources: report.resources.length, fields: report.fields.length, lookups: report.lookups.length },
      artifacts,
      requestDetails: [
        // Match what the wrapper actually fetches (useFormatParam: true).
        { method: 'GET', url: `${ctx.serverUrl}/$metadata?$format=application/xml` },
        ...(lookupResourceAvailable ? [{ method: 'GET', url: lookupUrl }] : []),
      ],
      ...(validationErrors.length > 0 ? { errors: validationErrors } : {}),
      ...(!validation.xsdValid || !validation.semanticValid ? { status: 'failed' as const } : {}),
    };
  },
});

/**
 * DD metadata gate — the fail-fast metadata-validation step. Runs AFTER the semantic/structural
 * OData validation (in generateMetadata) and BEFORE variations: metadata issues (wrong data types,
 * disallowed synonyms, closed-enum violations, Lookup Resource integrity) short-circuit the mapping
 * (variations) check, mirroring the Web API Commander. `error` findings fail the step (the pipeline
 * is fail-fast, so variations never runs); `warning` findings (the DD's SHOULD suggested-max
 * attributes) are surfaced as non-blocking messages.
 */
const validateDdMetadata = (_config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Validate DD metadata',
  run: async (ctx, onProgress) => {
    const report = ctx.metadataReport;
    if (!report) {
      return { context: ctx, status: 'skipped', summary: 'No metadata report available for DD metadata validation' };
    }

    // Skip gracefully if this version ships no reference metadata.
    const reference = (() => {
      try {
        return getReferenceMetadata(ctx.version);
      } catch {
        return undefined;
      }
    })();
    if (!reference) {
      return { context: ctx, status: 'skipped', summary: `No DD reference metadata for version ${ctx.version}` };
    }

    const findings = runDdMetadataChecks(report, reference);
    const errors = findings.filter(f => f.severity === 'error');
    const warnings = findings.filter(f => f.severity === 'warning');

    // SHOULD recommendations are surfaced but do not fail certification.
    for (const w of warnings) {
      onProgress({ step: 'sub:dd-metadata', status: 'running', message: w.message });
    }
    const warningSuffix = warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : '';

    if (errors.length > 0) {
      return {
        context: { ...ctx, ddMetadataValid: false },
        status: 'failed',
        errors: errors.map(e => e.message),
        summary: `Metadata validation failed: ${errors.length} issue${errors.length === 1 ? '' : 's'}${warningSuffix}`,
      };
    }

    return {
      context: { ...ctx, ddMetadataValid: true },
      summary: `Metadata validation passed${warningSuffix}`,
    };
  },
});

const runVariations = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Check variations',
  run: async (ctx, _onProgress) => {
    if (parseFloat(ctx.version) < 2.0) {
      return { context: ctx, status: 'skipped', summary: 'Variations are only checked for DD 2.0 and higher' };
    }

    // Forward the caller's services.reso.org session bearer so the
    // variations check can call the Variations Service. Without it the
    // legacy code falls back to env-var auth (CLI path).
    const { variations, fuzziness } = await findVariations({
      pathToMetadataReportJson: ctx.metadataReportPath,
      fromCli: true,
      strictMode: config.strictMode ?? false,
      ...(config.servicesAuthToken ? { bearerToken: config.servicesAuthToken } : {}),
    });

    const v = variations as Record<string, unknown[]>;
    const counts = {
      resources: v.resources?.length ?? 0,
      fields: v.fields?.length ?? 0,
      lookups: v.lookups?.length ?? 0,
      expansions: v.expansions?.length ?? 0,
      complexTypes: v.complexTypes?.length ?? 0,
    };
    const total = counts.resources + counts.fields + counts.lookups + counts.expansions + counts.complexTypes;
    const hasVariations = total > 0;

    const parts = [
      counts.resources > 0 && `${counts.resources} resource${counts.resources !== 1 ? 's' : ''}`,
      counts.fields > 0 && `${counts.fields} field${counts.fields !== 1 ? 's' : ''}`,
      counts.lookups > 0 && `${counts.lookups} lookup${counts.lookups !== 1 ? 's' : ''}`,
      counts.expansions > 0 && `${counts.expansions} expansion${counts.expansions !== 1 ? 's' : ''}`,
    ].filter(Boolean);
    const summaryDetail = parts.length > 0 ? `: ${parts.join(', ')}` : '';

    // Write variations report alongside other artifacts. Wrap the
    // raw buckets with provenance metadata so the file is durable
    // even if the surrounding SQLite job record is lost — admins can
    // still tell which provider/recipient/version produced these
    // variations by reading the file directly. The blender accepts
    // either shape (top-level buckets or a `{ variations: {...} }`
    // wrapper), so both old and new files load cleanly.
    if (hasVariations && ctx.outputPath) {
      const variationsPath = join(ctx.outputPath, 'variations-report.json');
      const reportBody = {
        version: ctx.version,
        providerUoi: config.providerUoi,
        providerUsi: config.providerUsi,
        recipientUoi: config.recipientUoi,
        generatedOn: new Date().toISOString(),
        // findVariations returns fuzziness alongside the buckets; surface
        // it on the file so the UI can display "Match Sensitivity: N%".
        // Without this, the blender's `fuzziness ?? 0` fallback shows 0%.
        fuzziness: fuzziness as number | undefined,
        ...(variations as Record<string, unknown>),
      };
      await writeFile(variationsPath, JSON.stringify(reportBody, null, 2));
    }

    if (hasVariations) {
      return {
        context: { ...ctx, variationsFound: true, variationsReport: variations },
        status: 'failed',
        errors: [`Found ${total} variation${total !== 1 ? 's' : ''} during testing${summaryDetail}`],
        counts: { total, ...counts },
      };
    }

    return {
      context: { ...ctx, variationsFound: false },
      summary: 'No variations found',
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
  // Optional OriginatingSystem filter — passed straight to legacy
  // cert-utils' prepareFilterExpression, which appends
  // `OriginatingSystemName eq '<v>'` (preferred) or
  // `OriginatingSystemID eq '<v>'` (fallback) to every replication query.
  originatingSystemName: config.originatingSystemName,
  originatingSystemId: config.originatingSystemId,
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
        join(packageRoot, 'src', 'legacy', settingsFile),
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

/**
 * Format replication progress as structured JSON for the UI bar chart.
 * The UI detects JSON detail strings and renders them as a real-time chart.
 * Falls back to a plain text summary for non-UI consumers.
 */
const formatReplicationProgress = (info: Record<string, unknown>, currentStrategy: string): string => {
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
    // Per-resource anomaly metadata for the chart tooltip (#206).
    // Absent on rows where no timed responses have arrived yet.
    meanMs: r.meanMs != null ? Number(r.meanMs) : null,
    anomalyCount: r.anomalyCount != null ? Number(r.anomalyCount) : 0,
    maxAnomalyMs: r.maxAnomalyMs != null ? Number(r.maxAnomalyMs) : null,
    maxAnomalyDelta: r.maxAnomalyDelta != null ? Number(r.maxAnomalyDelta) : null,
  }));

  return JSON.stringify({
    _type: 'replication-progress',
    currentStrategy,
    resources,
    totalRecords: totalFetched,
    totalBytes,
    throughput,
    meanResponseMs: meanMs,
    anomalyCount: anomalies,
  });
};

/** Build the onProgress adapter and a stats collector for a replication run. */
const replicationProgressAdapter = (
  onProgress: import('./types.js').ProgressCallback,
  currentStrategy: string,
) => {
  let lastInfo: Record<string, unknown> = {};
  return {
    callback: (info: Record<string, unknown>) => {
      lastInfo = info;
      onProgress({ step: 'sub:replicate', status: 'running', message: formatReplicationProgress(info, currentStrategy) });
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
    const progress = replicationProgressAdapter(onProgress, 'Timestamp Descending');
    await replicate({
      ...buildReplicationSettings(ctx, config),
      jsonSchemaValidation: ctx.version !== '1.7' ? (config.strictMode ?? true) : false,
      top: pageSize,
      strategy: REPLICATION_STRATEGIES.TIMESTAMP_DESC,
      onProgress: progress.callback,
    });
    const stats = progress.getLastStats();
    return { context: ctx, summary: `Timestamp Descending with $top=${pageSize}`, counts: stats };
  };

const replicateNextLink = (config: DDConfig): TestFunction<DDContext> =>
  async (ctx, onProgress) => {
    const progress = replicationProgressAdapter(onProgress, 'NextLink');
    await replicate({
      ...buildReplicationSettings(ctx, config),
      maxPageSize: DEFAULT_PAGE_SIZE_V20,
      strategy: REPLICATION_STRATEGIES.NEXT_LINK,
      onProgress: progress.callback,
    });
    const stats = progress.getLastStats();
    return { context: ctx, summary: `NextLink with maxPageSize=${DEFAULT_PAGE_SIZE_V20}`, counts: stats };
  };

const replicateNextLinkFiltered = (config: DDConfig): TestFunction<DDContext> =>
  async (ctx, onProgress) => {
    const cutoffDate = new Date(new Date().getFullYear() - DEFAULT_YEARS_BACK, 0).toISOString();
    const progress = replicationProgressAdapter(onProgress, 'NextLink (modified-since filter)');
    await replicate({
      ...buildReplicationSettings(ctx, config),
      maxPageSize: DEFAULT_PAGE_SIZE_V20,
      strategy: REPLICATION_STRATEGIES.NEXT_LINK,
      filter: `ModificationTimestamp ge ${cutoffDate}`,
      orderby: 'ModificationTimestamp asc',
      onProgress: progress.callback,
    });
    const stats = progress.getLastStats();
    return { context: ctx, summary: `NextLink (modified-since filter, ${DEFAULT_YEARS_BACK}yr lookback)`, counts: stats };
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
  name: 'Write reports',
  // DD runs with failFast: true, so an earlier step failure (e.g.,
  // variations detected) breaks the pipeline. Without alwaysRun, Write
  // reports would never run and the failure-mode reports would never
  // hit disk. With it, Write reports always emits — capturing whatever
  // partial state exists for the failed run — and steps in between
  // remain marked 'skipped' to reflect what actually happened.
  alwaysRun: true,
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
    };
  },
});

// ── Pipeline Assembly ──

/** Create the DD compliance test pipeline. */
export const createDDPipeline = (config: DDConfig) =>
  createPipeline<DDContext>('dd', [
    resolveAuth(config),
    ...(config.options?.skipHealthCheck ? [] : [serviceCheck]),
    generateMetadata(config),
    validateDdMetadata(config),
    ...(config.version !== '1.7' ? [runVariations(config)] : []),
    replicateAndValidate(config),
    writeComplianceReports(config),
  ]);

/** Run DD compliance tests with a single function call. */
export const runDDCompliance = async (
  config: DDConfig,
  onProgress?: (progress: import('./types.js').StepProgress) => void,
) => {
  const outputPath = await prepareOutputDir('data-dictionary', config.version, config);

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
