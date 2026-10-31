import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
// The RCF run lives beside the `rcf` command, and the schema validator it uses beside `schema`. Moving both
// out of src/cli is a follow-up. This pipeline calls the same code the command does, so the two cannot drift.
import {
  type RcfReportIdentity,
  type RcfResult,
  SUBMITTABLE_REPORT_FILENAME,
  readRcfReportIdentity,
  resolveRcfExitCode,
  runRcf,
  submittableVariationsReport
} from '../cli/rcf-command.js';
import { type RcfInputFingerprint, fingerprintRcfInput } from '../rcf/fingerprint.js';
import { VARIATIONS_REPORT_FILENAME } from '../variations/constants.js';
import { CERTIFIABLE, allOf, everyStepPassed, notCertifiable } from './certification.js';
import { createPipeline } from './pipeline.js';
import { createDetailedReportGenerator, createGenericReportGenerator, writeReports } from './reports.js';
import { INFER_RCF_REPORTS, READ_RCF_INPUT, WRITE_REPORTS } from './step-names.js';
import type { PipelineResult, PipelineStep, ProgressCallback, RcfConfig, StepResult, ValidForCertification } from './types.js';

/** What the Cert API calls RESO Common Format. */
export const RCF_DESCRIPTION = 'RESO Common Format';

interface RcfContext {
  /** The directory the reports are written to. */
  readonly outputPath: string;
  readonly generatedOn: string;
  readonly identity?: RcfReportIdentity;
  readonly fingerprint?: RcfInputFingerprint;
  readonly rcfResult?: RcfResult;
  /** Why no report was inferred, when the run threw. A schema failure is told apart, as the command's exit code does. */
  readonly rcfError?: { readonly message: string; readonly schemaFailure: boolean };
  readonly [key: string]: unknown;
}

/**
 * Whether an RCF run can certify: every step passed, and it checked what certification needs. A run that did not
 * schema-validate checked no record against the Data Dictionary, and one that skipped variations checked no name,
 * so neither certifies whatever else it found.
 */
export const rcfValidForCertification =
  (config: RcfConfig): ValidForCertification =>
  steps =>
    allOf(
      everyStepPassed(steps),
      config.schemaValidate
        ? CERTIFIABLE
        : notCertifiable(['Schema validation did not run, so no record was checked against the Data Dictionary']),
      config.runVariations === false
        ? notCertifiable(['Variations did not run, so no name was checked against the Data Dictionary'])
        : CERTIFIABLE
    );

/** Why an inferred run is not a clean pass, in the order the command's exit code weighs them. */
const failureReasons = (result: RcfResult): ReadonlyArray<string> => {
  const s = result.stats;
  return [
    ...(s.totalRecords === 0 ? ['No certifiable records were read'] : []),
    ...(s.schemaErrors > 0 ? [`${s.schemaErrors} schema error(s)`] : []),
    ...(s.invalidContextFiles > 0
      ? [`${s.invalidContextFiles} file(s) carry an unreadable @reso.context (${s.invalidContextRecords} record(s) not certified)`]
      : []),
    ...(result.variationsError ? [`Variations did not complete: ${result.variationsError}`] : [])
  ];
};

const readInput = (config: RcfConfig): PipelineStep<RcfContext> => ({
  name: READ_RCF_INPUT,
  run: async context => {
    const identity = readRcfReportIdentity({
      providerUoi: config.providerUoi,
      providerUsi: config.providerUsi,
      recipientUoi: config.recipientUoi
    });
    if (!identity.ok) return { context, status: 'failed', summary: identity.error, errors: [identity.error] };
    // Caught rather than thrown, so the reason a run cannot certify names what was wrong with the input.
    const fingerprint = await fingerprintRcfInput(config.input).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error))
    );
    if (fingerprint instanceof Error) return { context, status: 'failed', summary: fingerprint.message, errors: [fingerprint.message] };
    return {
      context: { ...context, fingerprint, ...(identity.identity ? { identity: identity.identity } : {}) },
      summary: `${fingerprint.files.length} file(s), ${fingerprint.bytes.toLocaleString()} bytes`,
      counts: { files: fingerprint.files.length, bytes: fingerprint.bytes },
      params: { fingerprint: fingerprint.sha256 }
    };
  }
});

const inferReports = (config: RcfConfig): PipelineStep<RcfContext> => ({
  name: INFER_RCF_REPORTS,
  run: async context => {
    const { servicesAuthToken: bearerToken } = config;
    try {
      const result = await runRcf({
        input: config.input,
        version: config.version,
        fuzziness: config.fuzziness,
        strict: config.strict,
        schemaValidate: config.schemaValidate,
        generatedOn: context.generatedOn,
        runVariations: config.runVariations !== false,
        ...(bearerToken ? { bearerToken } : {}),
        ...(config.validationConfig !== undefined ? { validationConfig: config.validationConfig } : {})
      });
      const s = result.stats;
      const reasons = failureReasons(result);
      const inferred = `Data Dictionary ${result.version}: ${s.totalRecords.toLocaleString()} records, ${s.resources} resources, ${s.fields.toLocaleString()} fields, ${s.lookups.toLocaleString()} lookups`;
      return {
        context: { ...context, rcfResult: result },
        status: resolveRcfExitCode(result) === 0 ? 'passed' : 'failed',
        // A failed step leads with why, which is what the certification reasons quote.
        summary: reasons.length > 0 ? `${reasons.join('. ')}. ${inferred}` : inferred,
        params: {
          version: result.version,
          schemaValidate: config.schemaValidate === true,
          variations: config.runVariations !== false
        },
        counts: {
          records: s.totalRecords,
          resources: s.resources,
          fields: s.fields,
          lookups: s.lookups,
          schemaErrors: s.schemaErrors,
          invalidContextFiles: s.invalidContextFiles,
          ...(s.variationsTotal !== undefined ? { variations: s.variationsTotal } : {})
        },
        ...(reasons.length > 0 ? { errors: reasons } : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const schemaFailure = (error as { schemaFailure?: boolean } | null)?.schemaFailure === true;
      return { context: { ...context, rcfError: { message, schemaFailure } }, status: 'failed', summary: message, errors: [message] };
    }
  }
});

/** The summary the Cert API takes, and the same words at the top of the detailed report. */
export const serializeRcfRemarks = (result: PipelineResult): string => {
  const context = result.context as RcfContext;
  const rcf = context.rcfResult;
  if (!rcf) {
    // A step that threw carries its message in `errors`, with no summary.
    const failed = result.steps.find(step => step.status === 'failed');
    const why = context.rcfError?.message ?? failed?.summary ?? failed?.errors?.[0];
    return why ? `No report was inferred. ${why}` : 'No report was inferred.';
  }
  const s = rcf.stats;
  const files = context.fingerprint ? ` in ${context.fingerprint.files.length.toLocaleString()} file(s)` : '';
  return [
    `${s.totalRecords.toLocaleString()} records${files}: ${s.resources} resources, ${s.fields.toLocaleString()} fields, ${s.lookups.toLocaleString()} lookups.`,
    rcf.schemaReport !== undefined ? `${s.schemaErrors} schema error(s).` : 'Schema validation did not run.',
    rcf.variationsError
      ? `Variations did not complete: ${rcf.variationsError}.`
      : s.variationsTotal !== undefined
        ? `${s.variationsTotal} variation(s).`
        : 'Variations did not run.'
  ].join(' ');
};

/** What a finished RCF run produced, for a caller that reports on it: the inferred result, or why there is none. */
export type RcfRunOutcome =
  | { readonly inferred: RcfResult }
  | { readonly inferred?: undefined; readonly error: string; readonly schemaFailure: boolean };

export const rcfRunOutcome = (result: PipelineResult): RcfRunOutcome => {
  const context = result.context as RcfContext;
  if (context.rcfResult) return { inferred: context.rcfResult };
  // A step that threw carries its message in `errors`, with no summary.
  const failed = result.steps.find(step => step.status === 'failed');
  return {
    error: context.rcfError?.message ?? failed?.summary ?? failed?.errors?.[0] ?? 'The run stopped before it inferred a report',
    schemaFailure: context.rcfError?.schemaFailure === true
  };
};

/** Where an RCF run's reports go: the directory given, as the command writes them, and no deeper. */
const rcfOutputPath = (config: RcfConfig): string => resolve(config.options?.outputDir ?? '.');

const writeRcfReports = (config: RcfConfig): PipelineStep<RcfContext> => ({
  name: WRITE_REPORTS,
  alwaysRun: true,
  run: async (context, onProgress) => {
    await mkdir(context.outputPath, { recursive: true });
    const rcf = context.rcfResult;
    const submittable = rcf ? submittableVariationsReport(rcf, context.identity, context.generatedOn) : undefined;
    const inferred: ReadonlyArray<readonly [string, unknown]> = rcf
      ? [
          ['metadata-report.json', rcf.metadataReport],
          ['data-availability-report.json', rcf.dataAvailabilityReport],
          ...(rcf.variations ? [[VARIATIONS_REPORT_FILENAME, rcf.variations] as const] : []),
          ...(submittable ? [[SUBMITTABLE_REPORT_FILENAME, submittable] as const] : [])
        ]
      : [];
    for (const [name, body] of inferred) {
      await writeFile(join(context.outputPath, name), JSON.stringify(body, null, 2));
    }

    // The same rule the pipeline applies to its returned result, over the same steps, so the written report and the
    // returned result cannot disagree.
    const steps = (context.pipelineSteps as ReadonlyArray<StepResult> | undefined) ?? [];
    const version = rcf?.version ?? config.version ?? 'unknown';
    const pipelineResult: PipelineResult = {
      status: steps.some(step => step.status === 'failed') ? 'failed' : 'passed',
      endorsement: 'rcf',
      steps,
      context,
      certification: rcfValidForCertification(config)(steps),
      duration: 0
    };
    const generators = [
      createGenericReportGenerator(RCF_DESCRIPTION, version, serializeRcfRemarks),
      createDetailedReportGenerator(RCF_DESCRIPTION, version, serializeRcfRemarks)
    ];
    const written = await writeReports(pipelineResult, generators, context.outputPath, onProgress);
    const paths = [...inferred.map(([name]) => join(context.outputPath, name)), ...written.map(report => report.path)];
    return {
      context: { ...context, reports: written },
      summary: `${paths.length} files written`,
      artifacts: paths.map(path => ({ label: path.slice(context.outputPath.length + 1), path }))
    };
  }
});

export const createRcfPipeline = (config: RcfConfig) =>
  createPipeline<RcfContext>('rcf', [readInput(config), inferReports(config), writeRcfReports(config)], rcfValidForCertification(config));

/**
 * Run RESO Common Format: read and fingerprint the files, infer the metadata and availability reports, check
 * variations, and write the reports, `report.json` and `report-detailed.json` among them, into the output directory.
 * The `rcf` command runs this, so a run from the SDK and one from the command are the same run.
 */
export const runRcfCompliance = async (config: RcfConfig, onProgress?: ProgressCallback): Promise<PipelineResult> =>
  createRcfPipeline(config).run({ outputPath: rcfOutputPath(config), generatedOn: new Date().toISOString() }, onProgress, {
    failFast: config.options?.failFast ?? true
  });
