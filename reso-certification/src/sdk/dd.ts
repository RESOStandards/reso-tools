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
import type { DDConfig, PipelineStep, StepResult } from './types.js';
import { createPipeline } from './pipeline.js';
import { coreReportGenerators, writeReports } from './reports.js';
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
const DEFAULT_YEARS_BACK = 2;
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
    const url = `${ctx.serverUrl}/health`;
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return { context: ctx, summary: `Server is ready at ${ctx.serverUrl}` };
        }
      } catch { /* retry */ }
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
    onProgress({ step: 'Generate metadata report', status: 'running', message: 'Fetching $metadata...' });
    const edmxXml = await fetchMetadata(ctx.serverUrl, ctx.authToken!);

    // XSD + semantic validation
    const validation = validateMetadata(edmxXml);
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
      ? ` + ${lookupRecordCount} Lookup Resource records merged`
      : ' (no Lookup Resource)';

    const artifacts = [
      { label: 'Metadata XML', path: metadataXmlPath },
      { label: 'Metadata report', path: metadataReportPath },
    ];

    return {
      context: { ...ctx, metadataReportPath, lookupResourceAvailable, lookupRecordCount },
      summary: `${report.resources.length} resources, ${report.fields.length} fields, ${report.lookups.length} lookups${lookupMsg}. ${formatValidationSummary(validation)}`,
      counts: { resources: report.resources.length, fields: report.fields.length, lookups: report.lookups.length },
      artifacts,
      ...(validationErrors.length > 0 ? { errors: validationErrors } : {}),
      ...(!validation.xsdValid || !validation.semanticValid ? { status: 'failed' as const } : {}),
    };
  },
});

const runVariations = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Check variations',
  run: async (ctx) => {
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
});

const initReplicationState: PipelineStep<DDContext> = {
  name: 'Initialize replication state',
  run: async (ctx) => {
    // cert-utils reads schema-validation-settings.json from cwd.
    // Copy from the package's reference file if not already present.
    const settingsFile = 'schema-validation-settings.json';
    if (!existsSync(settingsFile)) {
      // Try the package root first (checked-in reference file), then legacy-cert-utils
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

    return {
      context: { ...ctx, replicationStateService: createReplicationStateServiceInstance() },
      summary: 'Replication state service initialized',
    };
  },
};

const replicateTimestampDesc = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Replicate: TIMESTAMP_DESC',
  run: async (ctx) => {
    const pageSize = ctx.version === '1.7' ? DEFAULT_PAGE_SIZE_V17 : DEFAULT_PAGE_SIZE_V20;
    await replicate({
      ...buildReplicationSettings(ctx, config),
      jsonSchemaValidation: ctx.version !== '1.7' ? (config.strictMode ?? true) : false,
      top: pageSize,
      strategy: REPLICATION_STRATEGIES.TIMESTAMP_DESC,
    });
    return { context: ctx, summary: `TIMESTAMP_DESC with $top=${pageSize}` };
  },
});

const replicateNextLink = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Replicate: NEXT_LINK',
  run: async (ctx) => {
    await replicate({
      ...buildReplicationSettings(ctx, config),
      maxPageSize: DEFAULT_PAGE_SIZE_V20,
      strategy: REPLICATION_STRATEGIES.NEXT_LINK,
    });
    return { context: ctx, summary: `NEXT_LINK with maxPageSize=${DEFAULT_PAGE_SIZE_V20}` };
  },
});

const replicateNextLinkFiltered = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Replicate: NEXT_LINK + filter',
  run: async (ctx) => {
    const cutoffDate = new Date(new Date().getFullYear() - DEFAULT_YEARS_BACK, 0).toISOString();
    await replicate({
      ...buildReplicationSettings(ctx, config),
      maxPageSize: DEFAULT_PAGE_SIZE_V20,
      strategy: REPLICATION_STRATEGIES.NEXT_LINK,
      filter: `ModificationTimestamp ge ${cutoffDate}`,
      orderby: 'ModificationTimestamp asc',
    });
    return { context: ctx, summary: `NEXT_LINK + ModificationTimestamp filter (${DEFAULT_YEARS_BACK}yr lookback)` };
  },
});

// ── Pipeline Assembly ──

/** Create the DD compliance test pipeline. */
export const createDDPipeline = (config: DDConfig) =>
  createPipeline<DDContext>('dd', [
    ...(config.options?.skipHealthCheck ? [] : [healthCheck]),
    resolveAuth(config),
    generateMetadata(config),
    initReplicationState,
    ...(config.version !== '1.7' ? [runVariations(config)] : []),
    replicateTimestampDesc(config),
    ...(config.version !== '1.7' ? [
      replicateNextLink(config),
      replicateNextLinkFiltered(config),
    ] : []),
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
