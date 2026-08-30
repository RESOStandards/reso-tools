import type {
  PipelineContext,
  PipelineOptions,
  PipelineResult,
  PipelineStep,
  ProgressCallback,
  StepOutput,
  StepResult,
  TestFunction,
} from './types.js';

/** No-op progress callback for callers that don't need progress updates. */
const noopProgress: ProgressCallback = () => {};

/**
 * Execute a step's test functions according to its mode.
 *
 * - sequential (default): runs functions in order, threading context through each
 * - parallel: runs all functions concurrently with the same input context,
 *   then merges their outputs (last-write-wins for context keys)
 *
 * TODO: implement concurrency limit for parallel mode (step.concurrency)
 */
const executeStepFunctions = async <TContext extends PipelineContext>(
  functions: ReadonlyArray<TestFunction<TContext>>,
  mode: 'sequential' | 'parallel',
  context: Readonly<TContext>,
  onProgress: ProgressCallback,
): Promise<StepOutput<TContext>> => {
  if (functions.length === 0) {
    return { context: { ...context } as TContext };
  }

  if (functions.length === 1) {
    return functions[0](context, onProgress);
  }

  if (mode === 'parallel') {
    // TODO: respect step.concurrency limit
    const results = await Promise.all(
      functions.map(fn => fn(context, onProgress))
    );

    // Merge outputs: contexts merge (last wins), summaries join, errors concat
    const mergedContext = results.reduce(
      (acc, r) => ({ ...acc, ...r.context }),
      { ...context } as TContext,
    );
    const summaries = results.map(r => r.summary).filter(Boolean);
    const errors = results.flatMap(r => r.errors ?? []);
    const artifacts = results.flatMap(r => r.artifacts ?? []);
    const counts = results.reduce(
      (acc, r) => ({ ...acc, ...r.counts }),
      {} as Record<string, number>,
    );
    // Merge sub-status with the same precedence as the sequential runner: failed > incomplete > passed.
    const mergedStatus = results.some(r => r.status === 'failed')
      ? 'failed' as const
      : results.some(r => r.status === 'incomplete')
        ? 'incomplete' as const
        : 'passed' as const;

    return {
      context: mergedContext,
      status: mergedStatus,
      summary: summaries.join('; '),
      errors: errors.length > 0 ? errors : undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    };
  }

  // Sequential: thread context through each function.
  // Wrap each in an arrow function to ensure each is a separate async invocation.
  let currentContext = { ...context } as TContext;
  let lastOutput: StepOutput<TContext> = { context: currentContext };
  const allErrors: string[] = [];
  const allArtifacts: Array<{ readonly label: string; readonly path: string }> = [];
  const allSummaries: string[] = [];

  const wrappedFunctions = functions.map((fn) => async () => {
    const output = await fn(currentContext, onProgress);
    // Emit sub-step completion with the function's summary as detail
    if (output.summary) {
      onProgress({ step: `sub:done`, status: output.status ?? 'passed', message: output.summary });
    }
    return output;
  });

  for (const wrappedFn of wrappedFunctions) {
    const output = await wrappedFn();
    currentContext = { ...output.context } as TContext;
    lastOutput = output;

    if (output.summary) allSummaries.push(output.summary);
    if (output.errors) allErrors.push(...output.errors);
    if (output.artifacts) allArtifacts.push(...output.artifacts);

    if (output.status === 'failed') {
      return {
        context: currentContext,
        status: 'failed',
        summary: allSummaries.join('; '),
        errors: allErrors.length > 0 ? allErrors : undefined,
        artifacts: allArtifacts.length > 0 ? allArtifacts : undefined,
        counts: lastOutput.counts,
      };
    }
  }

  return {
    context: currentContext,
    status: lastOutput.status,
    summary: allSummaries.length > 1 ? allSummaries.join('; ') : lastOutput.summary,
    errors: allErrors.length > 0 ? allErrors : undefined,
    artifacts: allArtifacts.length > 0 ? allArtifacts : undefined,
    counts: lastOutput.counts,
    params: lastOutput.params,
  };
};

/** Create a pipeline from an ordered list of steps and execute it. */
export const createPipeline = <TContext extends PipelineContext>(
  endorsement: string,
  steps: ReadonlyArray<PipelineStep<TContext>>,
) => ({
  /** Run all steps in sequence, accumulating context and emitting progress. */
  run: async (
    initialContext: TContext,
    onProgress: ProgressCallback = noopProgress,
    options: PipelineOptions = {},
  ): Promise<PipelineResult<TContext>> => {
    const { failFast = true } = options;
    const startTime = Date.now();
    const stepResults: StepResult[] = [];
    let context = { ...initialContext };
    // Precedence: a real failure outranks an incomplete (deadline) run, which outranks passed.
    let pipelineStatus: 'passed' | 'failed' | 'incomplete' = 'passed';

    for (const step of steps) {
      const stepStart = Date.now();

      onProgress({ step: step.name, status: 'running' });

      try {
        // Resolve test functions: use `functions` array if provided, fall back to `run`
        const functions: ReadonlyArray<TestFunction<TContext>> =
          step.functions ?? (step.run ? [step.run] : []);
        const mode = step.mode ?? 'sequential';

        const output = await executeStepFunctions(functions, mode, context as Readonly<TContext>, onProgress);
        const duration = Date.now() - stepStart;
        const status = output.status ?? 'passed';

        const result: StepResult = {
          name: step.name,
          endorsement,
          status,
          duration,
          summary: output.summary,
          params: output.params,
          artifacts: output.artifacts,
          counts: output.counts,
          errors: output.errors,
          requestDetails: output.requestDetails,
        };

        stepResults.push(result);
        context = { ...output.context, pipelineSteps: [...stepResults] };

        onProgress({
          step: step.name,
          status,
          duration,
          message: output.summary,
          artifacts: output.artifacts,
        });

        if (status === 'failed') {
          pipelineStatus = 'failed';
          if (failFast) break;
        } else if (status === 'incomplete' && pipelineStatus === 'passed') {
          // A deadline-truncated step makes the run incomplete unless a real failure outranks it.
          // Do NOT failFast — finalizer steps (report writing) must still run to persist the partial report.
          pipelineStatus = 'incomplete';
        }
      } catch (err) {
        const duration = Date.now() - stepStart;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errDetail = (err as Record<string, unknown>)?.requestDetails as Record<string, unknown> | undefined;
        const requestDetails = errDetail ? [errDetail as { method: string; url: string; status?: number; error?: string; responseBody?: string }] : undefined;

        stepResults.push({
          name: step.name,
          endorsement,
          status: 'failed',
          duration,
          errors: [errorMessage],
          requestDetails,
        });

        onProgress({
          step: step.name,
          status: 'failed',
          duration,
          message: errorMessage,
        });

        pipelineStatus = 'failed';
        if (failFast) break;
      }
    }

    // After a fail-fast break, run any remaining `alwaysRun` steps
    // (e.g., a `Write reports` finalizer) so failure-mode artifacts
    // still land on disk. Steps in between the failure and the
    // alwaysRun finalizer stay marked `'skipped'` — they really did
    // not run. The alwaysRun step's own status reflects what happened
    // when it ran (typically `'passed'`, but can be `'failed'` if the
    // finalizer itself errors).
    const completedNames = new Set(stepResults.map(r => r.name));
    const remaining = steps.filter(s => !completedNames.has(s.name));
    for (const step of remaining) {
      if (!step.alwaysRun) continue;
      const stepStart = Date.now();
      onProgress({ step: step.name, status: 'running' });
      try {
        const functions: ReadonlyArray<TestFunction<TContext>> =
          step.functions ?? (step.run ? [step.run] : []);
        const mode = step.mode ?? 'sequential';
        const output = await executeStepFunctions(functions, mode, context as Readonly<TContext>, onProgress);
        const duration = Date.now() - stepStart;
        const status = output.status ?? 'passed';
        const result: StepResult = {
          name: step.name,
          endorsement,
          status,
          duration,
          summary: output.summary,
          params: output.params,
          artifacts: output.artifacts,
          counts: output.counts,
          errors: output.errors,
          requestDetails: output.requestDetails,
        };
        stepResults.push(result);
        context = { ...output.context, pipelineSteps: [...stepResults] };
        onProgress({
          step: step.name,
          status,
          duration,
          message: output.summary,
          artifacts: output.artifacts,
        });
      } catch (err) {
        const duration = Date.now() - stepStart;
        const errorMessage = err instanceof Error ? err.message : String(err);
        // Finalizer-step failure does not change pipelineStatus — the
        // pipeline is already 'failed' if we got here, and the original
        // failure is the load-bearing one for the user. Just record it.
        stepResults.push({
          name: step.name,
          endorsement,
          status: 'failed',
          duration,
          errors: [errorMessage],
        });
        onProgress({ step: step.name, status: 'failed', duration, message: errorMessage });
      }
    }

    // Anything still uncompleted (non-alwaysRun) is genuinely skipped.
    const finalCompletedNames = new Set(stepResults.map(r => r.name));
    for (const step of steps) {
      if (!finalCompletedNames.has(step.name)) {
        stepResults.push({
          name: step.name,
          endorsement,
          status: 'skipped',
          duration: 0,
        });
        onProgress({ step: step.name, status: 'skipped' });
      }
    }

    // Re-sort to match the original pipeline declaration order. Without
    // this, alwaysRun finalizers (executed after the fail-fast break)
    // would appear in stepResults BEFORE the skipped intermediates, but
    // for display they need to follow original sequence.
    const orderIndex = new Map(steps.map((s, i) => [s.name, i]));
    const orderedStepResults = [...stepResults].sort((a, b) => {
      const ai = orderIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

    return {
      status: pipelineStatus,
      endorsement,
      steps: orderedStepResults,
      context,
      duration: Date.now() - startTime,
    };
  },
});
