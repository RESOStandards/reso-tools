/**
 * Compare two certification runs: what changed, by how much, and whether that is better or worse.
 *
 * The first item of RESO Analytics' provider metrics. Pure over two {@link RunMetrics}; the CLI's
 * `reso-cert analytics compare` and the desktop's Compare page both render the {@link RunComparison} this returns, so
 * the two always show the same numbers.
 *
 * A change in a rate is stated in points (61.0% to 66.0% is up 5.0 points); a change in performance or size in
 * percent (10% faster). A change counts as "same" when it rounds to nothing at the precision it is shown at, and a
 * timing (response time, size, throughput) also when it is within {@link TIMING_TOLERANCE_PERCENT}: the same server
 * answers a little faster or slower from run to run, and that is not a change in the server. The change is still
 * reported with its size. Whether a change is significant for a provider is a criterion's question, not this one's.
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ALL_RESOURCES,
  METADATA_REPORT_FILE,
  type Metric,
  type MetricDirection,
  type MetricKind,
  type RunInfo,
  type RunMetrics,
  readRunMetrics
} from './run-metrics.js';

/** Bumped when a field of {@link RunComparison} changes meaning or goes away. Adding a field does not bump it. */
export const COMPARISON_SCHEMA_VERSION = 1;

export type ChangeUnit = 'count' | 'points' | 'percent';

/**
 * - `better` / `worse`: changed, in the direction the metric names.
 * - `changed`: changed, and the metric is neutral (more local fields is neither).
 * - `same`: the change rounds to nothing.
 * - `new`: measured in this run, not in the previous one. `gone`: the reverse.
 * - `not-measured`: in neither.
 */
export type ChangeVerdict = 'better' | 'worse' | 'changed' | 'same' | 'new' | 'gone' | 'not-measured';

export interface MetricChange {
  readonly id: string;
  readonly label: string;
  readonly scope: string;
  readonly kind: MetricKind;
  readonly better: MetricDirection;
  readonly before: number | null;
  readonly after: number | null;
  /** In {@link unit}: a count difference, points for a rate, percent for performance and size. */
  readonly change: number | null;
  readonly unit: ChangeUnit;
  readonly verdict: ChangeVerdict;
}

export interface RunComparison {
  readonly schemaVersion: typeof COMPARISON_SCHEMA_VERSION;
  /** The earlier run. */
  readonly before: RunInfo;
  /** The run being looked at. */
  readonly after: RunInfo;
  /** False when the two runs do not measure the same way (different Data Dictionary versions). */
  readonly comparable: boolean;
  /** Plain sentences about anything that affects how to read the changes. */
  readonly notes: ReadonlyArray<string>;
  readonly summary: { readonly better: number; readonly worse: number; readonly changed: number; readonly same: number };
  readonly changes: ReadonlyArray<MetricChange>;
}

// ── Change arithmetic ──

const unitOf = (kind: MetricKind): ChangeUnit => (kind === 'count' ? 'count' : kind === 'rate' ? 'points' : 'percent');

/** Rounded to the precision a report shows the change at: whole counts, a tenth of a point or a percent. */
const roundChange = (unit: ChangeUnit, value: number): number => (unit === 'count' ? Math.round(value) : Math.round(value * 10) / 10);

const changeOf = (unit: ChangeUnit, before: number, after: number): number | null => {
  if (unit === 'percent') return before !== 0 ? roundChange(unit, (100 * (after - before)) / before) : null;
  return roundChange(unit, after - before);
};

/**
 * Run-to-run variation in timings that is not counted as better or worse: a response time, size or throughput within
 * this many percent of the previous run's is the same. A default, not a rule of certification; criteria set their own.
 */
export const TIMING_TOLERANCE_PERCENT = 5;

const verdictOf = (
  kind: MetricKind,
  better: MetricDirection,
  before: number | null,
  after: number | null,
  change: number | null
): ChangeVerdict => {
  if (before === null && after === null) return 'not-measured';
  if (before === null) return 'new';
  if (after === null) return 'gone';
  // A percent change from zero has no size, so the verdict reads the values themselves.
  const direction = change ?? Math.sign(after - before);
  if (direction === 0 || Object.is(direction, -0)) return 'same';
  if (kind !== 'count' && kind !== 'rate' && change !== null && Math.abs(change) <= TIMING_TOLERANCE_PERCENT) return 'same';
  if (better === 'neutral') return 'changed';
  return direction > 0 === (better === 'higher') ? 'better' : 'worse';
};

const keyOf = (m: Pick<Metric, 'scope' | 'id'>): string => `${m.scope}|${m.id}`;

const changeFor = (before: Metric | undefined, after: Metric | undefined): MetricChange | undefined => {
  const definition = after ?? before;
  if (definition === undefined) return undefined;
  const unit = unitOf(definition.kind);
  const b = before?.value ?? null;
  const a = after?.value ?? null;
  const change = a !== null && b !== null ? changeOf(unit, b, a) : null;
  return {
    id: definition.id,
    label: definition.label,
    scope: definition.scope,
    kind: definition.kind,
    better: definition.better,
    before: b,
    after: a,
    change,
    unit,
    verdict: verdictOf(definition.kind, definition.better, b, a, change)
  };
};

// ── Notes ──

const connectionOf = (run: RunInfo): string | null =>
  run.providerUoi && run.recipientUoi ? `${run.providerUoi}-${run.providerUsi ?? ''} → ${run.recipientUoi}` : null;

const resourcesIn = (metrics: RunMetrics): ReadonlySet<string> =>
  new Set(metrics.metrics.map(m => m.scope).filter(scope => scope !== ALL_RESOURCES));

const notesFor = (before: RunMetrics, after: RunMetrics): ReadonlyArray<string> => {
  const b = before.run;
  const a = after.run;
  const added = [...resourcesIn(after)].filter(r => !resourcesIn(before).has(r));
  const removed = [...resourcesIn(before)].filter(r => !resourcesIn(after).has(r));
  return [
    ...(b.version !== a.version
      ? [
          `The runs test different Data Dictionary versions (${b.version} and ${a.version}). Standardization is measured against each version's own reference, so rates are not like for like.`
        ]
      : []),
    ...(connectionOf(b) !== null && connectionOf(a) !== null && connectionOf(b) !== connectionOf(a)
      ? [`The runs are for different connections (${connectionOf(b)} and ${connectionOf(a)}).`]
      : []),
    ...(b.generatedOn !== null && a.generatedOn !== null && b.generatedOn > a.generatedOn
      ? [`The run compared as the previous one is the newer of the two (${b.generatedOn} after ${a.generatedOn}).`]
      : []),
    ...(!b.measured.availability
      ? ['The previous run has no data availability report, so its availability and performance were not measured.']
      : []),
    ...(!a.measured.availability
      ? ['This run has no data availability report, so its availability and performance were not measured.']
      : []),
    ...(added.length > 0 ? [`Resources new in this run: ${added.join(', ')}.`] : []),
    ...(removed.length > 0 ? [`Resources no longer in this run: ${removed.join(', ')}.`] : [])
  ];
};

// ── Comparing ──

/** Compare two runs' metrics. Pure: the order of the changes follows this run's metrics, then any only the previous run had. */
export const compareRunMetrics = (before: RunMetrics, after: RunMetrics): RunComparison => {
  const beforeByKey = new Map(before.metrics.map(m => [keyOf(m), m] as const));
  const afterKeys = new Set(after.metrics.map(keyOf));
  const changes = [
    ...after.metrics.map(m => changeFor(beforeByKey.get(keyOf(m)), m)),
    ...before.metrics.filter(m => !afterKeys.has(keyOf(m))).map(m => changeFor(m, undefined))
  ].filter((c): c is MetricChange => c !== undefined);

  const count = (verdict: ChangeVerdict): number => changes.filter(c => c.verdict === verdict).length;
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    before: before.run,
    after: after.run,
    comparable: before.run.version === after.run.version,
    notes: notesFor(before, after),
    summary: { better: count('better'), worse: count('worse'), changed: count('changed'), same: count('same') },
    changes
  };
};

// ── Finding the previous run ──

const ARCHIVED_DIR = 'archived';
const CURRENT_DIR = 'current';

const directoriesIn = async (path: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter(e => e.isDirectory()).map(e => e.name);
};

/**
 * The run before this one for the same connection, from the results tree: for `…/current`, the newest run under
 * `…/archived`; for `…/archived/{timestamp}`, the newest one older than it. Undefined when there is none, or when
 * the run is not in a results tree. Archive names are ISO timestamps, so they sort in time order as text.
 */
export const findPreviousRun = async (runPath: string): Promise<string | undefined> => {
  const path = resolve(runPath);
  const isCurrent = basename(path) === CURRENT_DIR;
  const isArchived = basename(dirname(path)) === ARCHIVED_DIR;
  if (!isCurrent && !isArchived) return undefined;
  const archive = isCurrent ? join(dirname(path), ARCHIVED_DIR) : dirname(path);
  const older = (await directoriesIn(archive)).filter(name => isCurrent || name < basename(path)).sort((a, b) => b.localeCompare(a));
  const candidates = older.map(name => join(archive, name));
  // A directory with no metadata report (an interrupted run, a different endorsement) is not a previous run.
  const hasMetadata = await Promise.all(
    candidates.map(candidate =>
      stat(join(candidate, METADATA_REPORT_FILE)).then(
        s => s.isFile(),
        () => false
      )
    )
  );
  return candidates.find((_, i) => hasMetadata[i]);
};

const NO_PREVIOUS_RUN = 'NO_PREVIOUS_RUN';

/** The error {@link compareRuns} throws when there is no earlier run to compare with. */
export const isNoPreviousRunError = (error: unknown): error is Error & { readonly code: typeof NO_PREVIOUS_RUN } =>
  error instanceof Error && (error as Error & { code?: unknown }).code === NO_PREVIOUS_RUN;

/**
 * Compare a run with an earlier one: with `previousPath`, that run; without it, the previous run for the same
 * connection. Throws an error {@link isNoPreviousRunError} recognizes when there is none to compare with.
 */
export const compareRuns = async (runPath: string, previousPath?: string): Promise<RunComparison> => {
  // The run itself first: a path that holds no run is an error, not a run with nothing before it.
  const after = await readRunMetrics(runPath);
  const previous = previousPath ?? (await findPreviousRun(runPath));
  if (previous === undefined) {
    throw Object.assign(new Error(`There is no earlier run to compare ${resolve(runPath)} with. Give one as the second argument.`), {
      code: NO_PREVIOUS_RUN
    });
  }
  return compareRunMetrics(await readRunMetrics(previous), after);
};
