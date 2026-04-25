import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { BaseComplianceConfig, PipelineResult, PipelineContext, ProgressCallback } from './types.js';

// ── Output Path Builder ──

const DEFAULT_RESULTS_PATH = '.reso-cert';

/**
 * Build the standard nested output path for any endorsement.
 * Structure: {base}/{endorsement-version}/{providerUoi}-{providerUsi}/{recipientUoi}/current
 */
export const buildOutputPath = (
  endorsementSlug: string,
  version: string,
  config: BaseComplianceConfig,
): string => {
  const resultsPath = config.options?.outputDir ?? join(process.cwd(), DEFAULT_RESULTS_PATH);
  const providerUoi = config.providerUoi ?? `LOCAL-${Date.now()}`;
  const providerUsi = config.providerUsi ?? 'LOCAL-SYSTEM';
  const recipientUoi = config.recipientUoi ?? 'LOCAL-RECIPIENT';
  return join(resultsPath, `${endorsementSlug}-${version}`, `${providerUoi}-${providerUsi}`, recipientUoi, 'current');
};

/** Archive existing current results before a new run. */
export const archiveCurrentResults = async (currentPath: string): Promise<void> => {
  if (!existsSync(currentPath)) return;
  const archivedDir = join(dirname(currentPath), 'archived', new Date().toISOString().replace(/[:.]/g, ''));
  await mkdir(dirname(archivedDir), { recursive: true });
  await rename(currentPath, archivedDir);
};

// ── Report Types ──

/** Base fields shared by all report formats (required by the Cert API). */
export interface BaseReport {
  readonly description: string;
  readonly version: string;
  readonly generatedOn: string;
  readonly remarks: string;
}

/** A report generator produces a report object from pipeline results. */
export interface ReportGenerator<TContext extends PipelineContext = PipelineContext> {
  readonly name: string;
  readonly filename: string;
  readonly generate: (result: PipelineResult<TContext>) => Record<string, unknown>;
}

// ── Remarks Serializers ──

/** Serialize Add/Edit pipeline results into a human-readable remarks string. */
export const serializeAddEditRemarks = (result: PipelineResult): string => {
  const testStep = result.steps.find(s => s.name === 'Run Add/Edit scenarios');
  if (!testStep?.counts) return `Add/Edit compliance test ${result.status}.`;

  const { total = 0, passed = 0, failed = 0 } = testStep.counts;

  const metadataStep = result.steps.find(s => s.name === 'Fetch metadata');
  const fieldCount = metadataStep?.counts?.fields ?? 0;
  const resource = (result.context as Record<string, unknown>).resource ?? 'Property';

  const parts = [`${passed} of ${total} scenarios ${result.status}`];
  if (fieldCount > 0) parts.push(`${fieldCount} fields validated against ${resource} metadata`);
  if (failed > 0) {
    const errors = testStep.errors ?? [];
    if (errors.length > 0) parts.push(`Failures: ${errors.join(', ')}`);
  }

  return `${parts.join('. ')}.`;
};

/** Serialize EntityEvent pipeline results into a human-readable remarks string. */
export const serializeEntityEventRemarks = (result: PipelineResult): string => {
  const testStep = result.steps.find(s => s.name === 'Run EntityEvent scenarios');
  if (!testStep?.counts) return `EntityEvent compliance test ${result.status}.`;

  const { total = 0, passed = 0 } = testStep.counts;
  const mode = (result.context as Record<string, unknown>).mode ?? 'observe';

  return `${passed} of ${total} scenarios ${result.status} in ${mode} mode.`;
};

/** Serialize Web API Core pipeline results into a human-readable remarks string. */
export const serializeCoreRemarks = (result: PipelineResult): string => {
  const testStep = result.steps.find(s => s.counts);
  if (!testStep?.counts) return `Web API Core compliance test ${result.status}.`;

  const { total = 0, passed = 0, failed = 0, skipped = 0 } = testStep.counts;
  return `${passed} passed, ${failed} failed, ${skipped} skipped out of ${total} tests.`;
};

// ── Generic Report Generator ──

/** Create a generic report generator for any endorsement (Cert API compatible). */
export const createGenericReportGenerator = (
  description: string,
  version: string,
  serializeRemarks: (result: PipelineResult) => string,
): ReportGenerator => ({
  name: 'Generic',
  filename: 'report.json',
  generate: (result) => ({
    description,
    version,
    generatedOn: new Date().toISOString(),
    remarks: serializeRemarks(result),
  }),
});

// ── Detailed Report Generator ──

/** Create a detailed report generator that extends the generic format with step results. */
export const createDetailedReportGenerator = (
  description: string,
  version: string,
  serializeRemarks: (result: PipelineResult) => string,
): ReportGenerator => ({
  name: 'Detailed',
  filename: 'report-detailed.json',
  generate: (result) => {
    // Extract resource-level test reports if available (Core, Add/Edit, EntityEvent)
    const ctx = result.context as Record<string, unknown>;
    const resourceReports = ctx.resourceReports as ReadonlyArray<Record<string, unknown>> | undefined;

    return {
      description,
      version,
      generatedOn: new Date().toISOString(),
      remarks: serializeRemarks(result),
      outcome: result.status,
      endorsement: result.endorsement,
      duration: result.duration,
      steps: result.steps.map(({ name, status, duration, summary, params, counts, artifacts, errors }) => ({
        name,
        status,
        duration,
        ...(summary ? { summary } : {}),
        ...(params ? { params } : {}),
        ...(counts ? { counts } : {}),
        ...(artifacts ? { artifacts } : {}),
        ...(errors && errors.length > 0 ? { errors } : {}),
      })),
      // Include per-resource scenario results for test-running endorsements
      ...(resourceReports ? {
        resourceReports: resourceReports.map((r: Record<string, unknown>) => ({
          resource: r.resource,
          summary: r.summary,
          scenarios: (r.scenarios as ReadonlyArray<Record<string, unknown>> ?? []).map(s => ({
            name: s.name ?? s.scenario,
            tag: s.tag,
            passed: s.passed,
            skipped: s.skipped ?? false,
            duration: s.duration,
            requestUrl: s.requestUrl,
            assertions: (s.assertions as ReadonlyArray<Record<string, unknown>> ?? []).map(a => ({
              description: a.description ?? a.message,
              passed: a.passed ?? (a.status === 'pass'),
              ...(a.expected !== undefined ? { expected: a.expected } : {}),
              ...(a.actual !== undefined ? { actual: a.actual } : {}),
              ...(a.status ? { status: a.status } : {}),
            })),
          })),
        })),
      } : {}),
    };
  },
});

// ── Report Writer ──

/** Write all reports from the given generators to the output directory. */
export const writeReports = async (
  result: PipelineResult,
  generators: ReadonlyArray<ReportGenerator>,
  outputDir: string,
  _onProgress?: ProgressCallback,
): Promise<ReadonlyArray<{ readonly name: string; readonly path: string }>> => {
  await mkdir(outputDir, { recursive: true });

  const written: Array<{ name: string; path: string }> = [];

  for (const generator of generators) {
    const report = generator.generate(result);
    const reportPath = join(outputDir, generator.filename);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    written.push({ name: generator.name, path: reportPath });
  }

  return written;
};

// ── Pre-built Report Generator Sets ──

/** Report generators for Add/Edit endorsement. */
export const addEditReportGenerators = (version: string): ReadonlyArray<ReportGenerator> => [
  createGenericReportGenerator('Web API Add/Edit', version, serializeAddEditRemarks),
  createDetailedReportGenerator('Web API Add/Edit', version, serializeAddEditRemarks),
];

/** Report generators for EntityEvent endorsement. */
export const entityEventReportGenerators = (version: string): ReadonlyArray<ReportGenerator> => [
  createGenericReportGenerator('EntityEvent (RCP-027)', version, serializeEntityEventRemarks),
  createDetailedReportGenerator('EntityEvent (RCP-027)', version, serializeEntityEventRemarks),
];

/** Report generators for Web API Core endorsement. */
export const coreReportGenerators = (version: string): ReadonlyArray<ReportGenerator> => [
  createGenericReportGenerator('Web API Server Core', version, serializeCoreRemarks),
  createDetailedReportGenerator('Web API Server Core', version, serializeCoreRemarks),
];
