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
    case 'incomplete': return '\u25D0'; // \u25D0 \u2014 ran out of time; partial results, rest not tested
    case 'skipped': return '-';
    case 'running': return '\u25CB';
    case 'pending': return '\u00B7';
  }
};

/** Human-friendly duration: "888ms", "1.6s", "3m31s" (matches the run-total format). */
export const humanizeDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m${rem.toString().padStart(2, '0')}s`;
};

/** Format a completed step as a one-line summary. */
const formatStep = (progress: StepProgress): string => {
  const icon = statusIcon(progress.status);
  const duration = progress.duration ? ` (${humanizeDuration(progress.duration)})` : '';
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

/** Interactive spinner title on a *running* update: prefer the step's live message (e.g. "Sampling Property…",
 *  "Testing Member…") so a long-running step shows WHAT is currently running, not just its name. Falls back to
 *  the step name, and ignores structured JSON detail messages (e.g. DD replication-progress) so they don't
 *  render raw. */
const runningTitle = (label: string, progress: StepProgress): string => {
  const msg = progress.message?.trim();
  return msg && !msg.startsWith('{') ? `${label}: ${msg}` : `${label}: ${progress.step}...`;
};

/** Collect a concise per-scenario failure list from a completed run: `Resource · scenario: message`. Reads the
 *  per-resource reports on the context (Core / Add-Edit / EntityEvent) and falls back to step-level errors. */
export const collectFailures = (result: PipelineResult): ReadonlyArray<string> => {
  const ctx = result.context as Record<string, unknown>;
  const reports = ctx.resourceReports as ReadonlyArray<{
    readonly resource?: string;
    readonly scenarios?: ReadonlyArray<{
      readonly name?: string; readonly tag?: string; readonly passed?: boolean; readonly skipped?: boolean;
      readonly assertions?: ReadonlyArray<{ readonly passed?: boolean; readonly message?: string; readonly description?: string }>;
    }>;
  }> | undefined;

  const fromReports: string[] = [];
  if (Array.isArray(reports)) {
    for (const r of reports) {
      for (const s of r.scenarios ?? []) {
        if (s.passed !== false || s.skipped) continue;
        const assertions = (s.assertions ?? []) as ReadonlyArray<{ readonly passed?: boolean; readonly message?: string; readonly description?: string }>;
        const msgs = assertions
          .filter(a => a.passed === false)
          .map(a => a.description ?? a.message)
          .filter((m): m is string => !!m);
        const detail = msgs.length ? `: ${msgs.slice(0, 2).join('; ')}` : '';
        fromReports.push(`${r.resource ?? 'Resource'} · ${s.name ?? s.tag ?? 'scenario'}${detail}`);
      }
    }
  }
  if (fromReports.length > 0) return fromReports;

  // Fallback: step-level errors (a failed metadata/service step, or endorsements without resource reports).
  const fromSteps: string[] = [];
  for (const step of result.steps) {
    if (step.status === 'failed') for (const e of step.errors ?? []) fromSteps.push(`${step.name}: ${e}`);
  }
  return fromSteps;
};

/** After the live render, print the reports location and — on a non-passing run — a concise failure summary. */
const printRunSummary = (result: PipelineResult, renderMode: RenderMode): void => {
  if (renderMode === 'silent') return;
  const outputPath = (result.context as Record<string, unknown>).outputPath;
  if (typeof outputPath === 'string') console.log(`Reports → ${outputPath}`);
  if (result.status === 'passed') return;
  const failures = collectFailures(result);
  if (failures.length === 0) return;
  console.log(`Failures (${failures.length}):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
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
              task.title = runningTitle(label, progress);
              const msg = progress.message?.trim();
              // Batch (--verbose): also emit the per-resource message as a log line so the long scenarios
              // step isn't silent for minutes (the interactive spinner shows it via the title instead).
              if (renderMode === 'verbose' && msg && !msg.startsWith('{')) task.output = `\u25cb ${msg}`;
            } else if (progress.status !== 'pending') {
              task.output = formatStep(progress);
            }
          });

          const passed = pipelineResult.steps.filter(s => s.status === 'passed').length;
          const failed = pipelineResult.steps.filter(s => s.status === 'failed').length;
          const statusMark = pipelineResult.status === 'passed' ? '\u2713' : pipelineResult.status === 'incomplete' ? '\u25d0' : '\u2717';
          task.title = `${statusMark} ${label} \u2014 ${passed} passed, ${failed} failed (${humanizeDuration(pipelineResult.duration)})`;
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
  printRunSummary(pipelineResult!, renderMode);
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
            task.title = runningTitle(label, progress);
            const msg = progress.message?.trim();
            if (renderMode === 'verbose' && msg && !msg.startsWith('{')) task.output = `\u25cb ${msg}`;
          } else if (progress.status !== 'pending') {
            task.output = formatStep(progress);
          }
        });

        results.push(result);

        const passed = result.steps.filter(s => s.status === 'passed').length;
        const failed = result.steps.filter(s => s.status === 'failed').length;
        const statusMark = result.status === 'passed' ? '\u2713' : result.status === 'incomplete' ? '\u25d0' : '\u2717';
        task.title = `${statusMark} ${label} \u2014 ${passed} passed, ${failed} failed (${humanizeDuration(result.duration)})`;
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
  for (const result of results) printRunSummary(result, renderMode);
  return results;
};
