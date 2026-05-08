import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAuthToken } from '../test-runner/auth.js';
import { fetchMetadata, loadMetadataFromFile, parseMetadataXml } from '../test-runner/metadata.js';
import { runAllEntityEventScenarios } from '../entity-event/test-runner.js';
import type { EntityEventConfig as EERunnerConfig } from '../entity-event/types.js';
import type { EntityEventConfig, PipelineStep } from './types.js';
import { createPipeline } from './pipeline.js';
import { entityEventReportGenerators, writeReports, buildOutputPath, archiveCurrentResults } from './reports.js';
import { validateMetadata, formatValidationSummary, collectValidationErrors } from './metadata-validation.js';
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

/** OData service check — fetches the service document to confirm the server is reachable and speaks OData. */
const serviceCheck: PipelineStep<EntityEventContext> = {
  name: 'Service check',
  run: async (ctx, onProgress) => {
    const url = ctx.serverUrl;
    // Identifying User-Agent + explicit Accept so servers behind WAFs
    // do not reject based on undici's default User-Agent of 'node'.
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
  run: async (ctx, onProgress) => {
    onProgress({ step: 'Fetch metadata', status: 'running', message: 'Fetching $metadata...' });
    const metadataXml = config.payloadsDir
      ? await loadMetadataFromFile(config.payloadsDir)
      : await fetchMetadata(ctx.serverUrl, ctx.authToken!);

    const metadata = parseMetadataXml(metadataXml);

    // XSD + semantic validation
    const validation = await validateMetadata(metadataXml);
    const validationErrors = collectValidationErrors(validation);

    const entityEventType = metadata.entityTypes.find(et => et.name === 'EntityEvent');
    const eeMsg = entityEventType
      ? `EntityEvent found with ${entityEventType.properties.length} fields`
      : 'EntityEvent not found (will be caught by test scenarios)';

    return {
      context: { ...ctx, metadataXml },
      summary: `Metadata parsed: ${eeMsg}. ${formatValidationSummary(validation)}`,
      counts: { entityTypes: metadata.entityTypes.length },
      ...(validationErrors.length > 0 ? { errors: validationErrors } : {}),
      ...(!validation.xsdValid || !validation.semanticValid ? { status: 'failed' as const } : {}),
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
  name: 'Write reports',
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
    };
  },
});

// ── Pipeline Assembly ──

/** Create the EntityEvent compliance test pipeline. */
export const createEntityEventPipeline = (config: EntityEventConfig) =>
  createPipeline<EntityEventContext>('entity-event', [
    resolveAuth(config),
    ...(config.options?.skipHealthCheck ? [] : [serviceCheck]),
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
