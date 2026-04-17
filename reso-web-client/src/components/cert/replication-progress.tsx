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
}

interface ReplicationProgressData {
  readonly _type: 'replication-progress';
  readonly resources: ReadonlyArray<ResourceStat>;
  readonly totalRecords: number;
  readonly totalBytes: number | null;
  readonly throughput: number | null;
  readonly meanResponseMs: number | null;
  readonly anomalyCount: number;
}

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
      <div className="text-[10px] text-gray-400 dark:text-gray-500 font-mono mb-0.5">
        {industry
          ? <>Top {Math.min(TOP_N, visible.length)} resources by industry usage{industry.providerCount > 0 ? ` (${industry.providerCount.toLocaleString()} providers)` : ''}</>
          : industryLoading
            ? <span className="animate-pulse">Collecting RESO Analytics data...</span>
            : <>Top {Math.min(TOP_N, visible.length)} resources by record count</>
        }
      </div>
      {visible.map((resource, i) => {
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
          {[
            `${data.totalRecords.toLocaleString()} records`,
            data.throughput != null ? `${data.throughput.toLocaleString()} rec/s` : null,
            data.meanResponseMs != null ? `avg ${humanizeMs(data.meanResponseMs)}` : null,
            data.totalBytes != null && data.totalBytes > 0 ? humanizeBytes(data.totalBytes) : null,
            data.anomalyCount > 0 ? `${data.anomalyCount} anomal${data.anomalyCount === 1 ? 'y' : 'ies'}` : null,
          ].filter(Boolean).join(' \u2013 ')}
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
              ? <span className="ml-2 text-emerald-500">{Math.round((1 - data.meanResponseMs / industry.avgResponseMs) * 100)}% faster</span>
              : data.meanResponseMs > industry.avgResponseMs
                ? <span className="ml-2 text-amber-500">{Math.round((data.meanResponseMs / industry.avgResponseMs - 1) * 100)}% slower</span>
                : <span className="ml-2 text-gray-400">at average</span>
            }
          </span>
        </div>
      )}
    </div>
  );
};
