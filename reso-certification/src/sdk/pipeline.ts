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
    const hasFailure = results.some(r => r.status === 'failed');

    return {
      context: mergedContext,
      status: hasFailure ? 'failed' : 'passed',
      summary: summaries.join('; '),
      errors: errors.length > 0 ? errors : undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    };
  }

  // Sequential: thread context through each function
  let currentContext = { ...context } as TContext;
  let lastOutput: StepOutput<TContext> = { context: currentContext };
  const allErrors: string[] = [];
  const allArtifacts: Array<{ readonly label: string; readonly path: string }> = [];
  const allSummaries: string[] = [];

  for (const fn of functions) {
    const output = await fn(currentContext, onProgress);
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
    let pipelineStatus: 'passed' | 'failed' = 'passed';

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
        }
      } catch (err) {
        const duration = Date.now() - stepStart;
        const errorMessage = err instanceof Error ? err.message : String(err);

        stepResults.push({
          name: step.name,
          endorsement,
          status: 'failed',
          duration,
          errors: [errorMessage],
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

    // Mark remaining steps as skipped if we exited early
    const completedNames = new Set(stepResults.map(r => r.name));
    for (const step of steps) {
      if (!completedNames.has(step.name)) {
        stepResults.push({
          name: step.name,
          endorsement,
          status: 'skipped',
          duration: 0,
        });
        onProgress({ step: step.name, status: 'skipped' });
      }
    }

    return {
      status: pipelineStatus,
      endorsement,
      steps: stepResults,
      context,
      duration: Date.now() - startTime,
    };
  },
});
