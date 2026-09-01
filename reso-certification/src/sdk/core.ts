/**
 * Web API Core SDK pipeline.
 *
 * Runs all Core compliance scenarios per resource using the same
 * pipeline pattern as Add/Edit and EntityEvent.
 */

import { resolveAuthToken } from '../test-runner/auth.js';
import { fetchMetadata, loadMetadataFromFile, parseMetadataXml, getEntityType, persistMetadataXml } from '../test-runner/metadata.js';
import { validateMetadata, formatValidationSummary, collectValidationErrors } from './metadata-validation.js';
import { buildStandardMap, resolveTestParams, WELL_KNOWN_RESOURCES } from '../web-api-core/index.js';
import { runCoreResourceScenarios, runProviderScenarios, summarizeScenarios, type ResourceTestReport } from '../web-api-core/test-runner.js';
import { resolveServingDecision } from '../web-api-core/serving.js';
import { isDeadlineError, runSettled } from '@reso-standards/reso-client';
import { createCertSession, createSessionRequester } from '../test-runner/requester.js';
import type { BaseTestContext, CoreConfig, PipelineStep, StepResult } from './types.js';
import { createPipeline } from './pipeline.js';
import { coreReportGenerators, writeReports, prepareOutputDir } from './reports.js';

// ── Pipeline Context ──

interface CoreContext extends BaseTestContext {
  readonly version: '2.0.0' | '2.1.0';
  readonly enumMode: 'auto' | 'isflags' | 'collections' | 'string';
  readonly resources: ReadonlyArray<string>;
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

    // Persist raw EDMX next to the report files so CLI users can grep
    // it and the desktop client's "Download Metadata XML" button
    // (job.reports.metadataXml) lights up automatically.
    await persistMetadataXml(ctx.outputPath, metadataXml);

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

/**
 * A resource that could not be sampled or tested is reported as SKIPPED, not failed —
 * the tests couldn't run, so it is inconclusive rather than a compliance failure.
 * Continue-on-error keeps the run going; this keeps the unsampled resource visible in
 * the verdict as a skip rather than being silently dropped.
 */
export const skippedResourceReport = (resource: string, error: unknown): ResourceTestReport => {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    resource,
    params: { resource, keyField: '', keyValue: '', enumMode: 'string', integerValueHigh: 0, skippedTypes: [], sampleComplete: false },
    scenarios: [
      {
        tag: 'resource-skipped',
        name: `${resource} could not be sampled or tested: ${detail}`,
        passed: false,
        skipped: true,
        assertions: [],
        duration: 0,
      },
    ],
    coverage: [],
    summary: { total: 1, passed: 0, failed: 0, skipped: 1, optional: { passed: 0, notSupported: 0, notTested: 0 } },
  };
};

/**
 * A resource we never reached because the run's total-timeout budget was already spent —
 * reported as SKIPPED (not failed) with a deadline reason, and flagged so the run's verdict
 * becomes `incomplete`. Distinct from skippedResourceReport, which means "could not sample".
 */
export const deadlineResourceReport = (resource: string): ResourceTestReport => ({
  resource,
  params: { resource, keyField: '', keyValue: '', enumMode: 'string', integerValueHigh: 0, skippedTypes: [], sampleComplete: false },
  scenarios: [
    {
      tag: 'resource-not-tested',
      name: `${resource} not tested — run deadline reached`,
      passed: true,
      skipped: true,
      assertions: [{ passed: true, message: 'Not tested — run deadline reached' }],
      duration: 0,
    },
  ],
  coverage: [],
  summary: { total: 1, passed: 0, failed: 0, skipped: 1, optional: { passed: 0, notSupported: 0, notTested: 0 } },
  deadlineReached: true,
});

/** The synthetic resource label under which the once-per-provider structural scenarios are reported. */
export const PROVIDER_WIDE_LABEL = 'Service (provider-wide)';

/** A minimal params stub for a report that never sampled (masked / provider-wide). */
const stubParams = (resource: string): ResourceTestReport['params'] =>
  ({ resource, keyField: '', keyValue: '', enumMode: 'string', integerValueHigh: 0, skippedTypes: [], sampleComplete: false });

/**
 * A REQUIRED resource (Property/Member/Office/Field/Lookup) that is determinately declared-but-not-served at
 * the top level (Core 2.1.0 carve-out). One clean FAIL — NOT a 40-scenario 404 cascade — and no sampling
 * request was issued. The single failed scenario drives the Core verdict to `failed`; it never sets
 * `deadlineReached`.
 */
export const requiredResourceNotServedReport = (resource: string): ResourceTestReport => ({
  resource,
  params: stubParams(resource),
  scenarios: [
    {
      tag: 'required-resource-not-served',
      name: `${resource} is declared in $metadata but not served as a top-level resource`,
      passed: false,
      skipped: false,
      assertions: [{ passed: false, message: `Required resource not served top level — ${resource} is declared in the metadata but is absent from both the service document and the served EntitySets, so it cannot be queried at the top level` }],
      duration: 0,
    },
  ],
  coverage: [],
  summary: { total: 1, passed: 0, failed: 1, skipped: 0, optional: { passed: 0, notSupported: 0, notTested: 0 } },
});

/**
 * A non-required well-known resource (Media, OpenHouse, Showing, …) that is determinately declared-but-not-
 * served at the top level (Core 2.1.0 carve-out). Reported Not Applicable — a single SKIPPED scenario with a
 * passed:true assertion (the clean-render skip pattern, so it shows as NA, not a failure). No sampling request
 * was issued; it counts 0 failed and never sets `deadlineReached`.
 */
export const notServedNotApplicableReport = (resource: string): ResourceTestReport => ({
  resource,
  params: stubParams(resource),
  scenarios: [
    {
      tag: 'resource-not-applicable',
      name: `${resource} declared but not served at the top level — Not Applicable`,
      passed: true,
      skipped: true,
      assertions: [{ passed: true, message: `Not Applicable — ${resource} is declared in the metadata but not served as a top-level resource; per the Core 2.1.0 carve-out this is permitted (it may be available only via $expand)` }],
      duration: 0,
    },
  ],
  coverage: [],
  summary: { total: 1, passed: 0, failed: 0, skipped: 1, optional: { passed: 0, notSupported: 0, notTested: 0 } },
});

/**
 * The Core run verdict from the aggregate counts — the single source of truth for the run's
 * status, used by both the test step and the report writer so they can never diverge.
 *
 * Precedence: a real failure (a failed required scenario OR a failed coverage gate) is
 * DEFINITIVE and outranks an `incomplete` (deadline-truncated) run, which outranks `passed`.
 * Running out of time AFTER observing a real failure does not soften it to "incomplete"; and
 * not-tested work (skipped) is never a failure. Mirrors the pipeline's failed > incomplete > passed.
 */
export const coreVerdict = (args: {
  readonly totalFailed: number;
  readonly coverageFailed: boolean;
  readonly deadlineReached: boolean;
}): 'passed' | 'failed' | 'incomplete' =>
  args.totalFailed > 0 || args.coverageFailed
    ? 'failed'
    : args.deadlineReached
      ? 'incomplete'
      : 'passed';

/**
 * The report's HEADLINE outcome — coreVerdict plus the "the run did not complete cleanly"
 * signals the testing counts alone can't see, so a certification report never reads as a clean
 * PASS for a run whose process verdict is 'failed':
 *   - `priorStepFailed` — a failed upstream step (service check, metadata validation) that a
 *     non-failFast run continued past;
 *   - `testingAborted` — the testing phase produced no results at all (e.g. a fatal-auth abort
 *     mid-run), so there is nothing to certify.
 * Either forces 'failed'; otherwise the testing verdict stands. A normal run trips neither and
 * behaves exactly as coreVerdict.
 */
export const reportVerdict = (args: {
  readonly priorStepFailed: boolean;
  readonly testingAborted: boolean;
  readonly totalFailed: number;
  readonly coverageFailed: boolean;
  readonly deadlineReached: boolean;
}): 'passed' | 'failed' | 'incomplete' =>
  args.priorStepFailed || args.testingAborted
    ? 'failed'
    : coreVerdict({
        totalFailed: args.totalFailed,
        coverageFailed: args.coverageFailed,
        deadlineReached: args.deadlineReached
      });

const sampleAndTest = (config: CoreConfig): PipelineStep<CoreContext> => ({
  name: 'Run Core scenarios',
  run: async (ctx, onProgress) => {
    const metadata = parseMetadataXml(ctx.metadataXml!);
    const version = ctx.version;
    // Standard map (DD reference) built once per run — field/value membership for standard-first selection.
    const standardMap = buildStandardMap(version);
    // One resilience session shared across the whole run (see createCertSession for the full
    // rationale): cert retries only 429/503 (twice), records every other response and moves on,
    // with no breaker or pacing and a 15-min per-request timeout. A total run budget bounds the
    // whole run; when it is spent the run stops gracefully and remaining work is marked NOT TESTED
    // (status → incomplete), so a partial report is still written rather than the process being killed.
    const session = createCertSession(config.totalTimeoutMs);
    const requester = createSessionRequester(session);

    // Provider-wide structural pass — run ONCE for the whole provider, BEFORE the per-resource gate, so the
    // metadata + service-document scenarios are always recorded even if every resource ends up masked. The
    // service document doubles as Surface 1 of the serving detection, and the metadata response gives the
    // OData version threaded into each resource's 4.01 gate.
    const provider = await runProviderScenarios(ctx.serverUrl, ctx.authToken!, version, requester);

    // Continue-on-error across resources: one bad resource (e.g. a sampling network
    // failure) is captured and the run keeps going, so a walk-away run still yields a
    // full report. A fatal error (auth revoked) stops the run — surfaced below.
    const settled = await runSettled(
      ctx.resources,
      async (resource): Promise<ResourceTestReport> => {
        const entityType = getEntityType(metadata, resource)!;

        // Core 2.1.0 declared-but-not-served carve-out. Decide from the two authoritative surfaces BEFORE
        // sampling — a masked resource issues NO sampling request. `run` (the default on any doubt) falls
        // through to the normal sample-and-test path below.
        const decision = resolveServingDecision({
          resource,
          entityType,
          version,
          servedEntitySets: provider.servedEntitySets,
          declaredEntitySets: metadata.entitySets,
        });
        if (decision === 'fail') {
          onProgress({ step: 'Run Core scenarios', status: 'running', message: `${resource}: required resource declared but not served top level — one clean failure` });
          return requiredResourceNotServedReport(resource);
        }
        if (decision === 'na') {
          onProgress({ step: 'Run Core scenarios', status: 'running', message: `${resource}: declared but not served top level — Not Applicable (may be expansion-only)` });
          return notServedNotApplicableReport(resource);
        }

        onProgress({
          step: 'Run Core scenarios',
          status: 'running',
          message: `Sampling ${resource}...`,
        });

        const enumModeOverride = ctx.enumMode !== 'auto' ? ctx.enumMode as import('../web-api-core/sampling.js').EnumMode : undefined;
        // Sampling issues requests, so it can hit the run deadline; if it does, this resource is
        // "not tested" (ran out of time), NOT "could not sample". A deadline reached mid-scenarios
        // is handled inside runCoreResourceScenarios, which returns a partial report.
        const params = await resolveTestParams(
          ctx.serverUrl,
          resource,
          entityType,
          ctx.authToken!,
          metadata.enumTypes,
          standardMap,
          enumModeOverride,
          requester,
        ).catch((err: unknown) => {
          if (isDeadlineError(err)) return null;
          throw err;
        });
        if (params === null) return deadlineResourceReport(resource);

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
          requester,
          // Provider-wide scenarios already ran once above; thread the detected version for the 4.01 gate.
          { excludeProviderWide: true, odataVersion: provider.odataVersion },
        );

        onProgress({
          step: 'Run Core scenarios',
          status: 'running',
          message: `${resource}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`,
        });

        return report;
      },
      {
        onError: 'continue',
        onOutcome: (outcome) => {
          if (outcome.status === 'failed') {
            const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
            onProgress({
              step: 'Run Core scenarios',
              status: 'running',
              message: `${outcome.item}: skipped (could not sample) — ${detail}`,
            });
          }
        },
      },
    );

    if (settled.stoppedEarly && settled.fatalError !== undefined) {
      throw settled.fatalError; // fatal (e.g. auth revoked) — abort the whole Core run
    }

    // The provider-wide scenarios (metadata + service document) fold into the report as a synthetic
    // provider entry, PREPENDED so they read first and are counted exactly once. They survive an all-masked
    // provider (they ran before the per-resource gate). A failed service document is a real Core failure and
    // is counted here.
    const providerReport: ResourceTestReport = {
      resource: PROVIDER_WIDE_LABEL,
      params: stubParams(PROVIDER_WIDE_LABEL),
      scenarios: provider.scenarios,
      coverage: [],
      summary: summarizeScenarios(provider.scenarios),
      ...(provider.deadlineReached ? { deadlineReached: true } : {}),
    };

    // Preserve resource order; a resource we couldn't sample/test is reported as skipped.
    const resourceReports: ResourceTestReport[] = [
      providerReport,
      ...settled.outcomes.map((outcome): ResourceTestReport =>
        outcome.status === 'ok'
          ? outcome.value
          : skippedResourceReport(outcome.item, outcome.status === 'failed' ? outcome.error : new Error(outcome.reason)),
      ),
    ];

    // Required scenarios drive the verdict. Optional ("Optional Tests")
    // results are tallied separately and never contribute to `totalFailed`.
    const totalPassed = resourceReports.reduce((sum, r) => sum + r.summary.passed, 0);
    const totalFailed = resourceReports.reduce((sum, r) => sum + r.summary.failed, 0);
    const totalSkipped = resourceReports.reduce((sum, r) => sum + r.summary.skipped, 0);
    const totalScenarios = resourceReports.reduce((sum, r) => sum + r.summary.total, 0);
    const optPassed = resourceReports.reduce((sum, r) => sum + r.summary.optional.passed, 0);
    const optNotSupported = resourceReports.reduce((sum, r) => sum + r.summary.optional.notSupported, 0);
    const optNotTested = resourceReports.reduce((sum, r) => sum + r.summary.optional.notTested, 0);
    const optTotal = optPassed + optNotSupported + optNotTested;

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
    // Verdict precedence (see coreVerdict): a real failure (scenario or coverage gate) is
    // definitive and outranks an incomplete (deadline-truncated) run, which outranks passed.
    // A run that ran out of time is `incomplete` only if it observed no real failure.
    const deadlineReached = resourceReports.some(r => r.deadlineReached);
    const status = coreVerdict({ totalFailed, coverageFailed, deadlineReached });

    const coverageMsg = fullCoverage
      ? 'Full type coverage achieved'
      : `Missing coverage: ${missingTypes.join(', ')}`;
    const modeMsg = requireFullCoverage ? ' (--full-coverage enabled)' : '';
    const incompleteMsg = deadlineReached ? 'INCOMPLETE — run deadline reached; remaining resources/scenarios not tested. ' : '';

    return {
      context: { ...ctx, resourceReports, coverageMatrix: { coveredTypes, missingTypes, fullCoverage } },
      status,
      summary: incompleteMsg
        + `${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`
        + (optTotal > 0 ? `; optional: ${optPassed} passed, ${optNotSupported} not supported, ${optNotTested} not tested` : '')
        + ` (${totalScenarios} scenarios across ${resourceReports.length} resources). ${coverageMsg}${modeMsg}`,
      counts: {
        total: totalScenarios,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        optionalPassed: optPassed,
        optionalNotSupported: optNotSupported,
        optionalNotTested: optNotTested,
        resources: resourceReports.length,
      },
      ...(coverageFailed ? { errors: [`Full coverage required but missing types: ${missingTypes.join(', ')}`] } : {}),
    };
  },
});

const writeComplianceReports = (config: CoreConfig): PipelineStep<CoreContext> => ({
  name: 'Write reports',
  run: async (ctx, onProgress) => {
    // outputPath is prepped (built + archived + mkdir'd) by
    // runCoreCompliance before the pipeline starts so the fetch step
    // can persist metadata.xml. Reuse it here instead of rebuilding.
    const generators = coreReportGenerators(config.version ?? '2.0.0');

    const resourceReports = ctx.resourceReports as ReadonlyArray<ResourceTestReport> ?? [];
    const totalFailed = resourceReports.reduce((sum, r) => sum + r.summary.failed, 0);
    // The report's headline outcome must agree with the run's process verdict (and CLI exit
    // code), so it is derived via reportVerdict (see there). It folds the TESTING result
    // (coreVerdict on scenario/coverage/deadline) together with two "the run did not complete
    // cleanly" signals, so a certification report can never read as a clean PASS for a run that
    // actually failed:
    //   - a failed UPSTREAM step (service check, metadata validation) that a non-failFast run
    //     continued past — such a step lands in ctx.pipelineSteps;
    //   - a testing phase that produced NO results at all — e.g. a fatal-auth abort mid-run,
    //     where sampleAndTest threw and never threaded resourceReports onto the context.
    // The coverage gate is a run-level check that never shows up in totalFailed, so it is
    // carried explicitly.
    const deadlineReached = resourceReports.some(r => r.deadlineReached);
    const coverageMatrix = ctx.coverageMatrix as { readonly fullCoverage?: boolean } | undefined;
    const coverageFailed = (config.fullCoverage ?? false) && !(coverageMatrix?.fullCoverage ?? true);
    const priorSteps = ctx.pipelineSteps as ReadonlyArray<StepResult> ?? [];
    const priorStepFailed = priorSteps.some(s => s.status === 'failed');
    const testingAborted = (ctx.resources?.length ?? 0) > 0 && resourceReports.length === 0;

    const pipelineResult = {
      status: reportVerdict({ priorStepFailed, testingAborted, totalFailed, coverageFailed, deadlineReached }),
      endorsement: 'core',
      steps: ctx.pipelineSteps as ReadonlyArray<StepResult> ?? [],
      context: ctx,
      duration: 0,
    };

    const written = await writeReports(pipelineResult, generators, ctx.outputPath, onProgress);

    return {
      context: { ...ctx, reports: written },
      summary: `${written.length} reports written`,
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
  const outputPath = await prepareOutputDir('web-api-core', config.version ?? '2.0.0', config);
  const initialContext: CoreContext = {
    serverUrl: config.server.url,
    version: config.version ?? '2.0.0',
    enumMode: config.enumMode ?? 'auto',
    resources,
    outputPath,
  };

  return pipeline.run(
    initialContext,
    onProgress,
    { failFast: config.options?.failFast ?? false },
  );
};
