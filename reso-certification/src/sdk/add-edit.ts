import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeCleanup } from '../add-edit/cleanup.js';
import { runAllScenarios } from '../add-edit/index.js';
import { type AddEditTestPlan, PAYLOAD_FILES, SUCCEEDS_SCENARIOS, describePlan, payloadsFor, planAddEditTests } from '../add-edit/plan.js';
import { type Payloads, payloadSourceProblems, providedPayloadProblems } from '../add-edit/run-checks.js';
import { readPayloads } from '../add-edit/test-runner.js';
import {
  buildResourceUrl,
  fetchMetadata,
  getEntityType,
  loadMetadataFromFile,
  odataRequest,
  parseMetadataXml,
  resolveAuthToken
} from '../test-runner/index.js';
import { persistMetadataXml } from '../test-runner/metadata.js';
import type { ScenarioResult } from '../test-runner/types.js';
import { CURRENT_ADD_EDIT_VERSION, whyAddEditVersionDoesNotCertify } from './add-edit-versions.js';
import { RECORDS_TESTED, allOf, everyStepPassed, testedAtLeastOneRecord, versionCertifies } from './certification.js';
import { collectValidationErrors, formatValidationSummary, validateMetadata } from './metadata-validation.js';
import { createPipeline } from './pipeline.js';
import { addEditReportGenerators, prepareOutputDir, writeReports } from './reports.js';
import { FETCH_METADATA, GENERATE_PAYLOADS, RUN_ADD_EDIT_SCENARIOS } from './step-names.js';
import type { AddEditConfig, InlinePayloads, PipelineStep, ValidForCertification } from './types.js';
import type { BaseTestContext } from './types.js';

// ── Pipeline Context ──

interface AddEditContext extends BaseTestContext {
  readonly resource: string;
  /** The Add/Edit version the run tests at, resolved once when it starts, so the result records what ran. */
  readonly specVersion: string;
  readonly entityType?: { readonly keyProperties: ReadonlyArray<string> };
  /** What the run tests, once its payloads are ready. */
  readonly plan?: AddEditTestPlan;
  /**
   * The provider's payloads as the run read them, from its folder or its configuration, so a cloud entry built later
   * carries what ran and never a file that changed since. Auto payloads are not recorded: the cloud refuses them.
   */
  readonly payloads?: InlinePayloads;
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
    const headers: Record<string, string> = ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {};
    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(url, { headers });
        if (response.ok) {
          return { context: ctx, summary: 'OData service is ready', requestDetails: [{ method: 'GET', url }] };
        }
      } catch {
        /* network error — retry */
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      onProgress({ step: 'Service check', status: 'running', message: `Waiting for server (attempt ${i + 1})...` });
    }
    return {
      context: ctx,
      status: 'failed',
      errors: ['OData service did not respond'],
      requestDetails: [{ method: 'GET', url, error: `No response after ${maxAttempts} attempts` }]
    };
  }
};

/** Resolve the auth token from the config. */
const resolveAuth = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Resolve authentication',
  run: async ctx => {
    const authToken = await resolveAuthToken(config.server.auth);
    return { context: { ...ctx, authToken }, summary: 'Auth credentials present' };
  }
});

/** Fetch and parse OData $metadata from the server or a local file. */
const fetchAndParseMetadata = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: FETCH_METADATA,
  run: async (ctx, onProgress) => {
    onProgress({ step: FETCH_METADATA, status: 'running', message: 'Fetching $metadata...' });
    const metadataXml = config.metadataPath
      ? await loadMetadataFromFile(config.metadataPath)
      : await fetchMetadata(ctx.serverUrl, ctx.authToken!);

    // Persist raw EDMX next to the report files (CLI + UI download).
    await persistMetadataXml(ctx.outputPath, metadataXml);

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
          `Entity type "${ctx.resource}" not found in metadata. Available: ${metadata.entityTypes.map(et => et.name).join(', ')}`
        ]
      };
    }

    return {
      context: { ...ctx, metadataXml, entityType },
      summary: `Parsed metadata: ${metadata.entityTypes.length} entity types. ${formatValidationSummary(validation)}`,
      counts: { entityTypes: metadata.entityTypes.length, fields: entityType.properties.length },
      ...(validationErrors.length > 0 ? { errors: validationErrors } : {}),
      ...(!validation.xsdValid || !validation.semanticValid ? { status: 'failed' as const } : {})
    };
  }
});

/**
 * Sample two records from the server, for auto payloads that test an update or a delete without a create to make
 * the record. Ordered and read by the resource's own key, from its metadata.
 */
const sampleRecords = (_config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Sample records',
  run: async ctx => {
    const keyField = ctx.entityType?.keyProperties[0];
    if (keyField === undefined) {
      return { context: ctx, status: 'failed', errors: [`${ctx.resource} has no key in its metadata to sample records by`] };
    }
    const url = buildResourceUrl(ctx.serverUrl, ctx.resource);
    const response = await odataRequest({
      method: 'GET',
      url: `${url}?$top=2&$orderby=${keyField}`,
      authToken: ctx.authToken!
    });

    const body = response.body as { value?: ReadonlyArray<Record<string, unknown>> };
    const records = body?.value ?? [];

    if (records.length < 2) {
      return {
        context: ctx,
        status: 'failed',
        errors: [`Need at least 2 ${ctx.resource} records for sampling, found ${records.length}`]
      };
    }

    const keys = records.map(r => String(r[keyField]));

    return {
      context: { ...ctx, sampleKeys: keys, sampleRecords: records },
      summary: `Sampled ${keys.length} ${ctx.resource} records`,
      params: { keys }
    };
  }
});

/** The resource auto payloads are written for. Their fields are Property's. */
const AUTO_PAYLOAD_RESOURCE = 'Property';

/** A key no record has, for the delete that should fail. */
const NON_EXISTENT_ID = '00000000-0000-0000-0000-000000000000';

/** The payloads auto mode writes. The reference server and the mock only: never a provider's server for certification. */
const AUTO_PAYLOADS = {
  createSucceeds: {
    ListPrice: 350000.0,
    BedroomsTotal: 4,
    BathroomsTotalInteger: 3,
    City: 'Test City',
    StateOrProvince: 'CA',
    PostalCode: '90210',
    Country: 'US'
  },
  createFails: { ListPrice: -99999.0, BedroomsTotal: 3, BathroomsTotalInteger: 2 },
  updateSucceeds: { ListPrice: 375000.0 },
  updateFails: { ListPrice: -1.0 }
} as const;

/**
 * What auto mode writes for a plan. An update or a delete takes a sampled record when there is one, else none, and
 * the run then uses the record its create test made.
 */
const autoPayloadsFor = (plan: AddEditTestPlan, keyField: string | undefined, sampled: ReadonlyArray<string>): Payloads => {
  const updateKey = sampled[0] !== undefined && keyField !== undefined ? { [keyField]: sampled[0] } : {};
  const all: Payloads = {
    ...AUTO_PAYLOADS,
    updateSucceeds: { ...AUTO_PAYLOADS.updateSucceeds, ...updateKey },
    updateFails: { ...AUTO_PAYLOADS.updateFails, ...updateKey },
    deleteSucceeds: sampled.length > 0 ? { id: sampled[1] ?? sampled[0] } : {},
    deleteFails: { id: NON_EXISTENT_ID }
  };
  return Object.fromEntries(payloadsFor(plan).map(name => [name, all[name]]));
};

/**
 * Get the payloads ready: the provider's, from a folder or the configuration, or auto ones when asked for. A run
 * given none, or given them two ways, is refused before anything is written.
 */
const generatePayloads = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: GENERATE_PAYLOADS,
  run: async ctx => {
    const fail = (errors: ReadonlyArray<string>) => ({ context: ctx, status: 'failed' as const, errors: [...errors] });

    const planned = planAddEditTests({ actions: config.actions, formats: config.formats });
    if ('problems' in planned) return fail(planned.problems);
    const { plan } = planned;

    const sourceProblems = payloadSourceProblems(config);
    if (sourceProblems.length > 0) return fail(sourceProblems);

    const keyField = ctx.entityType?.keyProperties[0];

    // A folder the provider wrote: checked as it is, then used where it is.
    if (config.payloadsDir) {
      const read: Awaited<ReturnType<typeof readPayloads>> | Error = await readPayloads(config.payloadsDir, payloadsFor(plan)).catch(
        (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
      );
      if (read instanceof Error) return fail([read.message]);
      const problems = providedPayloadProblems(plan, read, keyField);
      if (problems.length > 0) return fail(problems);
      return {
        // The files as read, kept with the result, so a cloud entry carries what ran and never the folder as it is later.
        context: { ...ctx, payloadsDir: config.payloadsDir, plan, payloads: read },
        summary: `Using the payloads in ${config.payloadsDir} for ${describePlan(plan)}`
      };
    }

    if (config.autoPayloads && ctx.resource !== AUTO_PAYLOAD_RESOURCE) {
      return fail([`Auto payloads are written for ${AUTO_PAYLOAD_RESOURCE}. For ${ctx.resource}, give the payloads.`]);
    }
    const payloads = config.autoPayloads ? autoPayloadsFor(plan, keyField, ctx.sampleKeys ?? []) : (config.payloads ?? {});
    if (!config.autoPayloads) {
      const problems = providedPayloadProblems(plan, payloads, keyField);
      if (problems.length > 0) return fail(problems);
    }

    const outputDir = config.options?.outputDir
      ? join(config.options.outputDir, 'payloads')
      : join(process.cwd(), '.reso-cert', 'payloads');
    await mkdir(outputDir, { recursive: true });
    const needed = payloadsFor(plan);
    await Promise.all(needed.map(name => writeFile(join(outputDir, PAYLOAD_FILES[name]), JSON.stringify(payloads[name] ?? {}, null, 2))));

    // The plan's payloads only, as a folder run records only the files it read: a stray one in the configuration,
    // for an action not tested, is checked by nothing here and would be checked by the cloud.
    const used = Object.fromEntries(needed.map(name => [name, payloads[name]]));
    return {
      context: { ...ctx, payloadsDir: outputDir, plan, ...(config.autoPayloads ? {} : { payloads: used }) },
      summary: `${config.autoPayloads ? 'Wrote auto' : "Wrote the configuration's"} ${needed.length} payload files for ${describePlan(plan)}`,
      artifacts: [{ label: 'Payloads', path: outputDir }],
      counts: { payloads: needed.length }
    };
  }
});

/** The records a run acted on: each succeeds scenario that passed created, updated or deleted one. */
export const recordsWrittenBy = (scenarios: ReadonlyArray<Pick<ScenarioResult, 'scenario' | 'passed'>>): number =>
  scenarios.filter(s => s.passed && SUCCEEDS_SCENARIOS.some(name => name === s.scenario)).length;

/** Why an Add/Edit run that acted on no record failed, in the words the provider sees. */
export const NO_RECORDS_WRITTEN =
  'No record was created, updated or deleted, so nothing was tested. A system can only be certified on records it accepts.';

/**
 * Run the scenarios the plan names. A failed step does not stop the ones after it, so this one runs nothing when
 * the payloads were not made ready: the server is never written to with payloads that were refused.
 */
const runTests = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: RUN_ADD_EDIT_SCENARIOS,
  run: async (ctx, _onProgress) => {
    const { plan, payloadsDir } = ctx;
    if (plan === undefined || payloadsDir === undefined) {
      return { context: ctx, status: 'failed', errors: ['No test ran, because the payloads were not ready'] };
    }
    const testReport = await runAllScenarios({
      serverUrl: ctx.serverUrl,
      resource: ctx.resource,
      payloadsDir,
      auth: config.server.auth,
      metadataPath: config.metadataPath,
      // What the run was given, so the runner reads it into the same plan.
      ...(config.actions ? { actions: config.actions } : {}),
      ...(config.formats ? { formats: config.formats } : {})
    });

    const { passed, failed } = testReport.summary;
    // A run that acted on no record tested nothing, so it fails (Josh, 2026-11-04: "no Cert should work with 0 records
    // across the board").
    const recordsWritten = recordsWrittenBy(testReport.scenarios);
    const status = failed > 0 || recordsWritten === 0 ? ('failed' as const) : ('passed' as const);
    const cleanup = testReport.cleanup ?? { removed: [], notRemoved: [], left: [] };

    return {
      context: { ...ctx, testReport },
      status,
      summary: `${recordsWritten === 0 ? `${NO_RECORDS_WRITTEN} ` : ''}${passed} passed, ${failed} failed (${testReport.scenarios.length} scenarios)${describeCleanup(cleanup)}`,
      counts: { total: testReport.scenarios.length, passed, failed, [RECORDS_TESTED]: recordsWritten },
      ...(recordsWritten === 0 ? { errors: [NO_RECORDS_WRITTEN] } : {}),
      // What was tested, for the reports (RCP-010: "Certification reports will show which actions … were tested"), and
      // what became of the records the run created, by key, for the provider's detailed report.
      params: {
        tested: describePlan(plan),
        actions: plan.actions,
        formats: plan.formats,
        payloads: config.autoPayloads ? 'auto' : 'provided',
        cleanup
      }
    };
  }
});

export { describeCleanup } from '../add-edit/cleanup.js';

/** Write generic and detailed compliance reports. */
const writeComplianceReports = (config: AddEditConfig): PipelineStep<AddEditContext> => ({
  name: 'Write reports',
  run: async (ctx, onProgress) => {
    // outputPath is prepped by runAddEditCompliance before the
    // pipeline starts (prepareOutputDir).
    const generators = addEditReportGenerators(config.specVersion ?? CURRENT_ADD_EDIT_VERSION);

    // Adapt testReport into resourceReports shape for the detailed report serializer. A run refused before it
    // tested anything still writes its reports, with no scenarios, so the reason reaches whoever reads them.
    const testReport = (ctx.testReport as
      | { scenarios: ReadonlyArray<unknown>; summary: { total: number; passed: number; failed: number; skipped?: number } }
      | undefined) ?? { scenarios: [], summary: { total: 0, passed: 0, failed: 0 } };
    const contextWithReports = {
      ...ctx,
      resourceReports: [
        {
          resource: ctx.resource,
          summary: testReport.summary,
          scenarios: testReport.scenarios
        }
      ]
    };

    const steps = (ctx.pipelineSteps as ReadonlyArray<import('./types.js').StepResult>) ?? [];
    const pipelineResult = {
      // A run with no failing scenario still failed when a step did, such as one refused before it tested anything.
      status: testReport.summary.failed > 0 || steps.some(step => step.status === 'failed') ? ('failed' as const) : ('passed' as const),
      endorsement: 'add-edit',
      steps,
      context: contextWithReports,
      // The same pure rule the pipeline applies to its returned result, over the same step list, so
      // the written report and the returned result cannot disagree.
      certification: addEditValidForCertification(config)(steps),
      duration: 0
    };

    const written = await writeReports(pipelineResult, generators, ctx.outputPath, onProgress);

    return {
      context: { ...ctx, reports: written },
      summary: `${written.length} reports written`
    };
  }
});

// ── Pipeline Assembly ──

/**
 * Add/Edit's own certification rule: every step must have passed. A run on auto payloads certifies what it
 * passed like any other (Josh, 2026-10-30): the report records the actions and formats tested.
 *
 * Exported so the rule can be tested directly. The alternative is reaching it only through a full pipeline run
 * against a live server, which would leave the rule itself unobserved.
 *
 * The version is the one the report is labeled with. There is one Add/Edit version, so a run labeled with any other
 * does not certify.
 */
export const addEditValidForCertification =
  (config: AddEditConfig): ValidForCertification =>
  steps =>
    allOf(
      everyStepPassed(steps),
      testedAtLeastOneRecord(steps),
      versionCertifies(whyAddEditVersionDoesNotCertify(config.specVersion ?? CURRENT_ADD_EDIT_VERSION))
    );

/** Whether auto payloads need records sampled: an update or a delete is tested, and no create makes the record. */
const samplesRecords = (config: AddEditConfig): boolean => {
  if (!config.autoPayloads) return false;
  const planned = planAddEditTests({ actions: config.actions, formats: config.formats });
  if ('problems' in planned) return false;
  const { actions } = planned.plan;
  return !actions.includes('create') && (actions.includes('update') || actions.includes('delete'));
};

/** Create the Add/Edit compliance test pipeline. */
export const createAddEditPipeline = (config: AddEditConfig) =>
  createPipeline<AddEditContext>(
    'add-edit',
    [
      resolveAuth(config),
      ...(config.options?.skipHealthCheck ? [] : [serviceCheck]),
      fetchAndParseMetadata(config),
      ...(samplesRecords(config) ? [sampleRecords(config)] : []),
      generatePayloads(config),
      runTests(config),
      writeComplianceReports(config)
    ],
    addEditValidForCertification(config)
  );

/** Run Add/Edit compliance tests with a single function call. */
export const runAddEditCompliance = async (config: AddEditConfig, onProgress?: (progress: import('./types.js').StepProgress) => void) => {
  const pipeline = createAddEditPipeline(config);
  const specVersion = config.specVersion ?? CURRENT_ADD_EDIT_VERSION;
  const outputPath = await prepareOutputDir('web-api-add-edit', specVersion, config);
  const initialContext: AddEditContext = {
    serverUrl: config.server.url,
    resource: config.resource,
    specVersion,
    outputPath
  };

  return pipeline.run(initialContext, onProgress, { failFast: config.options?.failFast ?? false });
};

/** Run Add/Edit compliance from a config file. Runs each config entry sequentially. */
export const runAddEditFromConfigFile = async (configPath: string, onProgress?: (progress: import('./types.js').StepProgress) => void) => {
  const { loadConfigFile, configEntryToAddEdit } = await import('./config.js');
  const configFile = await loadConfigFile(configPath);

  const results: Array<import('./types.js').PipelineResult> = [];

  for (const entry of configFile.configs) {
    const config = configEntryToAddEdit(entry, configFile.providerUoi);
    const result = await runAddEditCompliance(config, onProgress);
    results.push(result);
  }

  return results;
};

export { addEditRunProblems } from '../add-edit/run-checks.js';
