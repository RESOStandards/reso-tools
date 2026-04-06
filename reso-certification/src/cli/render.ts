/**
 * Progress rendering bridge — maps SDK ProgressCallback to listr2 tasks.
 */

import { Listr, PRESET_TIMER, type ListrDefaultRendererOptions } from 'listr2';
import { runComplianceTests } from '../sdk/index.js';
import type { ComplianceConfig, PipelineResult, StepProgress } from '../sdk/types.js';

/** Rendering mode derived from CLI flags. */
export type RenderMode = 'default' | 'verbose' | 'silent';

/** Map CLI options to a render mode. */
export const resolveRenderMode = (opts: { readonly verbose?: boolean; readonly output?: string }): RenderMode => {
  if (opts.output === 'json') return 'silent';
  if (opts.verbose) return 'verbose';
  return 'default';
};

/** Map step status to a display icon. */
const statusIcon = (status: StepProgress['status']): string => {
  switch (status) {
    case 'passed': return '\u2713';
    case 'failed': return '\u2717';
    case 'skipped': return '-';
    case 'running': return '\u25CB';
    case 'pending': return '\u00B7';
  }
};

/** Format a completed step as a one-line summary. */
const formatStep = (progress: StepProgress): string => {
  const icon = statusIcon(progress.status);
  const duration = progress.duration ? ` (${progress.duration}ms)` : '';
  const message = progress.message ? ` \u2014 ${progress.message}` : '';
  return `${icon} ${progress.step}${message}${duration}`;
};

/** Select listr2 renderer based on render mode. */
const resolveRenderer = (mode: RenderMode): 'default' | 'verbose' | 'silent' => {
  switch (mode) {
    case 'default': return 'default';
    case 'verbose': return 'verbose';
    case 'silent': return 'silent';
  }
};

/** Shared renderer options for the default renderer. */
const defaultRendererOptions: ListrDefaultRendererOptions = {
  collapseErrors: false,
  timer: PRESET_TIMER,
};

/** Run a single pipeline with listr2 progress rendering. */
export const runWithProgress = async (
  config: ComplianceConfig,
  label: string,
  renderMode: RenderMode,
): Promise<PipelineResult> => {
  let pipelineResult: PipelineResult | undefined;

  const tasks = new Listr(
    [
      {
        title: label,
        task: async (_ctx, task) => {
          pipelineResult = await runComplianceTests(config, (progress: StepProgress) => {
            if (progress.status === 'running') {
              task.title = `${label}: ${progress.step}...`;
            } else if (progress.status !== 'pending') {
              task.output = formatStep(progress);
            }
          });

          const passed = pipelineResult.steps.filter(s => s.status === 'passed').length;
          const failed = pipelineResult.steps.filter(s => s.status === 'failed').length;
          const statusMark = pipelineResult.status === 'passed' ? '\u2713' : '\u2717';
          task.title = `${statusMark} ${label} \u2014 ${passed} passed, ${failed} failed (${pipelineResult.duration}ms)`;
        },
        rendererOptions: { bottomBar: Infinity },
      },
    ],
    {
      renderer: resolveRenderer(renderMode),
      rendererOptions: defaultRendererOptions,
    },
  );

  await tasks.run();
  return pipelineResult!;
};

/** Run multiple config entries sequentially with listr2 progress rendering. */
export const runConfigEntries = async (
  entries: ReadonlyArray<{ readonly config: ComplianceConfig; readonly label: string }>,
  renderMode: RenderMode,
): Promise<ReadonlyArray<PipelineResult>> => {
  const results: PipelineResult[] = [];

  const tasks = new Listr(
    entries.map(({ config, label }) => ({
      title: label,
      task: async (_ctx: unknown, task: { title: string; output: string }) => {
        const result = await runComplianceTests(config, (progress: StepProgress) => {
          if (progress.status === 'running') {
            task.title = `${label}: ${progress.step}...`;
          } else if (progress.status !== 'pending') {
            task.output = formatStep(progress);
          }
        });

        results.push(result);

        const passed = result.steps.filter(s => s.status === 'passed').length;
        const failed = result.steps.filter(s => s.status === 'failed').length;
        const statusMark = result.status === 'passed' ? '\u2713' : '\u2717';
        task.title = `${statusMark} ${label} \u2014 ${passed} passed, ${failed} failed (${result.duration}ms)`;
      },
      rendererOptions: { bottomBar: Infinity },
    })),
    {
      concurrent: false,
      renderer: resolveRenderer(renderMode),
      rendererOptions: defaultRendererOptions,
    },
  );

  await tasks.run();
  return results;
};
