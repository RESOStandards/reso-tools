/**
 * Web API Core SDK pipeline.
 *
 * Runs all Core compliance scenarios per resource using the same
 * pipeline pattern as Add/Edit and EntityEvent.
 */

import { resolveAuthToken } from '../test-runner/auth.js';
import { fetchMetadata, loadMetadataFromFile, parseMetadataXml, getEntityType } from '../test-runner/metadata.js';
import { validateMetadata, formatValidationSummary, collectValidationErrors } from './metadata-validation.js';
import { resolveTestParams, WELL_KNOWN_RESOURCES } from '../web-api-core/index.js';
import { runCoreResourceScenarios, type ResourceTestReport } from '../web-api-core/test-runner.js';
import type { CoreConfig, PipelineStep, StepResult } from './types.js';
import { createPipeline } from './pipeline.js';
import { coreReportGenerators, writeReports, buildOutputPath, archiveCurrentResults } from './reports.js';

// ── Pipeline Context ──

interface CoreContext {
  readonly serverUrl: string;
  readonly version: '2.0.0' | '2.1.0';
  readonly enumMode: 'auto' | 'isflags' | 'collections' | 'string';
  readonly resources: ReadonlyArray<string>;
  readonly authToken?: string;
  readonly metadataXml?: string;
  readonly resourceReports?: ReadonlyArray<ResourceTestReport>;
  readonly [key: string]: unknown;
}

// ── Pipeline Steps ──

/** OData service check — fetches the service document to confirm the server is reachable and speaks OData. */
const serviceCheck: PipelineStep<CoreContext> = {
  name: 'Service check',
  run: async (ctx, onProgress) => {
    const url = ctx.serverUrl;
    const headers: Record<string, string> = ctx.authToken
      ? { Authorization: `Bearer ${ctx.authToken}` }
      : {};
    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(url, { headers });
        if (response.ok) {
          return { context: ctx, summary: 'OData service is ready', requestDetails: [{ method: 'GET', url }] };
        }
      } catch { /* network error — retry */ }
      await new Promise(resolve => setTimeout(resolve, 2000));
      onProgress({ step: 'Service check', status: 'running', message: `Waiting for server (attempt ${i + 1})...` });
    }
    return { context: ctx, status: 'failed', errors: ['OData service did not respond'], requestDetails: [{ method: 'GET', url, error: `No response after ${maxAttempts} attempts` }] };
  },
};

const resolveAuth = (config: CoreConfig): PipelineStep<CoreContext> => ({
  name: 'Resolve authentication',
  run: async (ctx) => {
    const authToken = await resolveAuthToken(config.server.auth);
    return { context: { ...ctx, authToken }, summary: `Auth credentials present` };
  },
});

const fetchAndParseMetadata = (config: CoreConfig): PipelineStep<CoreContext> => ({
  name: 'Fetch metadata',
  run: async (ctx, onProgress) => {
    onProgress({ step: 'Fetch metadata', status: 'running', message: 'Fetching $metadata...' });
    const metadataXml = config.metadataPath
      ? await loadMetadataFromFile(config.metadataPath)
      : await fetchMetadata(ctx.serverUrl, ctx.authToken!);

    const metadata = parseMetadataXml(metadataXml);

    // XSD + semantic validation
    const validation = await validateMetadata(metadataXml);
    const validationErrors = collectValidationErrors(validation);

    // Check which requested resources exist in metadata
    const availableResources = ctx.resources.filter(r => getEntityType(metadata, r));
    const missingResources = ctx.resources.filter(r => !getEntityType(metadata, r));

    const allErrors = [
      ...validationErrors,
      ...(missingResources.length > 0 ? [`Resources not found in metadata: ${missingResources.join(', ')}`] : []),
    ];

    return {
      context: { ...ctx, metadataXml, resources: availableResources, metadata },
      summary: `Parsed metadata: ${metadata.entityTypes.length} entity types, ${availableResources.length}/${ctx.resources.length} resources available. ${formatValidationSummary(validation)}`,
      counts: { entityTypes: metadata.entityTypes.length, resources: availableResources.length },
      ...(allErrors.length > 0 ? { errors: allErrors } : {}),
      ...(!validation.xsdValid || !validation.semanticValid ? { status: 'failed' as const } : {}),
    };
  },
});

const sampleAndTest = (config: CoreConfig): PipelineStep<CoreContext> => ({
  name: 'Run Core scenarios',
  run: async (ctx, onProgress) => {
    const metadata = parseMetadataXml(ctx.metadataXml!);
    const version = ctx.version;
    const resourceReports: ResourceTestReport[] = [];

    for (const resource of ctx.resources) {
      const entityType = getEntityType(metadata, resource)!;

      onProgress({
        step: 'Run Core scenarios',
        status: 'running',
        message: `Sampling ${resource}...`,
      });

      const enumModeOverride = ctx.enumMode !== 'auto' ? ctx.enumMode as import('../web-api-core/sampling.js').EnumMode : undefined;
      const params = await resolveTestParams(
        ctx.serverUrl,
        resource,
        entityType,
        ctx.authToken!,
        enumModeOverride,
      );

      if (params.skippedTypes.length > 0) {
        onProgress({
          step: 'Run Core scenarios',
          status: 'running',
          message: `${resource}: missing types: ${params.skippedTypes.join(', ')} — some scenarios will be skipped`,
        });
      }

      onProgress({
        step: 'Run Core scenarios',
        status: 'running',
        message: `Testing ${resource}...`,
      });

      const report = await runCoreResourceScenarios(
        ctx.serverUrl,
        resource,
        params,
        ctx.authToken!,
        version,
      );

      resourceReports.push(report);

      onProgress({
        step: 'Run Core scenarios',
        status: 'running',
        message: `${resource}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`,
      });
    }

    const totalPassed = resourceReports.reduce((sum, r) => sum + r.summary.passed, 0);
    const totalFailed = resourceReports.reduce((sum, r) => sum + r.summary.failed, 0);
    const totalSkipped = resourceReports.reduce((sum, r) => sum + r.summary.skipped, 0);
    const totalScenarios = resourceReports.reduce((sum, r) => sum + r.summary.total, 0);

    // Compute union coverage across all resources
    const allTypes = ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'];
    const coveredTypes = allTypes.filter(type =>
      resourceReports.some(r => r.coverage.some(c => c.type === type && c.hasData))
    );
    const missingTypes = allTypes.filter(t => !coveredTypes.includes(t));
    const fullCoverage = missingTypes.length === 0;

    // In --full-coverage mode, fail if any types are missing
    const requireFullCoverage = config.fullCoverage ?? false;
    const coverageFailed = requireFullCoverage && !fullCoverage;
    const status = (totalFailed > 0 || coverageFailed) ? 'failed' as const : 'passed' as const;

    const coverageMsg = fullCoverage
      ? 'Full type coverage achieved'
      : `Missing coverage: ${missingTypes.join(', ')}`;
    const modeMsg = requireFullCoverage ? ' (--full-coverage enabled)' : '';

    return {
      context: { ...ctx, resourceReports, coverageMatrix: { coveredTypes, missingTypes, fullCoverage } },
      status,
      summary: `${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped (${totalScenarios} scenarios across ${resourceReports.length} resources). ${coverageMsg}${modeMsg}`,
      counts: { total: totalScenarios, passed: totalPassed, failed: totalFailed, skipped: totalSkipped, resources: resourceReports.length },
      ...(coverageFailed ? { errors: [`Full coverage required but missing types: ${missingTypes.join(', ')}`] } : {}),
    };
  },
});

const writeComplianceReports = (config: CoreConfig): PipelineStep<CoreContext> => ({
  name: 'Write reports',
  run: async (ctx, onProgress) => {
    const outputDir = buildOutputPath('web-api-core', config.version ?? '2.0.0', config);
    await archiveCurrentResults(outputDir);
    const generators = coreReportGenerators(config.version ?? '2.0.0');

    const resourceReports = ctx.resourceReports as ReadonlyArray<ResourceTestReport> ?? [];
    const totalFailed = resourceReports.reduce((sum, r) => sum + r.summary.failed, 0);

    const pipelineResult = {
      status: totalFailed > 0 ? 'failed' as const : 'passed' as const,
      endorsement: 'core',
      steps: ctx.pipelineSteps as ReadonlyArray<StepResult> ?? [],
      context: ctx,
      duration: 0,
    };

    const written = await writeReports(pipelineResult, generators, outputDir, onProgress);

    return {
      context: { ...ctx, reports: written },
      summary: `${written.length} reports written`,
      artifacts: written.map(r => ({ label: r.name, path: r.path })),
    };
  },
});

// ── Pipeline Assembly ──

/** Create the Web API Core compliance test pipeline. */
export const createCorePipeline = (config: CoreConfig) => {
  return createPipeline<CoreContext>('core', [
    resolveAuth(config),
    ...(config.options?.skipHealthCheck ? [] : [serviceCheck]),
    fetchAndParseMetadata(config),
    sampleAndTest(config),
    writeComplianceReports(config),
  ]);
};

/** Run Web API Core compliance tests with a single function call. */
export const runCoreCompliance = async (
  config: CoreConfig,
  onProgress?: (progress: import('./types.js').StepProgress) => void,
) => {
  const pipeline = createCorePipeline(config);
  const resources = config.resources ?? WELL_KNOWN_RESOURCES.map(r => r.resource);
  const initialContext: CoreContext = {
    serverUrl: config.server.url,
    version: config.version ?? '2.0.0',
    enumMode: config.enumMode ?? 'auto',
    resources,
  };

  return pipeline.run(
    initialContext,
    onProgress,
    { failFast: config.options?.failFast ?? false },
  );
};
