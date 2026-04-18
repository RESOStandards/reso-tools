import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepResult } from './types.js';
import {
  buildResourceUrl,
  fetchMetadata,
  getEntityType,
  loadMetadataFromFile,
  odataRequest,
  parseMetadataXml,
  resolveAuthToken,
} from '../test-runner/index.js';
import { runAllScenarios } from '../add-edit/index.js';
import type { AddEditConfig, PipelineStep, StepOutput } from './types.js';
import { createPipeline } from './pipeline.js';
import { addEditReportGenerators, writeReports, buildOutputPath, archiveCurrentResults } from './reports.js';
import { validateMetadata, formatValidationSummary, collectValidationErrors } from './metadata-validation.js';

// ── Pipeline Context ──

interface AddEditContext {
  readonly serverUrl: string;
  readonly resource: string;
  readonly authToken?: string;
  readonly metadataXml?: string;
  readonly entityType?: unknown;
  readonly sampleKeys?: ReadonlyArray<string>;
  readonly payloadsDir?: string;
  readonly testReport?: unknown;
  readonly complianceReport?: unknown;
  readonly [key: string]: unknown;
}

// ── Pipeline Steps ──

/** OData service check — fetches the service document to confirm the server is reachable and speaks OData. */
const serviceCheck: PipelineStep<AddEditContext> = {
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
          return { context: ctx, summary: `OData service is ready at ${url}` };
        }
      } catch { /* network error — retry */ }
      await new Promise(resolve => setTimeout(resolve, 2000));
      onProgress({ step: 'Service check', status: 'running', message: `Waiting for ${url} (attempt ${i + 1})...` });
    }
    return { context: ctx, status: 'failed', errors: [`OData service at ${url} did not respond after ${maxAttempts} attempts`] };
  },
};

/** Resolve the auth token from the config. */
const resolveAuth = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Resolve authentication',
  run: async (ctx) => {
    const authToken = await resolveAuthToken(config.server.auth);
    return { context: { ...ctx, authToken }, summary: `Auth credentials present` };
  },
});

/** Fetch and parse OData $metadata from the server or a local file. */
const fetchAndParseMetadata = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Fetch metadata',
  run: async (ctx, onProgress) => {
    const metadataUrl = config.metadataPath ?? `${ctx.serverUrl}/$metadata`;
    onProgress({ step: 'Fetch metadata', status: 'running', message: `Fetching $metadata... ${metadataUrl}` });
    const metadataXml = config.metadataPath
      ? await loadMetadataFromFile(config.metadataPath)
      : await fetchMetadata(ctx.serverUrl, ctx.authToken!);

    const metadata = parseMetadataXml(metadataXml);

    // XSD + semantic validation
    const validation = await validateMetadata(metadataXml);
    const validationErrors = collectValidationErrors(validation);

    const entityType = getEntityType(metadata, ctx.resource);

    if (!entityType) {
      return {
        context: { ...ctx, metadataXml },
        status: 'failed',
        errors: [
          ...validationErrors,
          `Entity type "${ctx.resource}" not found in metadata. Available: ${metadata.entityTypes.map(et => et.name).join(', ')}`,
        ],
      };
    }

    return {
      context: { ...ctx, metadataXml, entityType },
      summary: `Parsed metadata: ${metadata.entityTypes.length} entity types. ${formatValidationSummary(validation)}`,
      counts: { entityTypes: metadata.entityTypes.length, fields: entityType.properties.length },
      ...(validationErrors.length > 0 ? { errors: validationErrors } : {}),
      ...(!validation.xsdValid || !validation.semanticValid ? { status: 'failed' as const } : {}),
    };
  },
});

/** Sample real records from the server to extract keys for update/delete payloads. */
const sampleRecords = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Sample records',
  run: async (ctx) => {
    const url = buildResourceUrl(ctx.serverUrl, ctx.resource);
    const response = await odataRequest({
      method: 'GET',
      url: `${url}?$top=2&$orderby=ListingKey`,
      authToken: ctx.authToken!,
    });

    const body = response.body as { value?: ReadonlyArray<Record<string, unknown>> };
    const records = body?.value ?? [];

    if (records.length < 2) {
      return {
        context: ctx,
        status: 'failed',
        errors: [`Need at least 2 ${ctx.resource} records for sampling, found ${records.length}`],
      };
    }

    const keyField = 'ListingKey';
    const keys = records.map(r => String(r[keyField]));

    return {
      context: { ...ctx, sampleKeys: keys, sampleRecords: records },
      summary: `Sampled ${keys.length} ${ctx.resource} records`,
      params: { keys },
    };
  },
});

/** Generate payload files from inline config, sampled keys, or a provided directory. */
const generatePayloads = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Generate payloads',
  run: async (ctx) => {
    // Option 1: User provided a directory of payload files
    if (config.payloadsDir) {
      return {
        context: { ...ctx, payloadsDir: config.payloadsDir },
        summary: `Using existing payloads from ${config.payloadsDir}`,
      };
    }

    const outputDir = config.options?.outputDir
      ? join(config.options.outputDir, 'payloads')
      : join(process.cwd(), '.reso-cert', 'payloads');

    await mkdir(outputDir, { recursive: true });

    // Option 2: Inline payloads from config file
    if (config.payloads) {
      const inline = config.payloads;
      const keys = ctx.sampleKeys ?? [];
      const keyField = 'ListingKey';
      const hasCreate = !!inline.createSucceeds && Object.keys(inline.createSucceeds).length > 0;

      // Key chaining: if update/delete missing keys, they'll be resolved after create runs
      const needsKeyChaining =
        (inline.updateSucceeds && !(keyField in inline.updateSucceeds)) ||
        (inline.deleteSucceeds && !('id' in inline.deleteSucceeds));

      if (needsKeyChaining && !hasCreate && keys.length === 0) {
        return {
          context: ctx,
          status: 'failed',
          errors: ['Update/delete payloads missing keys and no Create payload to chain from. Provide keys or add Create payloads.'],
        };
      }

      // Use sampled keys if available, otherwise mark for runtime chaining
      const updateKey = keys[0] ?? null;
      const deleteKey = keys[1] ?? keys[0] ?? null;

      const payloads: Record<string, Record<string, unknown>> = {
        'create-succeeds.json': inline.createSucceeds ?? { ListPrice: 350000, BedroomsTotal: 4, City: 'Test City', StateOrProvince: 'CA', PostalCode: '90210', Country: 'US' },
        'create-fails.json': inline.createFails ?? { ListPrice: -99999, BedroomsTotal: 3 },
        'update-succeeds.json': { ...inline.updateSucceeds, ...(updateKey && !(keyField in (inline.updateSucceeds ?? {})) ? { [keyField]: updateKey } : {}) },
        'update-fails.json': { ...inline.updateFails, ...(updateKey && !(keyField in (inline.updateFails ?? {})) ? { [keyField]: updateKey } : {}) },
        'delete-succeeds.json': inline.deleteSucceeds && 'id' in inline.deleteSucceeds ? inline.deleteSucceeds : { id: deleteKey ?? '00000000-0000-0000-0000-000000000000' },
        'delete-fails.json': inline.deleteFails ?? { id: '00000000-0000-0000-0000-000000000000' },
      };

      const writes = Object.entries(payloads).map(([filename, data]) =>
        writeFile(join(outputDir, filename), JSON.stringify(data, null, 2))
      );
      await Promise.all(writes);

      const chainedMsg = needsKeyChaining && keys.length > 0 ? ' (keys resolved from sampled records)' : '';
      return {
        context: { ...ctx, payloadsDir: outputDir },
        summary: `Generated 6 payload files from config${chainedMsg}`,
        artifacts: [{ label: 'Payloads', path: outputDir }],
        counts: { payloads: 6 },
      };
    }

    // Option 3: Auto-generate from sampled records (default)
    const keys = ctx.sampleKeys!;
    const payloads: Record<string, Record<string, unknown>> = {
      'create-succeeds.json': { ListPrice: 350000.00, BedroomsTotal: 4, BathroomsTotalInteger: 3, City: 'Test City', StateOrProvince: 'CA', PostalCode: '90210', Country: 'US' },
      'create-fails.json': { ListPrice: -99999.00, BedroomsTotal: 3, BathroomsTotalInteger: 2 },
      'update-succeeds.json': { ListingKey: keys[0], ListPrice: 375000.00 },
      'update-fails.json': { ListingKey: keys[0], ListPrice: -1.00 },
      'delete-succeeds.json': { id: keys[1] },
      'delete-fails.json': { id: '00000000-0000-0000-0000-000000000000' },
    };

    const writes = Object.entries(payloads).map(([filename, data]) =>
      writeFile(join(outputDir, filename), JSON.stringify(data, null, 2))
    );
    await Promise.all(writes);

    return {
      context: { ...ctx, payloadsDir: outputDir },
      summary: `Generated 6 payload files`,
      artifacts: [{ label: 'Payloads', path: outputDir }],
      counts: { payloads: 6 },
    };
  },
});

/** Run all 8 Add/Edit certification scenarios. */
const runTests = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Run Add/Edit scenarios',
  run: async (ctx, onProgress) => {
    const testReport = await runAllScenarios({
      serverUrl: ctx.serverUrl,
      resource: ctx.resource,
      payloadsDir: ctx.payloadsDir!,
      auth: config.server.auth,
      metadataPath: config.metadataPath,
    });

    const { passed, failed } = testReport.summary;
    const status = failed > 0 ? 'failed' as const : 'passed' as const;

    return {
      context: { ...ctx, testReport },
      status,
      summary: `${passed} passed, ${failed} failed (${testReport.scenarios.length} scenarios)`,
      counts: { total: testReport.scenarios.length, passed, failed },
    };
  },
});

/** Write generic and detailed compliance reports. */
const writeComplianceReports = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Write compliance reports',
  run: async (ctx, onProgress) => {
    const outputDir = buildOutputPath('web-api-add-edit', config.specVersion ?? '2.0.0', config);
    await archiveCurrentResults(outputDir);
    const generators = addEditReportGenerators(config.specVersion ?? '2.0.0');

    // Adapt testReport into resourceReports shape for the detailed report serializer
    const testReport = ctx.testReport as { scenarios: ReadonlyArray<unknown>; summary: { total: number; passed: number; failed: number; skipped?: number } };
    const contextWithReports = {
      ...ctx,
      resourceReports: [{
        resource: ctx.resource,
        summary: testReport.summary,
        scenarios: testReport.scenarios,
      }],
    };

    const pipelineResult = {
      status: testReport.summary.failed > 0 ? 'failed' as const : 'passed' as const,
      endorsement: 'add-edit',
      steps: ctx.pipelineSteps as ReadonlyArray<import('./types.js').StepResult> ?? [],
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

/** Check if inline payloads need keys resolved from the server. */
const inlinePayloadsNeedSampling = (payloads?: import('./types.js').InlinePayloads): boolean => {
  if (!payloads) return false;
  const keyField = 'ListingKey';
  const updateMissing = payloads.updateSucceeds && !(keyField in payloads.updateSucceeds);
  const deleteMissing = payloads.deleteSucceeds && !('id' in payloads.deleteSucceeds);
  const deleteEmpty = payloads.deleteSucceeds && Object.keys(payloads.deleteSucceeds).length === 0;
  return !!(updateMissing || deleteMissing || deleteEmpty);
};

/** Create the Add/Edit compliance test pipeline. */
export const createAddEditPipeline = (config: AddEditConfig) => {
  const needsSampling = !config.payloadsDir && (!config.payloads || inlinePayloadsNeedSampling(config.payloads));
  return createPipeline<AddEditContext>('add-edit', [
    resolveAuth(config),
    ...(config.options?.skipHealthCheck ? [] : [serviceCheck]),
    fetchAndParseMetadata(config),
    ...(needsSampling ? [sampleRecords(config)] : []),
    generatePayloads(config),
    runTests(config),
    writeComplianceReports(config),
  ]);
};

/** Run Add/Edit compliance tests with a single function call. */
export const runAddEditCompliance = async (
  config: AddEditConfig,
  onProgress?: (progress: import('./types.js').StepProgress) => void,
) => {
  const pipeline = createAddEditPipeline(config);
  const initialContext: AddEditContext = {
    serverUrl: config.server.url,
    resource: config.resource,
  };

  return pipeline.run(
    initialContext,
    onProgress,
    { failFast: config.options?.failFast ?? false },
  );
};

/** Run Add/Edit compliance from a config file. Runs each config entry sequentially. */
export const runAddEditFromConfigFile = async (
  configPath: string,
  onProgress?: (progress: import('./types.js').StepProgress) => void,
) => {
  const { loadConfigFile, configEntryToAddEdit } = await import('./config.js');
  const configFile = await loadConfigFile(configPath);

  const results: Array<import('./types.js').PipelineResult> = [];

  for (const entry of configFile.configs) {
    const config = configEntryToAddEdit(entry, configFile.providerUoi);

    // If config entry has inline payloads, pass them through
    if (entry.payloads) {
      (config as unknown as Record<string, unknown>).payloads = entry.payloads;
    }

    const result = await runAddEditCompliance(config, onProgress);
    results.push(result);
  }

  return results;
};
