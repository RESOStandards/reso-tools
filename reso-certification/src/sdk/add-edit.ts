import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { generateComplianceReport } from '../add-edit/compliance-report.js';
import type { AddEditConfig, PipelineStep, StepOutput } from './types.js';
import { createPipeline } from './pipeline.js';

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

/** Wait for the server to respond to a health check. */
const healthCheck: PipelineStep<AddEditContext> = {
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
const resolveAuth = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Resolve authentication',
  run: async (ctx) => {
    const authToken = await resolveAuthToken(config.server.auth);
    return { context: { ...ctx, authToken }, summary: `Authenticated via ${config.server.auth.mode}` };
  },
});

/** Fetch and parse OData $metadata from the server or a local file. */
const fetchAndParseMetadata = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Fetch metadata',
  run: async (ctx) => {
    const metadataXml = config.metadataPath
      ? await loadMetadataFromFile(config.metadataPath)
      : await fetchMetadata(ctx.serverUrl, ctx.authToken!);

    const metadata = parseMetadataXml(metadataXml);
    const entityType = getEntityType(metadata, ctx.resource);

    if (!entityType) {
      return {
        context: { ...ctx, metadataXml },
        status: 'failed',
        errors: [`Entity type "${ctx.resource}" not found in metadata. Available: ${metadata.entityTypes.map(et => et.name).join(', ')}`],
      };
    }

    return {
      context: { ...ctx, metadataXml, entityType },
      summary: `Parsed metadata: ${metadata.entityTypes.length} entity types`,
      counts: { entityTypes: metadata.entityTypes.length, fields: entityType.properties.length },
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

/** Generate payload files for all 6 Add/Edit scenarios. */
const generatePayloads = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Generate payloads',
  run: async (ctx) => {
    // If user provided payloads dir, use those instead
    if (config.payloadsDir) {
      return {
        context: { ...ctx, payloadsDir: config.payloadsDir },
        summary: `Using existing payloads from ${config.payloadsDir}`,
      };
    }

    const keys = ctx.sampleKeys!;
    const outputDir = config.options?.outputDir
      ? join(config.options.outputDir, 'payloads')
      : join(process.cwd(), '.reso-cert', 'payloads');

    await mkdir(outputDir, { recursive: true });

    const payloads = {
      'create-succeeds.json': {
        ListPrice: 350000.00,
        BedroomsTotal: 4,
        BathroomsTotalInteger: 3,
        City: 'Test City',
        StateOrProvince: 'CA',
        PostalCode: '90210',
        Country: 'US',
      },
      'create-fails.json': {
        ListPrice: -99999.00,
        BedroomsTotal: 3,
        BathroomsTotalInteger: 2,
      },
      'update-succeeds.json': {
        ListingKey: keys[0],
        ListPrice: 375000.00,
      },
      'update-fails.json': {
        ListingKey: keys[0],
        ListPrice: -1.00,
      },
      'delete-succeeds.json': {
        id: keys[1],
      },
      'delete-fails.json': {
        id: '00000000-0000-0000-0000-000000000000',
      },
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

/** Generate the compliance report JSON. */
const generateReport = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Generate compliance report',
  run: async (ctx) => {
    const report = generateComplianceReport(
      ctx.testReport as Parameters<typeof generateComplianceReport>[0],
      {
        version: config.specVersion ?? '2.0.0',
        payloads: {},
        entityType: ctx.entityType as Parameters<typeof generateComplianceReport>[1]['entityType'],
      },
    );

    const outputDir = config.options?.outputDir ?? join(process.cwd(), '.reso-cert');
    await mkdir(outputDir, { recursive: true });

    const reportPath = join(outputDir, 'add-edit-compliance-report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2));

    return {
      context: { ...ctx, complianceReport: report },
      summary: `Compliance report: ${report.outcome}`,
      artifacts: [{ label: 'Compliance Report', path: reportPath }],
    };
  },
});

// ── Pipeline Assembly ──

/** Create the Add/Edit compliance test pipeline. */
export const createAddEditPipeline = (config: AddEditConfig) =>
  createPipeline<AddEditContext>('add-edit', [
    healthCheck,
    resolveAuth(config),
    fetchAndParseMetadata(config),
    ...(config.payloadsDir ? [] : [sampleRecords(config)]),
    generatePayloads(config),
    runTests(config),
    generateReport(config),
  ]);

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
    { failFast: config.options?.failFast ?? true },
  );
};
