/**
 * Data Dictionary replication progress: the shape, the parser and the formatters.
 *
 * A replication step reports live telemetry by putting a JSON object in its progress `detail`
 * field. This module owns reading that object and turning its numbers into text. It owns no
 * rendering: a terminal prints one line from it, a browser draws a bar chart from it, and
 * neither needs to know about the other.
 *
 * Lifted here from the web client, which was the only consumer. The command line discarded the
 * same payload -- it checks whether a message starts with `{` and falls back to the step name --
 * so the telemetry existed in flight and only one surface ever showed it. Nothing persists it
 * either: the written reports carry steps, counts and artifact paths, not this.
 */

/** One resource's replication tally. */
export interface ResourceStat {
  readonly name: string;
  readonly records: number;
  readonly bytes: number;
  /** Per-resource Welford mean, in milliseconds. Absent until at least one timed response has
   *  arrived for this resource. */
  readonly meanMs?: number | null;
  /** Responses more than two standard deviations slower than this resource's mean. One-sided,
   *  and at least three samples are required before any are counted. */
  readonly anomalyCount?: number;
  readonly maxAnomalyMs?: number | null;
  readonly maxAnomalyDelta?: number | null;
}

/** The whole telemetry payload for one replication update. */
export interface ReplicationProgressData {
  readonly _type: 'replication-progress';
  readonly currentStrategy?: string;
  readonly resources: ReadonlyArray<ResourceStat>;
  readonly totalRecords: number;
  readonly totalBytes: number | null;
  readonly throughput: number | null;
  readonly meanResponseMs: number | null;
  readonly anomalyCount: number;
}

/**
 * Read a progress detail string as replication telemetry, or `null` when it is not that.
 *
 * Returning `null` rather than throwing is the point: every progress detail passes through here,
 * and most are ordinary human-readable messages. A caller uses the null to decide whether this
 * update is its business at all.
 */
export const parseReplicationProgress = (detail: string): ReplicationProgressData | null => {
  if (!detail.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(detail) as { _type?: string };
    if (parsed._type === 'replication-progress') return parsed as unknown as ReplicationProgressData;
  } catch {
    /* not JSON, so not ours */
  }
  return null;
};

/** Bytes as a short human string: `412 B`, `9.4 KB`, `42.3 MB`, `1.2 GB`. */
export const humanizeBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

/** Milliseconds as a short human string: `840ms`, `2.1s`, `3m 12s`. */
export const humanizeMs = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
};

/**
 * Per-resource anomaly detail, one line per resource that produced any, ordered by count.
 *
 * Returns the empty string when nothing is anomalous, so a caller can test it directly rather
 * than checking a count first.
 *
 *     Responses >2σ slower than their resource's mean.
 *     Property (mean 2.1s): 4 anomalies, max 8.2s (+6.1s)
 *     Member (mean 0.8s): 2 anomalies, max 3.4s (+2.6s)
 */
export const buildAnomalyDetail = (resources: ReadonlyArray<ResourceStat>): string => {
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
  return ["Responses >2σ slower than their resource's mean.", ...lines].join('\n');
};

/**
 * A one-line summary, for a surface that has one line to spend.
 *
 * Only what is present is included, so an early update that has a record count but no throughput
 * yet reads cleanly instead of carrying placeholders. Returns the empty string when there is
 * genuinely nothing to say, which a caller can treat as "leave the display alone".
 */
export const summarizeReplicationProgress = (data: ReplicationProgressData): string => {
  const parts: string[] = [];
  if (data.totalRecords > 0) parts.push(`${data.totalRecords.toLocaleString('en-US')} records`);
  if (data.totalBytes != null && data.totalBytes > 0) parts.push(humanizeBytes(data.totalBytes));
  if (data.throughput != null && data.throughput > 0) {
    parts.push(`${Math.round(data.throughput).toLocaleString('en-US')} rec/s`);
  }
  if (data.meanResponseMs != null) parts.push(`mean ${humanizeMs(data.meanResponseMs)}`);
  if (data.anomalyCount > 0) {
    parts.push(`${data.anomalyCount} ${data.anomalyCount === 1 ? 'anomaly' : 'anomalies'}`);
  }
  if (parts.length === 0) return '';
  const strategy = data.currentStrategy ? `${data.currentStrategy}: ` : '';
  return `${strategy}${parts.join(', ')}`;
};
