/**
 * Progress rendering bridge — maps SDK ProgressCallback to listr2 tasks.
 */

import { parseReplicationProgress, summarizeReplicationProgress } from '@reso-standards/reso-common';
import chalk from 'chalk';
import {
  LISTR_LOGGER_STDERR_LEVELS,
  Listr,
  type ListrDefaultRendererOptions,
  ListrLogLevels,
  ListrLogger,
  type ListrVerboseRendererOptions,
  PRESET_TIMER,
  Spinner
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
    case 'passed':
      return '\u2713';
    case 'failed':
      return '\u2717';
    case 'incomplete':
      return '\u25D0'; // \u25D0 \u2014 ran out of time; partial results, rest not tested
    case 'skipped':
      return '-';
    case 'running':
      return '\u25CB';
    case 'pending':
      return '\u00B7';
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
  const message = progress.message ? ` \u2013 ${progress.message}` : '';
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
      for (const r of d.resources ?? [])
        if (!state.has(r)) {
          order.push(r);
          state.set(r, { phase: 'queued' });
        }
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
      case 'failed':
        return chalk.red('✗');
      case 'skipped':
        return chalk.yellow('-');
      case 'not-applicable':
        return chalk.dim('·');
      default:
        return chalk.green('✓');
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
      only?: (c: { passed: number; failed: number; skipped: number }) => boolean
    ): number => {
      const arr = (only ? counts.filter(only) : counts).map(pick);
      return arr.length ? Math.max(...arr.map(n => String(n).length)) : 0;
    };
    const pW = numW(c => c.passed);
    const tW = numW(c => c.passed + c.failed + c.skipped);
    const fW = numW(
      c => c.failed,
      c => c.failed > 0
    );
    const sW = numW(
      c => c.skipped,
      c => c.skipped > 0
    );
    // A fixed-width count cell: colored "N unit" when N>0, else blank of the same width so the next column aligns.
    const cell = (n: number, unit: string, width: number, color: (t: string) => string): string =>
      width === 0 ? '' : n > 0 ? color(`${String(n).padStart(width)} ${unit}`) : ' '.repeat(width + 1 + unit.length);

    const lines = rows.map(({ r, s }) => {
      const head = `${icon(s)} ${r.padEnd(nameW)}`;
      if (s.phase === 'done' && s.counts) {
        const c = s.counts;
        const tally = `${String(c.passed).padStart(pW)}/${String(c.passed + c.failed + c.skipped).padStart(tW)}`;
        return `${head}   ${tally}   ${cell(c.failed, 'failed', fW, chalk.red)}  ${cell(c.skipped, 'skipped', sW, chalk.dim)}`.replace(
          /\s+$/,
          ''
        );
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
    case 'default':
      return 'default';
    case 'verbose':
      return 'verbose';
    case 'silent':
      return 'silent';
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
  showErrorMessage: false
};

/** Options for the verbose (non-TTY, `--verbose`) renderer. listr2's stock verbose logger prefixes every line
 *  with a bracketed level label ([OUTPUT], [STARTED], …); the OUTPUT lines dominate a run and their label is
 *  noise. Replace that slot with a dim ISO-8601 timestamp — far more useful for timing a slow server. The
 *  task-output lines already carry their own ✓/✗/○/→ glyph, so we blank listr2's OUTPUT marker (useIcons +
 *  an empty OUTPUT icon) and let the line read "[<iso>] <message>". Lifecycle levels keep their glyph. */
const verboseRendererOptions: ListrVerboseRendererOptions = {
  logger: new ListrLogger({ useIcons: true, toStderr: LISTR_LOGGER_STDERR_LEVELS }),
  timestamp: { condition: true, field: () => new Date().toISOString(), format: () => chalk.dim },
  icon: { [ListrLogLevels.OUTPUT]: '' }
};

/** Renderer options per mode: verbose gets the timestamped logger; default/silent keep the interactive set. */
const resolveRendererOptions = (mode: RenderMode): ListrDefaultRendererOptions | ListrVerboseRendererOptions =>
  mode === 'verbose' ? verboseRendererOptions : defaultRendererOptions;

/** Renders the indented block shown beneath a run's title, for the CLI.
 *
 *  CLI-specific, hence the name: it returns an ANSI-colored string for listr2. A user interface renders
 *  from the SDK's `ProgressCallback` instead.
 *
 *  A provider CLAIMS an update, then renders it. The two are separate because `undefined` from `render`
 *  means "leave the block alone", which is not the same as "not mine" -- a verbose Core run only emits on
 *  some events, and an unclaimed update must still fall through to the default provider. */
interface CliProgressRenderer {
  readonly claims: (progress: StepProgress) => boolean;
  readonly render: (progress: StepProgress, renderMode: RenderMode) => string | undefined;
}

/** The inner-info line, defined once so every endorsement's lines up under its title.
 *
 *  NO leading indent. Both renderers supply their own: the interactive renderer prefixes task output with
 *  `\u203a` and indents it, and the verbose logger prefixes a timestamp. Adding spaces here produced
 *  `  \u203a   \u2192 text` -- three spaces and two glyphs. Core never showed it because its arrow line only
 *  runs in verbose, where there is no `\u203a`. */
const detailLine = (text: string): string => chalk.gray(`\u2192 ${text}`);

/** Web API Core's inner info: the live per-resource tree in the interactive renderer, or the meaningful
 *  transitions as log lines in verbose, where a scrolling log cannot show a tree. */
const coreProgressRenderer = (view: ReturnType<typeof createCoreProgressView>): CliProgressRenderer => ({
  claims: progress => progress.detail?.kind === 'core-progress',
  render: (progress, renderMode) => {
    const d = progress.detail;
    if (d?.kind !== 'core-progress') return undefined;
    view.apply(d);
    if (renderMode !== 'verbose') return view.render();
    if (d.event === 'phase' && d.resource && d.phase === 'done') {
      const c = d.counts;
      const tally = c
        ? ` \u2013 ${c.passed}/${c.passed + c.failed + c.skipped}${c.failed ? `, ${c.failed} failed` : ''}`
        : d.note
          ? ` \u2013 ${d.note}`
          : '';
      return `\u25cb ${d.resource}${tally}`;
    }
    if (d.event === 'request' && d.url) return detailLine(`${d.method ?? 'GET'} ${d.url}`);
    return undefined;
  }
});

/** Data Dictionary replication's inner info.
 *
 *  A replication step reports live telemetry as a JSON object in its message. This used to be thrown
 *  away -- the default renderer skips anything starting with `{` and shows the step name instead -- so a
 *  terminal run said "Fetching Lookup Resource..." while the same payload drew a per-resource bar chart in
 *  the browser. The shape, the parser and the formatters now live in `reso-common`, and both surfaces read
 *  the same one.
 *
 *  Claimed only when the message really is replication telemetry, so an ordinary message falls through. */
const replicationProgressRenderer = (): CliProgressRenderer => {
  const parse = (progress: StepProgress) => parseReplicationProgress(progress.message?.trim() ?? '');
  return {
    claims: progress => parse(progress) !== null,
    render: (progress, renderMode) => {
      const data = parse(progress);
      if (!data) return undefined;
      const summary = summarizeReplicationProgress(data);
      // An update with nothing quantified yet leaves the display alone rather than blanking it.
      if (!summary) return undefined;
      return renderMode === 'verbose' ? `\u25cb ${summary}` : detailLine(summary);
    }
  };
};

/** The default inner info, used by every endorsement that does not supply its own: the step's live message
 *  while running, then the completed step line. Structured JSON detail messages (Data Dictionary
 *  replication progress, for one) are not shown raw -- the step name stands in. */
const stepProgressRenderer = (view: ReturnType<typeof createCoreProgressView>): CliProgressRenderer => {
  // Local mutable state, scoped to this closure and never leaked: the last completed step line.
  //
  // `task.output` is a SINGLE slot. Before the title carried the running message, nothing wrote that slot
  // on a running update, so the last completed step sat there visibly -- which is why `\u2713 Service check`
  // stayed on screen. Moving the activity into the slot overwrote it on the next update and swallowed
  // every completed step. Both belong on screen, so the completed line is kept and reprinted above the
  // active one.
  let lastCompleted: string | undefined;
  return {
    claims: () => true,
    render: (progress, renderMode) => {
      const msg = progress.message?.trim();
      const shown = msg && !msg.startsWith('{') ? msg : undefined;
      if (progress.status === 'running') {
        // Verbose is a scrolling log, so each line stands on its own and keeps its own marker.
        if (renderMode === 'verbose') return shown ? `\u25cb ${shown}` : undefined;
        const active = detailLine(shown ?? `${progress.step}...`);
        return lastCompleted ? `${lastCompleted}\n${active}` : active;
      }
      if (progress.status === 'pending') return undefined;
      // Once the Core resource tree is up, its final state IS the summary; otherwise show the step line.
      const completed = renderMode === 'default' && view.hasData() ? view.render() : formatStep(progress);
      lastCompleted = completed;
      return completed;
    }
  };
};

/** Generic progress renderer. The title is always the run's identity and never changes mid-run; the body is
 *  whichever provider claims the update. An endorsement with its own inner info goes in the list ahead of
 *  `stepProgressRenderer`, which claims everything left over. */
const handleProgress = (
  task: { title: string; output: string },
  label: string,
  renderMode: RenderMode,
  view: ReturnType<typeof createCoreProgressView>
) => {
  // Built ONCE per run, not per event. They were being reallocated on every progress update, which was
  // wasteful and, more importantly, made it impossible for a renderer to remember anything between
  // updates -- which is exactly what keeping the last completed step needs.
  const renderers: ReadonlyArray<CliProgressRenderer> = [
    coreProgressRenderer(view),
    replicationProgressRenderer(),
    stepProgressRenderer(view)
  ];
  return (progress: StepProgress): void => {
    task.title = label;
    const claimed = renderers.find(r => r.claims(progress));
    const rendered = claimed?.render(progress, renderMode);
    if (rendered !== undefined) task.output = rendered;
  };
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
      })
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
    (r.scenarios ?? []).flatMap(s => (s.warnings ?? []).map(w => `${r.resource ?? 'Resource'} · ${s.name ?? s.tag ?? 'scenario'}: ${w}`))
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
    console.log(`Optional – not supported (${optionalUnsupported.length}):`);
    for (const f of optionalUnsupported) console.log(`  · ${f}`);
  }
  // Non-gating warnings — surfaced on EVERY run (they never move the verdict or exit code), so observe-then-flip
  // checks (single-enum ne) and future Fast Track / DD 3.0 suggestions are visible without failing anyone.
  const warnings = collectWarnings(result);
  if (warnings.length > 0) {
    console.log(`Non-gating warnings (${warnings.length}):`);
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
export const runWithProgress = async (config: ComplianceConfig, label: string, renderMode: RenderMode): Promise<PipelineResult> => {
  let pipelineResult: PipelineResult | undefined;

  const tasks = new Listr(
    [
      {
        title: label,
        task: async (_ctx, task) => {
          const view = createCoreProgressView();
          pipelineResult = await runComplianceTests(config, handleProgress(task, label, renderMode, view));

          task.title = `${label} \u2013 ${runHeaderSummary(pipelineResult)} (${humanizeDuration(pipelineResult.duration)})`;
          // Reflect the verdict in the PARENT task glyph: a non-passing run throws so listr2 marks it \u2717
          // (a green \u2713 over failed resources was misleading). listr2's own glyph is the single status indicator.
          if (pipelineResult.status !== 'passed') throw new Error('non-passing run');
        },
        rendererOptions: { persistentOutput: true }
      }
    ],
    {
      exitOnError: false,
      renderer: resolveRenderer(renderMode),
      rendererOptions: resolveRendererOptions(renderMode)
    }
  );

  try {
    await tasks.run();
  } catch {
    /* the failing run throws to mark the task \u2717; the verdict is in pipelineResult */
  }
  printRunSummary(pipelineResult!, renderMode);
  return pipelineResult!;
};

/** Run multiple config entries sequentially with listr2 progress rendering. */
export const runConfigEntries = async (
  entries: ReadonlyArray<{ readonly config: ComplianceConfig; readonly label: string }>,
  renderMode: RenderMode
): Promise<ReadonlyArray<PipelineResult>> => {
  const results: PipelineResult[] = [];

  const tasks = new Listr(
    entries.map(({ config, label }) => ({
      title: label,
      task: async (_ctx: unknown, task: { title: string; output: string }) => {
        const view = createCoreProgressView();
        const result = await runComplianceTests(config, handleProgress(task, label, renderMode, view));

        results.push(result);

        task.title = `${label} \u2013 ${runHeaderSummary(result)} (${humanizeDuration(result.duration)})`;
        if (result.status !== 'passed') throw new Error('non-passing run'); // parent glyph \u2192 \u2717 (see runWithProgress)
      },
      rendererOptions: { persistentOutput: true }
    })),
    {
      concurrent: false,
      exitOnError: false,
      renderer: resolveRenderer(renderMode),
      rendererOptions: resolveRendererOptions(renderMode)
    }
  );

  try {
    await tasks.run();
  } catch {
    /* failing runs throw to mark their tasks \u2717; verdicts are in results */
  }
  for (const result of results) printRunSummary(result, renderMode);
  return results;
};
