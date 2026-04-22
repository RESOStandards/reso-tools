/**
 * Certification Compare page — side-by-side comparison of new test
 * results against existing certified results.
 *
 * Shows deltas in coverage, standardization, availability, and
 * performance between the current run and the previous certified state.
 *
 * This is a stub with placeholder UI for layout review.
 */

import { useState } from 'react';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

// ── Types ────────────────────────────────────────────────────────────

interface ComparisonMetric {
  readonly label: string;
  readonly previous: number;
  readonly current: number;
  readonly unit: string;
  readonly higherIsBetter: boolean;
}

interface ResourceComparison {
  readonly resource: string;
  readonly previousFields: number;
  readonly currentFields: number;
  readonly previousStdRate: number;
  readonly currentStdRate: number;
  readonly previousAvailability: number;
  readonly currentAvailability: number;
}

// ── Fixture data ────────────────────────────────────────────────────

const SAMPLE_METRICS: ReadonlyArray<ComparisonMetric> = [
  { label: 'Total Fields', previous: 628, current: 691, unit: '', higherIsBetter: true },
  { label: 'RESO Fields', previous: 382, current: 413, unit: '', higherIsBetter: true },
  { label: 'Standardization', previous: 61, current: 66, unit: '%', higherIsBetter: true },
  { label: 'Fields with Data', previous: 523, current: 602, unit: '', higherIsBetter: true },
  { label: 'Lookups', previous: 1045, current: 1682, unit: '', higherIsBetter: true },
  { label: 'Schema Errors', previous: 0, current: 0, unit: '', higherIsBetter: false },
  { label: 'Avg Response Time', previous: 1.1, current: 0.18, unit: 's', higherIsBetter: false },
  { label: 'Throughput', previous: 450, current: 523, unit: 'KB/s', higherIsBetter: true },
];

const SAMPLE_RESOURCES: ReadonlyArray<ResourceComparison> = [
  { resource: 'Property', previousFields: 409, currentFields: 493, previousStdRate: 58, currentStdRate: 66, previousAvailability: 72, currentAvailability: 78 },
  { resource: 'Member', previousFields: 44, currentFields: 44, previousStdRate: 89, currentStdRate: 89, previousAvailability: 91, currentAvailability: 93 },
  { resource: 'Office', previousFields: 37, currentFields: 37, previousStdRate: 86, currentStdRate: 86, previousAvailability: 88, currentAvailability: 90 },
  { resource: 'Media', previousFields: 35, currentFields: 35, previousStdRate: 91, currentStdRate: 91, previousAvailability: 95, currentAvailability: 95 },
  { resource: 'OpenHouse', previousFields: 6, currentFields: 6, previousStdRate: 100, currentStdRate: 100, previousAvailability: 100, currentAvailability: 100 },
];

// ── Helpers ──────────────────────────────────────────────────────────

const delta = (prev: number, curr: number): number => curr - prev;
const deltaPercent = (prev: number, curr: number): number =>
  prev > 0 ? Math.round(((curr - prev) / prev) * 100) : curr > 0 ? 100 : 0;

const deltaColor = (d: number, higherIsBetter: boolean): string => {
  if (d === 0) return 'text-gray-500 dark:text-gray-400';
  const good = higherIsBetter ? d > 0 : d < 0;
  return good ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
};

const deltaArrow = (d: number): string => d > 0 ? '↑' : d < 0 ? '↓' : '–';

// ── Metric comparison row ───────────────────────────────────────────

const MetricRow = ({ metric }: { readonly metric: ComparisonMetric }) => {
  const d = delta(metric.previous, metric.current);
  const dp = deltaPercent(metric.previous, metric.current);
  const color = deltaColor(d, metric.higherIsBetter);
  const isGood = d === 0 ? null : (metric.higherIsBetter ? d > 0 : d < 0);

  return (
    <div className={`flex items-center justify-between py-3 px-3 -mx-3 rounded-lg ${
      isGood === true ? 'bg-green-50/50 dark:bg-green-900/10' :
      isGood === false ? 'bg-red-50/50 dark:bg-red-900/10' : ''
    }`}>
      <div className="flex items-center gap-2 min-w-0">
        {isGood !== null && (
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
            isGood ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
          }`}>
            {isGood ? 'Improved' : 'Degraded'}
          </span>
        )}
        <span className="text-sm text-gray-700 dark:text-gray-300">{metric.label}</span>
      </div>
      <div className="flex items-center gap-6 shrink-0 tabular-nums">
        <span className="text-sm text-gray-400 dark:text-gray-500 w-20 text-right">
          {metric.previous.toLocaleString()}{metric.unit}
        </span>
        <span className={`text-sm font-bold w-24 text-right ${color}`}>
          {metric.current.toLocaleString()}{metric.unit}
          <span className="ml-1 text-xs">
            {deltaArrow(d)} {d !== 0 && `${Math.abs(dp)}%`}
          </span>
        </span>
      </div>
    </div>
  );
};

// ── Resource comparison card ────────────────────────────────────────

const ResourceRow = ({ res }: { readonly res: ResourceComparison }) => {
  const fieldDelta = delta(res.previousFields, res.currentFields);
  const stdDelta = delta(res.previousStdRate, res.currentStdRate);
  const availDelta = delta(res.previousAvailability, res.currentAvailability);

  return (
    <div className="flex items-center gap-4 py-3">
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 w-24 shrink-0">{res.resource}</span>
      <div className="flex-1 grid grid-cols-3 gap-4 text-center text-xs">
        <div>
          <p className="text-gray-400 dark:text-gray-500">Fields</p>
          <p className={`font-semibold tabular-nums ${deltaColor(fieldDelta, true)}`}>
            {res.currentFields} <span className="text-[10px]">{deltaArrow(fieldDelta)}{fieldDelta !== 0 ? Math.abs(fieldDelta) : ''}</span>
          </p>
        </div>
        <div>
          <p className="text-gray-400 dark:text-gray-500">Standardization</p>
          <p className={`font-semibold tabular-nums ${deltaColor(stdDelta, true)}`}>
            {res.currentStdRate}% <span className="text-[10px]">{deltaArrow(stdDelta)}{stdDelta !== 0 ? `${Math.abs(stdDelta)}pts` : ''}</span>
          </p>
        </div>
        <div>
          <p className="text-gray-400 dark:text-gray-500">Availability</p>
          <p className={`font-semibold tabular-nums ${deltaColor(availDelta, true)}`}>
            {res.currentAvailability}% <span className="text-[10px]">{deltaArrow(availDelta)}{availDelta !== 0 ? `${Math.abs(availDelta)}pts` : ''}</span>
          </p>
        </div>
      </div>
    </div>
  );
};

// ── Main page ───────────────────────────────────────────────────────

export const ComparePage = () => {
  const improvedMetrics = SAMPLE_METRICS.filter(m => {
    const d = delta(m.previous, m.current);
    return d !== 0 && (m.higherIsBetter ? d > 0 : d < 0);
  });
  const degradedMetrics = SAMPLE_METRICS.filter(m => {
    const d = delta(m.previous, m.current);
    return d !== 0 && (m.higherIsBetter ? d < 0 : d > 0);
  });
  const unchangedMetrics = SAMPLE_METRICS.filter(m => delta(m.previous, m.current) === 0);

  return (
  <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
    <div className={`${PAGE_CONTAINER} pt-6 pb-20`}>
      {/* Header */}
      <div className="mb-6">
        <nav className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-1">
          <a href="/cert" className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Certification</a>
          <span className="text-gray-400 dark:text-gray-500">›</span>
          <a href="/cert/jobs" className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Jobs</a>
          <span className="text-gray-400 dark:text-gray-500">›</span>
          <span className="text-gray-700 dark:text-gray-300 font-medium">Compare</span>
        </nav>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
          Results Comparison
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Data Dictionary 2.0 — Aberdeen Area Association of REALTORS® · FBS / Spark API
        </p>
        <div className="mt-2 flex items-center gap-4 text-xs text-gray-400 dark:text-gray-500">
          <span>Previous: <span className="font-medium text-gray-600 dark:text-gray-300">Sep 24, 2025</span> (Certified)</span>
          <span>Current: <span className="font-medium text-gray-600 dark:text-gray-300">Apr 12, 2026</span> (Local Run)</span>
        </div>
      </div>

      {/* Improvement / Degradation summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-green-600 dark:text-green-400">Improvements</p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-green-700 dark:text-green-300">{improvedMetrics.length}</p>
          <p className="mt-1 text-xs text-green-600 dark:text-green-400">
            {improvedMetrics.map(m => m.label).join(', ')}
          </p>
        </div>
        <div className={`${degradedMetrics.length > 0 ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-gray-50 dark:bg-gray-800/60 border-gray-200 dark:border-gray-700'} border rounded-xl p-5`}>
          <p className={`text-[11px] font-medium uppercase tracking-wider ${degradedMetrics.length > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>Degradations</p>
          <p className={`mt-1 text-3xl font-bold tabular-nums ${degradedMetrics.length > 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-400 dark:text-gray-500'}`}>{degradedMetrics.length}</p>
          {degradedMetrics.length > 0 && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {degradedMetrics.map(m => m.label).join(', ')}
            </p>
          )}
          {degradedMetrics.length === 0 && (
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">No regressions detected</p>
          )}
        </div>
        <div className="bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Unchanged</p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-gray-400 dark:text-gray-500">{unchangedMetrics.length}</p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {unchangedMetrics.length > 0 ? unchangedMetrics.map(m => m.label).join(', ') : 'All metrics changed'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Headline metrics */}
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Key Metrics</h2>
            <div className="flex items-center gap-6 text-[10px] text-gray-400 dark:text-gray-500 tabular-nums">
              <span className="w-20 text-right">Previous</span>
              <span className="w-24 text-right font-semibold">Current</span>
            </div>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
            {SAMPLE_METRICS.map(m => (
              <MetricRow key={m.label} metric={m} />
            ))}
          </div>
        </div>

        {/* Per-resource comparison */}
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Per-Resource Comparison</h2>
          <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
            {SAMPLE_RESOURCES.map(r => (
              <ResourceRow key={r.resource} res={r} />
            ))}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 flex items-center gap-3">
        <button type="button" className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors">
          View Full Report
        </button>
        <button type="button" className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 cursor-pointer transition-colors">
          Submit to RESO
        </button>
      </div>
    </div>
  </div>
  );
};
