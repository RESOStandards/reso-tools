/**
 * The comparison as text, for a person at a terminal and for an AI agent reading the output.
 *
 * Every value carries its unit, every change says its direction in words ("up 5.0 points", "12.0% faster") and every
 * line ends with its verdict, so nothing depends on color or position alone. The first lines say which two runs were
 * compared and the tally; notes that affect how to read the changes come last. `--json` gives the same comparison
 * whole, for scripts.
 */

import { COMPARISON_SCHEMA_VERSION, type MetricChange, type RunComparison, TIMING_TOLERANCE_PERCENT } from './compare.js';
import { ALL_RESOURCES, type MetricKind } from './run-metrics.js';

const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const TWO_DECIMALS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Bytes in a unit people read: 1 KB = 1,000 bytes. */
const formatBytes = (bytes: number): string => {
  if (bytes < 1000) return `${COUNT_FORMAT.format(bytes)} B`;
  if (bytes < 1_000_000) return `${ONE_DECIMAL.format(bytes / 1000)} KB`;
  return `${ONE_DECIMAL.format(bytes / 1_000_000)} MB`;
};

/** A metric's value with its unit. */
export const formatValue = (kind: MetricKind, value: number | null): string => {
  if (value === null) return 'not measured';
  switch (kind) {
    case 'count':
      return COUNT_FORMAT.format(value);
    case 'rate':
      return `${ONE_DECIMAL.format(value)}%`;
    case 'duration':
      // A tenth of a millisecond under 100 ms, so two short times that differ do not print the same.
      return value < 100
        ? `${ONE_DECIMAL.format(value)} ms`
        : value < 1000
          ? `${COUNT_FORMAT.format(value)} ms`
          : `${TWO_DECIMALS.format(value / 1000)} s`;
    case 'size':
      return formatBytes(value);
    case 'throughput':
      return `${formatBytes(value)}/s`;
  }
};

const PERCENT_WORDS: Readonly<Record<MetricKind, readonly [up: string, down: string]>> = {
  duration: ['slower', 'faster'],
  size: ['larger', 'smaller'],
  throughput: ['higher', 'lower'],
  count: ['more', 'fewer'],
  rate: ['higher', 'lower']
};

/** The change in words: "up 31", "up 5.0 points", "12.0% faster". */
export const formatChange = (c: MetricChange): string => {
  if (c.verdict === 'not-measured') return 'not measured in either run';
  if (c.verdict === 'new') return 'new in this run';
  if (c.verdict === 'gone') return 'not in this run';
  // A timing within the tolerance is the same, but says how far it moved.
  if (c.verdict === 'same' && (c.change === null || c.change === 0)) return 'no change';
  if (c.change === null) return c.before === 0 ? 'up from zero' : 'down to zero';
  const magnitude = Math.abs(c.change);
  const up = c.change > 0;
  switch (c.unit) {
    case 'count':
      return `${up ? 'up' : 'down'} ${COUNT_FORMAT.format(magnitude)}`;
    case 'points':
      return `${up ? 'up' : 'down'} ${ONE_DECIMAL.format(magnitude)} points`;
    case 'percent': {
      const [upWord, downWord] = PERCENT_WORDS[c.kind];
      return `${ONE_DECIMAL.format(magnitude)}% ${up ? upWord : downWord}`;
    }
  }
};

const VERDICT_WORDS: Readonly<Record<MetricChange['verdict'], string>> = {
  better: 'better',
  worse: 'worse',
  changed: 'changed',
  same: 'same',
  new: 'new',
  gone: 'gone',
  'not-measured': '–'
};

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - text.length));

const rows = (changes: ReadonlyArray<MetricChange>): ReadonlyArray<string> => {
  const cells = changes.map(
    c => [c.label, `${formatValue(c.kind, c.before)} → ${formatValue(c.kind, c.after)}`, formatChange(c), VERDICT_WORDS[c.verdict]] as const
  );
  const widths = [0, 1, 2].map(i => Math.max(...cells.map(cell => cell[i].length)));
  return cells.map(
    ([label, values, change, verdict]) => `  ${pad(label, widths[0])}  ${pad(values, widths[1])}  ${pad(change, widths[2])}  ${verdict}`
  );
};

const isQuiet = (c: MetricChange): boolean => c.verdict === 'same' || c.verdict === 'not-measured';

const plural = (n: number, one: string, many: string): string => `${COUNT_FORMAT.format(n)} ${n === 1 ? one : many}`;

export interface RenderOptions {
  /** Show every metric for every resource, not only the ones that changed. */
  readonly all?: boolean;
}

/** The whole comparison as text. Deterministic, so a test or an agent can rely on its shape. */
export const renderComparisonText = (comparison: RunComparison, options: RenderOptions = {}): string => {
  const { before, after, summary, changes, notes } = comparison;
  const connection =
    after.providerUoi && after.recipientUoi
      ? ` · ${after.providerUoi}${after.providerUsi ? `-${after.providerUsi}` : ''} → ${after.recipientUoi}`
      : '';
  const header = [
    `${after.endorsement} ${after.version}${connection}`,
    `This run      ${after.generatedOn ?? 'date unknown'}   ${after.path}`,
    `Previous run  ${before.generatedOn ?? 'date unknown'}   ${before.path}`,
    '',
    `Better: ${COUNT_FORMAT.format(summary.better)}. Worse: ${COUNT_FORMAT.format(summary.worse)}. Changed, neither better nor worse: ${COUNT_FORMAT.format(summary.changed)}. The same: ${COUNT_FORMAT.format(summary.same)}.`,
    ...(comparison.comparable ? [] : ['These runs do not measure the same way; read the notes before the numbers.'])
  ];

  const scopes = [...new Set(changes.map(c => c.scope))];
  const sections = scopes.flatMap(scope => {
    const inScope = changes.filter(c => c.scope === scope);
    // Every resource-wide metric is shown; for a single resource, only what changed unless asked for everything.
    const shown = scope === ALL_RESOURCES || options.all ? inScope : inScope.filter(c => !isQuiet(c));
    const hidden = inScope.length - shown.length;
    if (shown.length === 0 && scope !== ALL_RESOURCES) return [];
    return [
      '',
      scope === ALL_RESOURCES ? 'All resources' : scope,
      ...rows(shown),
      ...(hidden > 0 ? [`  (${plural(hidden, 'metric', 'metrics')} unchanged)`] : [])
    ];
  });
  const unchangedResources = scopes.filter(scope => scope !== ALL_RESOURCES && changes.filter(c => c.scope === scope).every(isQuiet));

  return [
    ...header,
    ...sections,
    ...(unchangedResources.length > 0 && !options.all ? ['', `Unchanged: ${unchangedResources.join(', ')}.`] : []),
    ...(notes.length > 0 ? ['', 'Notes', ...notes.map(note => `  - ${note}`)] : []),
    '',
    `Rates change in points; performance and size in percent, and a timing within ${TIMING_TOLERANCE_PERCENT}% counts as the same. Add --all for every metric of every resource, or --json for the comparison as JSON (schemaVersion ${COMPARISON_SCHEMA_VERSION}).`
  ].join('\n');
};
