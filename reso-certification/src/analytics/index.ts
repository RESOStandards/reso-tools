/**
 * RESO Analytics: metrics from certification runs, for providers to see how their runs change.
 *
 * Compare is the first item: {@link readRunMetrics} turns a run directory into metrics, {@link compareRunMetrics}
 * compares two, and the CLI and the desktop each render the result.
 */

export {
  COMPARISON_SCHEMA_VERSION,
  TIMING_TOLERANCE_PERCENT,
  compareRunMetrics,
  compareRuns,
  findPreviousRun,
  isNoPreviousRunError
} from './compare.js';
export type { ChangeUnit, ChangeVerdict, MetricChange, RunComparison } from './compare.js';
export { formatChange, formatValue, renderComparisonText } from './render-text.js';
export type { RenderOptions } from './render-text.js';
export {
  ALL_RESOURCES,
  METRIC_DEFINITIONS,
  readRunMetrics,
  runMetricsFromReports,
  runPlacement
} from './run-metrics.js';
export type { Metric, MetricDirection, MetricKind, RunInfo, RunMetrics, RunReports } from './run-metrics.js';
