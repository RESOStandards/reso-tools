/**
 * Data Dictionary SDK pipeline.
 *
 * Replaces the Commander-based DD workflow with direct calls to
 * cert-utils inner functions (replicate, findVariations) using
 * our own metadata serializer and Lookup Resource fetcher.
 */

import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { resolveAuthToken } from '../test-runner/auth.js';
import { fetchMetadata } from '../test-runner/metadata.js';
import { generateMetadataReport } from '../metadata/serializer.js';
import { fetchAndMergeLookupResource } from '../metadata/lookup-resource.js';
import type { DDConfig, PipelineStep, StepResult } from './types.js';
import { createPipeline } from './pipeline.js';
import { coreReportGenerators, writeReports } from './reports.js';

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

// ── Pipeline Context ──

interface DDContext {
  readonly serverUrl: string;
  readonly version: '1.7' | '2.0';
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
    return { context: { ...ctx, authToken }, summary: `Authenticated via ${config.server.auth.mode}` };
  },
});

const generateMetadata = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Generate metadata report',
  run: async (ctx, onProgress) => {
    const outputDir = config.options?.outputDir ?? join(process.cwd(), '.reso-cert', 'dd');
    await mkdir(outputDir, { recursive: true });

    // Fetch and serialize EDMX metadata
    onProgress({ step: 'Generate metadata report', status: 'running', message: 'Fetching $metadata...' });
    const edmxXml = await fetchMetadata(ctx.serverUrl, ctx.authToken!);
    const baseReport = generateMetadataReport(edmxXml, ctx.version);

    // Fetch Lookup Resource and merge if available
    onProgress({ step: 'Generate metadata report', status: 'running', message: 'Checking Lookup Resource...' });
    const { report, lookupResourceAvailable, lookupRecordCount } = await fetchAndMergeLookupResource(
      baseReport,
      ctx.serverUrl,
      ctx.authToken!,
    );

    // Write the metadata report to disk (cert-utils needs a file path)
    const reportFileName = lookupResourceAvailable ? 'metadata-report.processed.json' : 'metadata-report.json';
    const metadataReportPath = join(outputDir, reportFileName);
    await writeFile(metadataReportPath, JSON.stringify(report, null, 2));

    const lookupMsg = lookupResourceAvailable
      ? ` + ${lookupRecordCount} Lookup Resource records merged`
      : ' (no Lookup Resource)';

    return {
      context: { ...ctx, metadataReportPath, lookupResourceAvailable, lookupRecordCount },
      summary: `${report.resources.length} resources, ${report.fields.length} fields, ${report.lookups.length} lookups${lookupMsg}`,
      counts: { resources: report.resources.length, fields: report.fields.length, lookups: report.lookups.length },
      artifacts: [{ label: 'Metadata report', path: metadataReportPath }],
    };
  },
});

const runVariations = (config: DDConfig): PipelineStep<DDContext> => ({
  name: 'Check variations',
  run: async (ctx) => {
    if (ctx.version !== '2.0') {
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
});

const initReplicationState: PipelineStep<DDContext> = {
  name: 'Initialize replication state',
  run: async (ctx) => {
    // cert-utils reads schema-validation-settings.json from cwd — ensure it's there
    const settingsFile = 'schema-validation-settings.json';
    if (!existsSync(settingsFile)) {
      const require = createRequire(import.meta.url);
      const certUtilsPath = dirname(require.resolve('@reso/reso-certification-utils/common.js'));
      const sourcePath = join(certUtilsPath, settingsFile);
      if (existsSync(sourcePath)) {
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
    ...(config.version === '2.0' ? [runVariations(config)] : []),
    replicateTimestampDesc(config),
    ...(config.version === '2.0' ? [
      replicateNextLink(config),
      replicateNextLinkFiltered(config),
    ] : []),
  ]);

/** Run DD compliance tests with a single function call. */
export const runDDCompliance = async (
  config: DDConfig,
  onProgress?: (progress: import('./types.js').StepProgress) => void,
) => {
  const pipeline = createDDPipeline(config);
  const initialContext: DDContext = {
    serverUrl: config.server.url,
    version: config.version,
  };

  return pipeline.run(
    initialContext,
    onProgress,
    { failFast: config.options?.failFast ?? true },
  );
};
