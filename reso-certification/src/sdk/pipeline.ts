import type {
  PipelineContext,
  PipelineOptions,
  PipelineResult,
  PipelineStep,
  ProgressCallback,
  StepResult,
} from './types.js';

/** No-op progress callback for callers that don't need progress updates. */
const noopProgress: ProgressCallback = () => {};

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
        const output = await step.run(context, onProgress);
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
