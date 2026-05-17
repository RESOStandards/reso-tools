/**
 * Real-time replication progress bar chart.
 *
 * Renders a per-resource horizontal bar chart that updates smoothly
 * during DD replication. Detects structured JSON in the step detail
 * field and renders bars proportional to record counts.
 */

interface ResourceStat {
  readonly name: string;
  readonly records: number;
  readonly bytes: number;
  /** Per-resource Welford mean (ms). Absent until at least one timed
   *  response has arrived for this resource. */
  readonly meanMs?: number | null;
  /** Count of responses >2σ slower than this resource's mean
   *  (one-sided, ≥3 samples required). See reso-tools #206. */
  readonly anomalyCount?: number;
  readonly maxAnomalyMs?: number | null;
  readonly maxAnomalyDelta?: number | null;
}

interface ReplicationProgressData {
  readonly _type: 'replication-progress';
  readonly currentStrategy?: string;
  readonly resources: ReadonlyArray<ResourceStat>;
  readonly totalRecords: number;
  readonly totalBytes: number | null;
  readonly throughput: number | null;
  readonly meanResponseMs: number | null;
  readonly anomalyCount: number;
}

export type { ReplicationProgressData };

/** Try to parse a detail string as replication progress JSON. */
export const parseReplicationProgress = (detail: string): ReplicationProgressData | null => {
  if (!detail.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(detail);
    if (parsed._type === 'replication-progress') return parsed as ReplicationProgressData;
  } catch { /* not JSON */ }
  return null;
};

const humanizeBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const humanizeMs = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
};

/**
 * Build the per-resource anomaly tooltip text. One line per resource
 * that produced anomalies (sorted by count, desc), plus a header line
 * explaining the threshold. See reso-tools #206.
 *
 *   Responses >2σ slower than their resource's mean.
 *   Property (mean 2.1s): 4 anomalies, max 8.2s (+6.1s)
 *   Member (mean 0.8s): 2 anomalies, max 3.4s (+2.6s)
 */
const buildAnomalyTooltip = (resources: ReadonlyArray<ResourceStat>): string => {
  const withAnomalies = resources.filter(r => (r.anomalyCount ?? 0) > 0);
  if (withAnomalies.length === 0) return '';
  const lines = [...withAnomalies]
    .sort((a, b) => (b.anomalyCount ?? 0) - (a.anomalyCount ?? 0))
    .map(r => {
      const mean = r.meanMs != null ? humanizeMs(r.meanMs) : '–';
      const max = r.maxAnomalyMs != null ? humanizeMs(r.maxAnomalyMs) : '–';
      const delta = r.maxAnomalyDelta != null ? humanizeMs(r.maxAnomalyDelta) : null;
      const label = r.anomalyCount === 1 ? 'anomaly' : 'anomalies';
      const deltaSuffix = delta ? ` (+${delta})` : '';
      return `${r.name} (mean ${mean}): ${r.anomalyCount} ${label}, max ${max}${deltaSuffix}`;
    });
  return [
    "Responses >2σ slower than their resource's mean.",
    ...lines,
  ].join('\n');
};

/** Bar colors cycle for resources. */
const BAR_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-purple-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-orange-500',
  'bg-indigo-500',
];

/** Stable color assignment by resource name — same resource always gets same color. */
const colorCache = new Map<string, string>();
const colorForResource = (name: string): string => {
  const cached = colorCache.get(name);
  if (cached) return cached;
  const color = BAR_COLORS[colorCache.size % BAR_COLORS.length];
  colorCache.set(name, color);
  return color;
};

const TOP_N = 5;

import { useEffect, useState } from 'react';
import { getIndustryBaseline, getResourceOrder, initIndustryBaseline, lockResourceOrder, type IndustryBaseline } from '../../services/industry-baseline.js';

/** Hook that returns the industry baseline, triggering init if needed. */
const useIndustryBaseline = (): { baseline: IndustryBaseline | null; loading: boolean } => {
  const [baseline, setBaseline] = useState(getIndustryBaseline());
  const [loading, setLoading] = useState(!baseline);

  useEffect(() => {
    if (baseline) return;
    initIndustryBaseline();
    // Poll the cache until it arrives (the fetch is already in flight)
    const interval = setInterval(() => {
      const cached = getIndustryBaseline();
      if (cached) {
        setBaseline(cached);
        setLoading(false);
        clearInterval(interval);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [baseline]);

  return { baseline, loading };
};

export const ReplicationProgress = ({ data }: { readonly data: ReplicationProgressData }) => {
  const { baseline: industry, loading: industryLoading } = useIndustryBaseline();
  const resourceMap = new Map(data.resources.map(r => [r.name, r]));

  // Lock resource order via the DI service — stable for the session
  const fallbackOrder = data.resources.length > 0
    ? [...data.resources].sort((a, b) => b.records - a.records).map(r => r.name)
    : [];
  const order = getResourceOrder() ?? (fallbackOrder.length > 0 ? lockResourceOrder(fallbackOrder) : []);
  const seen = new Set<string>();
  const ordered: ResourceStat[] = [];
  for (const name of order) {
    seen.add(name);
    const stat = resourceMap.get(name);
    if (stat) ordered.push(stat);
    else ordered.push({ name, records: 0, bytes: 0 });
  }
  // Any new resources not in locked order go to extras
  const extras = data.resources.filter(r => !seen.has(r.name)).sort((a, b) => b.records - a.records);
  const top = ordered.slice(0, TOP_N);
  const rest = [...ordered.slice(TOP_N), ...extras];
  const otherRecords = rest.reduce((sum, r) => sum + r.records, 0);
  const otherBytes = rest.reduce((sum, r) => sum + r.bytes, 0);
  const visible = rest.length > 0 && otherRecords > 0
    ? [...top, { name: `+${rest.length} other`, records: otherRecords, bytes: otherBytes }]
    : top;

  const maxRecords = Math.max(...visible.map(r => r.records), 1);

  return (
    <div className="mt-1 space-y-1">
      {data.currentStrategy && (
        <div className="text-[10px] text-gray-500 dark:text-gray-400 font-mono mb-0.5">
          Strategy: <span className="text-gray-700 dark:text-gray-200">{data.currentStrategy}</span>
        </div>
      )}
      <div className="text-[10px] text-gray-400 dark:text-gray-500 font-mono mb-0.5">
        {industry
          ? <>Top {Math.min(TOP_N, visible.length)} resources by industry usage{industry.providerCount > 0 ? ` (${industry.providerCount.toLocaleString()} providers)` : ''}</>
          : industryLoading
            ? <span className="animate-pulse">Collecting RESO Analytics data...</span>
            : <>Top {Math.min(TOP_N, visible.length)} resources by record count</>
        }
      </div>
      {visible.map(resource => {
        const pct = (resource.records / maxRecords) * 100;
        const isOther = resource.name.startsWith('+');
        return (
          <div key={resource.name} className="flex items-center gap-2 text-xs">
            <span className="w-24 text-right text-gray-400 dark:text-gray-500 font-mono truncate">
              {resource.name}
            </span>
            <div className="flex-1 h-4 bg-gray-200 dark:bg-gray-700 rounded-sm overflow-hidden">
              <div
                className={`h-full ${isOther ? 'bg-gray-400 dark:bg-gray-500' : colorForResource(resource.name)} rounded-sm`}
                style={{
                  width: `${pct}%`,
                  transition: 'width 150ms ease-out',
                }}
              />
            </div>
            <span className="w-16 text-right text-gray-400 dark:text-gray-500 font-mono">
              {resource.records.toLocaleString()}
            </span>
          </div>
        );
      })}
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 font-mono pt-0.5 border-t border-gray-200 dark:border-gray-700">
        <span className="w-24 text-right font-semibold">Total</span>
        <span className="flex-1">
          {`${data.totalRecords.toLocaleString()} records`}
          {data.throughput != null && ` \u2013 ${data.throughput.toLocaleString()} rec/s`}
          {data.meanResponseMs != null && ` \u2013 avg ${humanizeMs(data.meanResponseMs)}`}
          {data.totalBytes != null && data.totalBytes > 0 && ` \u2013 ${humanizeBytes(data.totalBytes)}`}
          {data.anomalyCount > 0 && (
            <>
              {' \u2013 '}
              <span
                title={buildAnomalyTooltip(data.resources)}
                className="underline decoration-dotted decoration-gray-400 dark:decoration-gray-500 cursor-help"
              >
                {data.anomalyCount} anomal{data.anomalyCount === 1 ? 'y' : 'ies'}
              </span>
            </>
          )}
        </span>
      </div>
      {industryLoading && data.meanResponseMs != null && (
        <div className="flex items-center gap-2 text-xs font-mono pt-0.5 text-gray-400 dark:text-gray-500">
          <span className="w-24 text-right">Industry</span>
          <span className="flex-1 animate-pulse">Loading baseline...</span>
        </div>
      )}
      {industry && data.meanResponseMs != null && (
        <div className="flex items-center gap-2 text-xs font-mono pt-0.5">
          <span className="w-24 text-right text-gray-400 dark:text-gray-500">Industry</span>
          <span className="flex-1 text-gray-400 dark:text-gray-500">
            avg {humanizeMs(industry.avgResponseMs)}
            {data.meanResponseMs < industry.avgResponseMs
              ? <span className="ml-2 text-emerald-500 cursor-help" title={`Your avg response time (${humanizeMs(data.meanResponseMs)}) is ${Math.round((1 - data.meanResponseMs / industry.avgResponseMs) * 100)}% faster than the industry average (${humanizeMs(industry.avgResponseMs)})`}>{Math.round((1 - data.meanResponseMs / industry.avgResponseMs) * 100)}% faster</span>
              : data.meanResponseMs > industry.avgResponseMs
                ? <span className="ml-2 text-amber-500 cursor-help" title={`Your avg response time (${humanizeMs(data.meanResponseMs)}) is ${(data.meanResponseMs / industry.avgResponseMs).toFixed(1)}x the industry average (${humanizeMs(industry.avgResponseMs)})`}>{(data.meanResponseMs / industry.avgResponseMs).toFixed(1)}x slower</span>
                : <span className="ml-2 text-gray-400 cursor-help" title={`Your avg response time matches the industry average (${humanizeMs(industry.avgResponseMs)})`}>at average</span>
            }
          </span>
        </div>
      )}
    </div>
  );
};
