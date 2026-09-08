/**
 * Progress rendering bridge — maps SDK ProgressCallback to listr2 tasks.
 */

import chalk from 'chalk';
import {
  LISTR_LOGGER_STDERR_LEVELS,
  Listr,
  ListrLogLevels,
  ListrLogger,
  PRESET_TIMER,
  Spinner,
  type ListrDefaultRendererOptions,
  type ListrVerboseRendererOptions,
} from 'listr2';
import { runComplianceTests } from '../sdk/index.js';
import { RUN_ADD_EDIT_SCENARIOS, RUN_CORE_SCENARIOS, RUN_ENTITY_EVENT_SCENARIOS } from '../sdk/step-names.js';
import type { ComplianceConfig, CoreProgressDetail, CoreResourcePhase, PipelineResult, StepProgress } from '../sdk/types.js';

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

interface CoreResourceState {
  readonly phase: CoreResourcePhase;
  readonly counts?: { readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly outcome?: 'passed' | 'failed' | 'skipped' | 'not-applicable';
  readonly note?: string;
}

/** A live per-resource view for the Web API Core scenarios step — the CLI-friendly mirror of the DD run
 *  display. Pure state: `apply` folds {@link CoreProgressDetail} events, `render` returns the current
 *  multi-line block (one line per resource + a grey "currently requesting" line). Sequential run, so one
 *  resource is sampling/testing at a time; the rest are queued or done. */
export const createCoreProgressView = () => {
  const order: string[] = [];
  const state = new Map<string, CoreResourceState>();
  let currentUrl: string | undefined;
  let currentMethod = 'GET';

  const apply = (d: CoreProgressDetail): void => {
    if (d.event === 'init') {
      for (const r of d.resources ?? []) if (!state.has(r)) { order.push(r); state.set(r, { phase: 'queued' }); }
    } else if (d.event === 'phase' && d.resource) {
      if (!state.has(d.resource)) order.push(d.resource);
      state.set(d.resource, { phase: d.phase ?? 'queued', counts: d.counts, outcome: d.outcome, note: d.note });
      if (d.phase === 'done') currentUrl = undefined; // a finished resource clears the stale request line
    } else if (d.event === 'request' && d.url) {
      currentUrl = d.url;
      currentMethod = d.method ?? 'GET';
    }
  };

  const icon = (s: CoreResourceState): string => {
    if (s.phase !== 'done') return s.phase === 'queued' ? chalk.dim('·') : chalk.cyan('○');
    switch (s.outcome) {
      case 'failed': return chalk.red('✗');
      case 'skipped': return chalk.yellow('-');
      case 'not-applicable': return chalk.dim('·');
      default: return chalk.green('✓');
    }
  };

  const phaseWord = (s: CoreResourceState): string => {
    if (s.phase === 'queued') return chalk.dim('queued');
    if (s.phase === 'sampling') return chalk.cyan('sampling…');
    if (s.phase === 'testing') return chalk.cyan('testing…');
    return s.note ? chalk.dim(s.note) : ''; // done with no counts (masked / not-applicable / skipped)
  };

  // The resources are siblings (top level, NOT expansions), so lay them out as an aligned GRID — name, then
  // passed/total, then failed, then skipped, each column lined up. Indentation/nesting is reserved for actual
  // expansions later. Widths are computed off plain text; chalk color is applied after padding so ANSI codes
  // never throw off the alignment.
  const render = (): string => {
    if (order.length === 0) return '';
    const rows = order.map(r => ({ r, s: state.get(r)! }));
    const nameW = Math.max(...rows.map(x => x.r.length));
    const counts = rows.filter(x => x.s.phase === 'done' && x.s.counts).map(x => x.s.counts!);
    const numW = (
      pick: (c: { passed: number; failed: number; skipped: number }) => number,
      only?: (c: { passed: number; failed: number; skipped: number }) => boolean,
    ): number => {
      const arr = (only ? counts.filter(only) : counts).map(pick);
      return arr.length ? Math.max(...arr.map(n => String(n).length)) : 0;
    };
    const pW = numW(c => c.passed);
    const tW = numW(c => c.passed + c.failed + c.skipped);
    const fW = numW(c => c.failed, c => c.failed > 0);
    const sW = numW(c => c.skipped, c => c.skipped > 0);
    // A fixed-width count cell: colored "N unit" when N>0, else blank of the same width so the next column aligns.
    const cell = (n: number, unit: string, width: number, color: (t: string) => string): string =>
      width === 0 ? '' : n > 0 ? color(`${String(n).padStart(width)} ${unit}`) : ' '.repeat(width + 1 + unit.length);

    const lines = rows.map(({ r, s }) => {
      const head = `${icon(s)} ${r.padEnd(nameW)}`;
      if (s.phase === 'done' && s.counts) {
        const c = s.counts;
        const tally = `${String(c.passed).padStart(pW)}/${String(c.passed + c.failed + c.skipped).padStart(tW)}`;
        return `${head}   ${tally}   ${cell(c.failed, 'failed', fW, chalk.red)}  ${cell(c.skipped, 'skipped', sW, chalk.dim)}`.replace(/\s+$/, '');
      }
      return `${head}   ${phaseWord(s)}`.replace(/\s+$/, '');
    });
    const grid = lines.join('\n');
    // The current request sits one line below the grid, led by its HTTP verb (reusable for GET/PATCH/POST/…).
    // listr2 filters empty and whitespace-only output lines, so a plain blank line vanishes — a zero-width space
    // (U+200B) is not whitespace, so the separator survives and still renders invisibly as a blank line.
    const gap = '\u200B'; // U+200B zero-width space
    return currentUrl ? `${grid}\n${gap}\n${chalk.gray(`→ ${currentMethod} ${currentUrl}`)}` : grid;
  };

  return { apply, render, hasData: (): boolean => order.length > 0 };
};

/** Select listr2 renderer based on render mode. */
const resolveRenderer = (mode: RenderMode): 'default' | 'verbose' | 'silent' => {
  switch (mode) {
    case 'default': return 'default';
    case 'verbose': return 'verbose';
    case 'silent': return 'silent';
  }
};

/** The running-task spinner: the RESO mark, rotating. A terminal can't rotate a glyph, so we flip a heavy X to
 *  a heavy plus — the same mark turned 45° — and back. No eight-point star in between (that starburst read as
 *  the Claude sparkle); this is a crisp X↔+ flip. Each frame is held a couple of ticks so it flips deliberately
 *  rather than strobing, and the render still refreshes at the spinner's base interval. Settles to ✓/✗ on done. */
class ResoSpinner extends Spinner {
  protected readonly spinner = ['✖', '✖', '✚', '✚']; // ✖ heavy-X ↔ ✚ heavy-plus, each held one extra tick
}

/** Shared renderer options for the default renderer. */
const defaultRendererOptions: ListrDefaultRendererOptions = {
  timer: PRESET_TIMER,
  spinner: new ResoSpinner(),
  // A non-passing run throws to flip the parent task glyph to ✗; keep the "N passed, M failed" title and
  // suppress the raw error text — the concise failure list is printed by printRunSummary instead.
  showErrorMessage: false,
};

/** Options for the verbose (non-TTY, `--verbose`) renderer. listr2's stock verbose logger prefixes every line
 *  with a bracketed level label ([OUTPUT], [STARTED], …); the OUTPUT lines dominate a run and their label is
 *  noise. Replace that slot with a dim ISO-8601 timestamp — far more useful for timing a slow server. The
 *  task-output lines already carry their own ✓/✗/○/→ glyph, so we blank listr2's OUTPUT marker (useIcons +
 *  an empty OUTPUT icon) and let the line read "[<iso>] <message>". Lifecycle levels keep their glyph. */
const verboseRendererOptions: ListrVerboseRendererOptions = {
  logger: new ListrLogger({ useIcons: true, toStderr: LISTR_LOGGER_STDERR_LEVELS }),
  timestamp: { condition: true, field: () => new Date().toISOString(), format: () => chalk.dim },
  icon: { [ListrLogLevels.OUTPUT]: '' },
};

/** Renderer options per mode: verbose gets the timestamped logger; default/silent keep the interactive set. */
const resolveRendererOptions = (mode: RenderMode): ListrDefaultRendererOptions | ListrVerboseRendererOptions =>
  mode === 'verbose' ? verboseRendererOptions : defaultRendererOptions;

/** Interactive spinner title on a *running* update: prefer the step's live message (e.g. "Sampling Property…",
 *  "Testing Member…") so a long-running step shows WHAT is currently running, not just its name. Falls back to
 *  the step name, and ignores structured JSON detail messages (e.g. DD replication-progress) so they don't
 *  render raw. */
const runningTitle = (label: string, progress: StepProgress): string => {
  const msg = progress.message?.trim();
  return msg && !msg.startsWith('{') ? `${label}: ${msg}` : `${label}: ${progress.step}...`;
};

/** Shared progress → listr2 handler. Renders the Web API Core per-resource tree (default mode) or clean
 *  per-resource log lines (verbose) from {@link CoreProgressDetail}, and falls back to the step-line
 *  rendering for the other endorsements and the pre-scenario steps. */
const handleProgress = (
  task: { title: string; output: string },
  label: string,
  renderMode: RenderMode,
  view: ReturnType<typeof createCoreProgressView>,
) => (progress: StepProgress): void => {
  const d = progress.detail;
  if (d?.kind === 'core-progress') {
    view.apply(d);
    task.title = runningTitle(label, progress);
    if (renderMode === 'verbose') {
      // A scrolling log can't show a live tree, so emit the meaningful transitions: a resource finishing, and
      // (dimmed) the request currently in flight so you can see what's being tested.
      if (d.event === 'phase' && d.resource && d.phase === 'done') {
        const c = d.counts;
        const tally = c ? ` — ${c.passed}/${c.passed + c.failed + c.skipped}${c.failed ? `, ${c.failed} failed` : ''}` : d.note ? ` — ${d.note}` : '';
        task.output = `○ ${d.resource}${tally}`;
      } else if (d.event === 'request' && d.url) {
        task.output = chalk.gray(`  → ${d.method ?? 'GET'} ${d.url}`);
      }
    } else {
      task.output = view.render();
    }
    return;
  }
  if (progress.status === 'running') {
    task.title = runningTitle(label, progress);
    const msg = progress.message?.trim();
    if (renderMode === 'verbose' && msg && !msg.startsWith('{')) task.output = `○ ${msg}`;
  } else if (progress.status !== 'pending') {
    // Once the resource tree is up (Core scenarios started), keep it in default mode — its final state is the
    // summary; otherwise show the completing step line (auth / service / metadata).
    task.output = renderMode === 'default' && view.hasData() ? view.render() : formatStep(progress);
  }
};

/** Shape of the per-resource scenario data the failure collectors read off the run context. */
interface ReportScenario {
  readonly name?: string;
  readonly tag?: string;
  readonly passed?: boolean;
  readonly skipped?: boolean;
  /** Optional-test scenarios (contains/startswith/endswith, …) never fail Core; kept out of the failure list. */
  readonly optional?: boolean;
  readonly assertions?: ReadonlyArray<{ readonly passed?: boolean; readonly message?: string; readonly description?: string }>;
  /** Non-gating warnings carried on the scenario (single-enum ne, $expand RRK, later Fast Track / DD 3.0 suggestions). */
  readonly warnings?: ReadonlyArray<string>;
}

/** `Resource · scenario: message` lines for failed, non-skipped scenarios matching `include`. */
const scenarioFailureLines = (result: PipelineResult, include: (s: ReportScenario) => boolean): ReadonlyArray<string> => {
  const reports = (result.context as Record<string, unknown>).resourceReports as
    | ReadonlyArray<{ readonly resource?: string; readonly scenarios?: ReadonlyArray<ReportScenario> }>
    | undefined;
  return (reports ?? []).flatMap(r =>
    (r.scenarios ?? [])
      .filter(s => s.passed === false && !s.skipped && include(s))
      .map(s => {
        const msgs = (s.assertions ?? [])
          .filter(a => a.passed === false)
          .map(a => a.description ?? a.message)
          .filter((m): m is string => !!m);
        const detail = msgs.length ? `: ${msgs.slice(0, 2).join('; ')}` : '';
        return `${r.resource ?? 'Resource'} · ${s.name ?? s.tag ?? 'scenario'}${detail}`;
      }),
  );
};

/** Concise REQUIRED-failure list from a completed run: `Resource · scenario: message`. Optional-test failures
 *  are excluded — they never fail Core (see {@link collectOptionalUnsupported}). Falls back to step-level errors
 *  (a failed metadata/service step, or endorsements without resource reports). */
export const collectFailures = (result: PipelineResult): ReadonlyArray<string> => {
  const fromReports = scenarioFailureLines(result, s => s.optional !== true);
  if (fromReports.length > 0) return fromReports;
  const fromSteps: string[] = [];
  for (const step of result.steps) {
    if (step.status === 'failed') for (const e of step.errors ?? []) fromSteps.push(`${step.name}: ${e}`);
  }
  return fromSteps;
};

/** Optional-test scenarios that did NOT pass — "Not Supported" / "Not Tested" (e.g. contains/startswith/endswith
 *  on a server that doesn't implement them). These never affect the Core verdict, so they're surfaced in their
 *  own section rather than mixed into {@link collectFailures}, where they read as real failures. */
export const collectOptionalUnsupported = (result: PipelineResult): ReadonlyArray<string> =>
  scenarioFailureLines(result, s => s.optional === true);

/** Non-gating warnings gathered across scenarios (`Resource · scenario: warning`). Verdict-neutral — surfaced on
 *  passing runs too, since they never affect the Core outcome (single-enum ne, $expand RRK, Fast Track suggestions). */
export const collectWarnings = (result: PipelineResult): ReadonlyArray<string> => {
  const reports = (result.context as Record<string, unknown>).resourceReports as
    | ReadonlyArray<{ readonly resource?: string; readonly scenarios?: ReadonlyArray<ReportScenario> }>
    | undefined;
  return (reports ?? []).flatMap(r =>
    (r.scenarios ?? []).flatMap(s =>
      (s.warnings ?? []).map(w => `${r.resource ?? 'Resource'} · ${s.name ?? s.tag ?? 'scenario'}: ${w}`),
    ),
  );
};

/** After the live render, print the reports location and — on a non-passing run — a concise failure summary. */
const printRunSummary = (result: PipelineResult, renderMode: RenderMode): void => {
  if (renderMode === 'silent') return;
  const outputPath = (result.context as Record<string, unknown>).outputPath;
  if (typeof outputPath === 'string') console.log(`Reports → ${outputPath}`);
  if (result.status !== 'passed') {
    const failures = collectFailures(result);
    if (failures.length > 0) {
      console.log(`Failures (${failures.length}):`);
      for (const f of failures) console.log(`  ✗ ${f}`);
    }
  }
  // Optional-test scenarios that weren't supported get their own section (distinct `·` marker + header) so they
  // never read as real Core failures. Shown on passing runs too — they're informational, not part of the verdict.
  const optionalUnsupported = collectOptionalUnsupported(result);
  if (optionalUnsupported.length > 0) {
    console.log(`Optional — not supported (${optionalUnsupported.length}):`);
    for (const f of optionalUnsupported) console.log(`  · ${f}`);
  }
  // Non-gating warnings — surfaced on EVERY run (they never move the verdict or exit code), so observe-then-flip
  // checks (single-enum ne) and future Fast Track / DD 3.0 suggestions are visible without failing anyone.
  const warnings = collectWarnings(result);
  if (warnings.length > 0) {
    console.log(`Warnings — non-gating (${warnings.length}):`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
};

/** Run-header summary: the scenario tally (passed/failed/skipped) from the scenario-running step, so the header
 *  matches the resource grid beneath it rather than counting pipeline steps. Falls back to the step tally when a
 *  run failed before scenarios ran (auth/service/metadata). */
const SCENARIO_STEP_NAMES: ReadonlyArray<string> = [RUN_CORE_SCENARIOS, RUN_ADD_EDIT_SCENARIOS, RUN_ENTITY_EVENT_SCENARIOS];
export const runHeaderSummary = (result: PipelineResult): string => {
  const c = result.steps.find(s => SCENARIO_STEP_NAMES.includes(s.name))?.counts as
    | { passed?: number; failed?: number; skipped?: number }
    | undefined;
  return c
    ? `${c.passed ?? 0} passed, ${c.failed ?? 0} failed, ${c.skipped ?? 0} skipped`
    : `${result.steps.filter(s => s.status === 'passed').length} passed, ${result.steps.filter(s => s.status === 'failed').length} failed`;
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
          const view = createCoreProgressView();
          pipelineResult = await runComplianceTests(config, handleProgress(task, label, renderMode, view));

          task.title = `${label} \u2014 ${runHeaderSummary(pipelineResult)} (${humanizeDuration(pipelineResult.duration)})`;
          // Reflect the verdict in the PARENT task glyph: a non-passing run throws so listr2 marks it \u2717
          // (a green \u2713 over failed resources was misleading). listr2's own glyph is the single status indicator.
          if (pipelineResult.status !== 'passed') throw new Error('non-passing run');
        },
        rendererOptions: { persistentOutput: true },
      },
    ],
    {
      exitOnError: false,
      renderer: resolveRenderer(renderMode),
      rendererOptions: resolveRendererOptions(renderMode),
    },
  );

  try { await tasks.run(); } catch { /* the failing run throws to mark the task \u2717; the verdict is in pipelineResult */ }
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
        const view = createCoreProgressView();
        const result = await runComplianceTests(config, handleProgress(task, label, renderMode, view));

        results.push(result);

        task.title = `${label} \u2014 ${runHeaderSummary(result)} (${humanizeDuration(result.duration)})`;
        if (result.status !== 'passed') throw new Error('non-passing run'); // parent glyph \u2192 \u2717 (see runWithProgress)
      },
      rendererOptions: { persistentOutput: true },
    })),
    {
      concurrent: false,
      exitOnError: false,
      renderer: resolveRenderer(renderMode),
      rendererOptions: resolveRendererOptions(renderMode),
    },
  );

  try { await tasks.run(); } catch { /* failing runs throw to mark their tasks \u2717; verdicts are in results */ }
  for (const result of results) printRunSummary(result, renderMode);
  return results;
};
