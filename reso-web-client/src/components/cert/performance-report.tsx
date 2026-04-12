/**
 * Performance Report — provider vs. industry server performance comparison.
 *
 * Renders hero metrics (response time, throughput, payload size) with
 * provider vs. industry comparison, per-resource breakdown with sampling
 * stats, and derived metrics like projected replication time.
 *
 * If the provider has opted in, shows full provider + industry comparison.
 * If opted out, shows industry averages only with an explanation.
 */

import { useMemo } from 'react';
import type {
  PerformanceMetricsReport,
  ResourcePerformanceStats,
} from '../../api/cert-client.js';
import { availColorClass } from '../metadata/shared.js';

// ── Formatting helpers ──────────────────────────────────────────────

const formatMs = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatBandwidth = (kbps: number): string => {
  if (kbps < 1024) return `${Math.round(kbps)} KB/s`;
  return `${(kbps / 1024).toFixed(1)} MB/s`;
};

const formatNumber = (n: number): string => Math.round(n).toLocaleString();

const formatDateRange = (low: string, high: string): string => {
  const fmt = (iso: string): string => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  };
  return `${fmt(low)} – ${fmt(high)}`;
};

/** Delta percentage: positive = provider is faster/better. */
const deltaPercent = (provider: number, industry: number): number =>
  industry > 0 ? Math.round(((industry - provider) / industry) * 100) : 0;

// ── Tile styling ────────────────────────────────────────────────────

const TILE = 'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5';
const TILE_LABEL = 'text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';
const TILE_VALUE = 'mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100';
const TILE_SUB = 'text-xs text-gray-500 dark:text-gray-400 mt-1';

// ── Comparison bar ──────────────────────────────────────────────────

const ComparisonBar = ({
  label,
  providerValue,
  industryValue,
  format,
  lowerIsBetter = true,
}: {
  readonly label: string;
  readonly providerValue: number | null;
  readonly industryValue: number;
  readonly format: (n: number) => string;
  readonly lowerIsBetter?: boolean;
}) => {
  const maxVal = Math.max(providerValue ?? 0, industryValue, 1);
  const provPct = providerValue !== null ? (providerValue / maxVal) * 100 : 0;
  const indPct = (industryValue / maxVal) * 100;

  const isBetter = providerValue !== null && (lowerIsBetter
    ? providerValue < industryValue
    : providerValue > industryValue);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</span>
        {providerValue !== null && (
          <span className={`text-[10px] font-semibold ${isBetter ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
            {isBetter ? 'Better' : 'Below'} ({Math.abs(deltaPercent(providerValue, industryValue))}%)
          </span>
        )}
      </div>
      {providerValue !== null && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400 dark:text-gray-500 w-14 shrink-0">Provider</span>
          <div className="flex-1 h-2.5 bg-gray-100 dark:bg-gray-700/50 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${isBetter ? 'bg-green-500' : 'bg-amber-500'}`}
              style={{ width: `${Math.max(provPct, 2)}%` }}
            />
          </div>
          <span className="text-xs font-semibold tabular-nums text-gray-900 dark:text-gray-100 w-20 text-right shrink-0">
            {format(providerValue)}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-gray-400 dark:text-gray-500 w-14 shrink-0">Industry</span>
        <div className="flex-1 h-2.5 bg-gray-100 dark:bg-gray-700/50 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gray-400 dark:bg-gray-500"
            style={{ width: `${Math.max(indPct, 2)}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400 w-20 text-right shrink-0">
          {format(industryValue)}
        </span>
      </div>
    </div>
  );
};

// ── Resource performance card ───────────────────────────────────────

const ResourcePerfCard = ({
  name,
  stats,
}: {
  readonly name: string;
  readonly stats: ResourcePerformanceStats;
}) => {
  const expansionNames = stats.expansions ? Object.keys(stats.expansions) : [];

  return (
    <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{name}</h4>
        <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
          {formatNumber(stats.numSamples)} samples
        </span>
      </div>

      {/* Key stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Avg Response</p>
          <p className="text-lg font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {formatMs(stats.averageResponseTimeMs)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Median</p>
          <p className="text-lg font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {formatMs(stats.medianResponseTimeMs)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Throughput</p>
          <p className="text-lg font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {formatBandwidth(stats.bandwidth)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Avg Payload</p>
          <p className="text-lg font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {formatBytes(stats.averageResponseBytes)}
          </p>
        </div>
      </div>

      {/* Sampling details */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs text-gray-500 dark:text-gray-400">
        <div>
          <span className="text-gray-400 dark:text-gray-500">Records Fetched:</span>{' '}
          <span className="font-medium text-gray-700 dark:text-gray-300 tabular-nums">{formatNumber(stats.numRecordsFetched)}</span>
        </div>
        <div>
          <span className="text-gray-400 dark:text-gray-500">Unique Records:</span>{' '}
          <span className="font-medium text-gray-700 dark:text-gray-300 tabular-nums">{formatNumber(stats.numUniqueRecordsFetched)}</span>
        </div>
        <div>
          <span className="text-gray-400 dark:text-gray-500">Page Size:</span>{' '}
          <span className="font-medium text-gray-700 dark:text-gray-300 tabular-nums">{formatNumber(stats.pageSize)}</span>
        </div>
        {stats.dateLow && stats.dateHigh && (
          <div className="col-span-2 sm:col-span-3">
            <span className="text-gray-400 dark:text-gray-500">Date Range:</span>{' '}
            <span className="font-medium text-gray-700 dark:text-gray-300">{formatDateRange(stats.dateLow, stats.dateHigh)}</span>
            <span className="text-gray-400 dark:text-gray-500 ml-1">({stats.dateField})</span>
          </div>
        )}
      </div>

      {/* Expansions */}
      {expansionNames.length > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Expansions</p>
          <div className="space-y-2">
            {expansionNames.map((expName) => {
              const exp = stats.expansions![expName];
              return (
                <div key={expName} className="flex items-center justify-between text-xs">
                  <span className="font-medium text-gray-700 dark:text-gray-300">{expName}</span>
                  <div className="flex items-center gap-4 tabular-nums">
                    <span className="text-gray-500 dark:text-gray-400">{formatMs(exp.averageResponseTimeMs)}</span>
                    <span className="text-gray-500 dark:text-gray-400">{formatBandwidth(exp.bandwidth)}</span>
                    <span className="text-gray-500 dark:text-gray-400">{formatNumber(exp.numRecordsFetched)} records</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// ── Main component ──────────────────────────────────────────────────

/** Known resource keys to skip (they're top-level report fields, not resources). */
const REPORT_META_KEYS = new Set([
  'reportId', 'type', 'version', 'description', 'generatedOn',
  'recipientUoi', 'providerUoi', 'providerUsi', 'optInStatus', 'opted_in',
  'averageResponseTimeMillis', 'averageBandwidth', 'averageResponseBytes',
]);

export const PerformanceReport = ({
  data,
}: {
  readonly data: PerformanceMetricsReport;
}) => {
  const perf = data.performanceReport;
  const market = data.marketAverage;
  const optedIn = perf.opted_in;

  // Extract per-resource stats from the report (keys that aren't metadata)
  const resourceStats = useMemo(() => {
    const entries: Array<{ name: string; stats: ResourcePerformanceStats }> = [];
    for (const [key, value] of Object.entries(perf)) {
      if (REPORT_META_KEYS.has(key)) continue;
      if (typeof value === 'object' && value !== null && 'averageResponseTimeMs' in (value as Record<string, unknown>)) {
        entries.push({ name: key, stats: value as ResourcePerformanceStats });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }, [perf]);

  // Per-resource replication estimates
  const replicationStats = useMemo(() =>
    resourceStats.map(({ name, stats }) => {
      const recordsPerSecond = stats.averageResponseTimeMs > 0
        ? stats.pageSize / (stats.averageResponseTimeMs / 1000)
        : 0;
      return {
        name,
        recordsPerSecond: Math.round(recordsPerSecond),
        avgResponseMs: stats.averageResponseTimeMs,
        bandwidth: stats.bandwidth,
        pageSize: stats.pageSize,
      };
    }),
    [resourceStats]
  );

  return (
    <div className="space-y-6">
      {/* Opt-in status */}
      {!optedIn && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 text-sm text-amber-700 dark:text-amber-300">
          This provider has not opted in to publish performance metrics.
          Industry averages are shown for reference.
        </div>
      )}

      {/* Hero comparison bars */}
      <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-5">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {optedIn ? 'Provider vs. Industry Performance' : 'Industry Performance Averages'}
        </h3>
        <ComparisonBar
          label="Average Response Time"
          providerValue={optedIn ? perf.averageResponseTimeMillis : null}
          industryValue={market.averageResponseTimeMillis}
          format={formatMs}
          lowerIsBetter={true}
        />
        <ComparisonBar
          label="Throughput"
          providerValue={optedIn ? perf.averageBandwidth : null}
          industryValue={market.averageBandwidth}
          format={formatBandwidth}
          lowerIsBetter={false}
        />
        <ComparisonBar
          label="Average Payload Size"
          providerValue={optedIn ? perf.averageResponseBytes : null}
          industryValue={market.averageResponseBytes}
          format={formatBytes}
          lowerIsBetter={true}
        />
      </div>

      {/* Replication throughput by resource */}
      {optedIn && replicationStats.length > 0 && (() => {
        const maxRps = Math.max(...replicationStats.map((r) => r.recordsPerSecond), 1);
        return (
          <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Replication Throughput by Resource
            </h3>
            <div className="space-y-3">
              {replicationStats.map((r) => (
                <div key={r.name} className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 w-24 shrink-0 truncate">{r.name}</span>
                  <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-700/50 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-500"
                      style={{ width: `${(r.recordsPerSecond / maxRps) * 100}%` }}
                    />
                  </div>
                  <div className="flex items-center gap-4 shrink-0 text-xs tabular-nums">
                    <span className="font-semibold text-gray-900 dark:text-gray-100 w-20 text-right">
                      {formatNumber(r.recordsPerSecond)} rec/s
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 w-16 text-right">
                      {formatMs(r.avgResponseMs)}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 w-20 text-right">
                      {formatBandwidth(r.bandwidth)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500">
              Records per second based on page size and average response time per resource
            </p>
          </div>
        );
      })()}

      {/* Per-resource breakdown */}
      {optedIn && resourceStats.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
            Per-Resource Performance
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {resourceStats.map(({ name, stats }) => (
              <ResourcePerfCard key={name} name={name} stats={stats} />
            ))}
          </div>
        </div>
      )}

      {/* Sampling metadata */}
      {optedIn && (
        <div className="text-xs text-gray-400 dark:text-gray-500">
          Report generated {new Date(perf.generatedOn).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
          {' · '}
          {resourceStats.length} resource{resourceStats.length !== 1 ? 's' : ''} sampled
        </div>
      )}
    </div>
  );
};
