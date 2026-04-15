import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAuthToken } from '../test-runner/auth.js';
import { fetchMetadata, loadMetadataFromFile, parseMetadataXml } from '../test-runner/metadata.js';
import { runAllEntityEventScenarios } from '../entity-event/test-runner.js';
import type { EntityEventConfig as EERunnerConfig } from '../entity-event/types.js';
import type { EntityEventConfig, PipelineStep, StepOutput } from './types.js';
import { createPipeline } from './pipeline.js';
import { entityEventReportGenerators, writeReports, buildOutputPath, archiveCurrentResults } from './reports.js';
import type { StepResult } from './types.js';

// ── Pipeline Context ──

interface EntityEventContext {
  readonly serverUrl: string;
  readonly mode: 'observe' | 'full';
  readonly writableResource: string;
  readonly authToken?: string;
  readonly metadataXml?: string;
  readonly payloadsDir?: string;
  readonly testReport?: unknown;
  readonly [key: string]: unknown;
}

// ── Pipeline Steps ──

/** Wait for the server to respond to a health check. */
const healthCheck: PipelineStep<EntityEventContext> = {
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

/** Resolve the auth token from the config. */
const resolveAuth = (config: EntityEventConfig): PipelineStep<EntityEventContext> => ({
  name: 'Resolve authentication',
  run: async (ctx) => {
    const authToken = await resolveAuthToken(config.server.auth);
    return { context: { ...ctx, authToken }, summary: `Auth credentials present` };
  },
});

/** Fetch and parse OData $metadata to verify EntityEvent exists. */
const fetchAndParseMetadata = (config: EntityEventConfig): PipelineStep<EntityEventContext> => ({
  name: 'Fetch metadata',
  run: async (ctx) => {
    const metadataXml = config.payloadsDir
      ? await loadMetadataFromFile(config.payloadsDir)
      : await fetchMetadata(ctx.serverUrl, ctx.authToken!);

    const metadata = parseMetadataXml(metadataXml);
    const entityEventType = metadata.entityTypes.find(et => et.name === 'EntityEvent');

    return {
      context: { ...ctx, metadataXml },
      summary: entityEventType
        ? `Metadata parsed: EntityEvent found with ${entityEventType.properties.length} fields`
        : 'Metadata parsed: EntityEvent not found (will be caught by test scenarios)',
      counts: { entityTypes: metadata.entityTypes.length },
    };
  },
});

/** Generate payload files for full mode canary writes. */
const generatePayloads = (config: EntityEventConfig): PipelineStep<EntityEventContext> => ({
  name: 'Generate payloads',
  run: async (ctx) => {
    if (config.payloadsDir) {
      return {
        context: { ...ctx, payloadsDir: config.payloadsDir },
        summary: `Using existing payloads from ${config.payloadsDir}`,
      };
    }

    if (ctx.mode !== 'full') {
      return { context: ctx, status: 'skipped', summary: 'Observe mode — no payloads needed' };
    }

    const outputDir = config.options?.outputDir
      ? join(config.options.outputDir, 'entity-event-payloads')
      : join(process.cwd(), '.reso-cert', 'entity-event-payloads');

    await mkdir(outputDir, { recursive: true });

    const payload = {
      ListPrice: 275000.00,
      BedroomsTotal: 3,
      BathroomsTotalInteger: 2,
      City: 'EntityEvent Test City',
      StateOrProvince: 'TX',
      PostalCode: '78701',
      Country: 'US',
    };

    await writeFile(join(outputDir, 'create-succeeds.json'), JSON.stringify(payload, null, 2));

    return {
      context: { ...ctx, payloadsDir: outputDir },
      summary: 'Generated canary write payload',
      artifacts: [{ label: 'Payloads', path: outputDir }],
    };
  },
});

/** Run all EntityEvent compliance scenarios. */
const runTests = (config: EntityEventConfig): PipelineStep<EntityEventContext> => ({
  name: 'Run EntityEvent scenarios',
  run: async (ctx, onProgress) => {
    const runnerConfig: EERunnerConfig = {
      serverUrl: ctx.serverUrl,
      auth: config.server.auth,
      mode: ctx.mode,
      writableResource: ctx.writableResource,
      payloadsDir: ctx.payloadsDir,
      maxEvents: config.maxEvents ?? 1000,
      batchSize: config.batchSize ?? 100,
      pollIntervalMs: config.pollInterval ?? 5000,
      pollTimeoutMs: config.pollTimeout ?? 30000,
      strict: false,
    };

    const testReport = await runAllEntityEventScenarios(runnerConfig, (message) => {
      onProgress({ step: 'Run EntityEvent scenarios', status: 'running', message });
    });
    const { passed, failed } = testReport.summary;
    const status = failed > 0 ? 'failed' as const : 'passed' as const;

    return {
      context: { ...ctx, testReport },
      status,
      summary: `${passed} passed, ${failed} failed (${testReport.scenarios.length} scenarios, ${testReport.mode} mode). ${testReport.dataValidation.eventsValidated} events validated`,
      counts: {
        total: testReport.scenarios.length,
        passed,
        failed,
        eventsValidated: testReport.dataValidation.eventsValidated,
      },
    };
  },
});

/** Write generic and detailed compliance reports. */
const writeComplianceReports = (config: EntityEventConfig): PipelineStep<EntityEventContext> => ({
  name: 'Write compliance reports',
  run: async (ctx, onProgress) => {
    const outputDir = buildOutputPath('entity-event', '1.0.0', config);
    await archiveCurrentResults(outputDir);
    const generators = entityEventReportGenerators('1.0.0');

    const testReport = ctx.testReport as { scenarios: ReadonlyArray<unknown>; summary: { total: number; passed: number; failed: number; skipped?: number } };
    const contextWithReports = {
      ...ctx,
      resourceReports: [{
        resource: 'EntityEvent',
        summary: testReport.summary,
        scenarios: testReport.scenarios,
      }],
    };

    const pipelineResult = {
      status: testReport.summary.failed > 0 ? 'failed' as const : 'passed' as const,
      endorsement: 'entity-event',
      steps: ctx.pipelineSteps as ReadonlyArray<StepResult> ?? [],
      context: contextWithReports,
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

/** Create the EntityEvent compliance test pipeline. */
export const createEntityEventPipeline = (config: EntityEventConfig) =>
  createPipeline<EntityEventContext>('entity-event', [
    ...(config.options?.skipHealthCheck ? [] : [healthCheck]),
    resolveAuth(config),
    fetchAndParseMetadata(config),
    ...(config.mode === 'full' ? [generatePayloads(config)] : []),
    runTests(config),
    writeComplianceReports(config),
  ]);

/** Run EntityEvent compliance tests with a single function call. */
export const runEntityEventCompliance = async (
  config: EntityEventConfig,
  onProgress?: (progress: import('./types.js').StepProgress) => void,
) => {
  const pipeline = createEntityEventPipeline(config);
  const initialContext: EntityEventContext = {
    serverUrl: config.server.url,
    mode: config.mode ?? 'observe',
    writableResource: config.writableResource ?? 'Property',
  };

  return pipeline.run(
    initialContext,
    onProgress,
    { failFast: config.options?.failFast ?? false },
  );
};
