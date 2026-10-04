/**
 * Replication progress: the shape, the parser and the formatters.
 *
 * This moved here from the web client because two surfaces needed it and only one had it. The
 * command line discarded the identical payload, so the tests that matter are the ones proving the
 * parser is safe to put in front of EVERY progress message: an ordinary human-readable message has
 * to come back as null rather than throwing, because that is how a caller decides the update is not
 * its business.
 */

import { describe, expect, it } from 'vitest';
import {
  buildAnomalyDetail,
  humanizeBytes,
  humanizeMs,
  parseReplicationProgress,
  summarizeReplicationProgress,
  type ReplicationProgressData,
} from '../src/progress/replication.js';

const payload = (over: Partial<ReplicationProgressData> = {}): ReplicationProgressData => ({
  _type: 'replication-progress',
  resources: [],
  totalRecords: 17_000,
  totalBytes: 44_335_104,
  throughput: 1250.4,
  meanResponseMs: 2100,
  anomalyCount: 4,
  ...over,
});

describe('parseReplicationProgress sits in front of every progress message', () => {
  it('reads its own payload', () => {
    const parsed = parseReplicationProgress(JSON.stringify(payload()));
    expect(parsed?.totalRecords).toBe(17_000);
  });

  it('returns null for an ordinary message rather than throwing', () => {
    // The real case: this is what a Data Dictionary step emits between telemetry updates.
    expect(parseReplicationProgress('Fetching Lookup Resource... 17,000 records')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    // A truncated payload must not take the renderer down mid-run.
    expect(parseReplicationProgress('{"_type":"replication-progress","totalRec')).toBeNull();
  });

  it('returns null for JSON that is some other payload', () => {
    expect(parseReplicationProgress('{"_type":"something-else","totalRecords":5}')).toBeNull();
  });

  it('returns null for an empty message', () => {
    expect(parseReplicationProgress('')).toBeNull();
  });
});

describe('summarizeReplicationProgress spends one line', () => {
  it('includes every quantity that is present', () => {
    const summary = summarizeReplicationProgress(payload({ currentStrategy: 'TopAndSkip' }));
    expect(summary).toBe('TopAndSkip: 17,000 records, 42.3 MB, 1,250 rec/s, mean 2.1s, 4 anomalies');
  });

  it('omits what is absent instead of padding it', () => {
    // An early update has a count but no throughput yet. Placeholders would be noise.
    const summary = summarizeReplicationProgress(
      payload({ totalBytes: null, throughput: null, meanResponseMs: null, anomalyCount: 0 }),
    );
    expect(summary).toBe('17,000 records');
  });

  it('singularizes one anomaly', () => {
    // Ends with it, which also proves the singular form rather than 'anomalies'.
    expect(summarizeReplicationProgress(payload({ anomalyCount: 1 }))).toMatch(/1 anomaly$/);
  });

  it('returns empty when nothing is quantified, so a caller can leave the display alone', () => {
    const summary = summarizeReplicationProgress(
      payload({ totalRecords: 0, totalBytes: null, throughput: null, meanResponseMs: null, anomalyCount: 0 }),
    );
    expect(summary).toBe('');
  });
});

describe('formatters', () => {
  it('scales bytes', () => {
    expect(humanizeBytes(412)).toBe('412 B');
    expect(humanizeBytes(9630)).toBe('9.4 KB');
    expect(humanizeBytes(44_335_104)).toBe('42.3 MB');
    expect(humanizeBytes(2_147_483_648)).toBe('2.0 GB');
  });

  it('scales milliseconds', () => {
    expect(humanizeMs(840)).toBe('840ms');
    expect(humanizeMs(2100)).toBe('2.1s');
    expect(humanizeMs(192_000)).toBe('3m 12s');
    expect(humanizeMs(180_000)).toBe('3m');
  });
});

describe('buildAnomalyDetail', () => {
  it('is empty when nothing is anomalous, so the caller can test it directly', () => {
    expect(buildAnomalyDetail([{ name: 'Property', records: 10, bytes: 100 }])).toBe('');
  });

  it('orders resources by anomaly count, descending', () => {
    const detail = buildAnomalyDetail([
      { name: 'Member', records: 1, bytes: 1, meanMs: 800, anomalyCount: 2, maxAnomalyMs: 3400, maxAnomalyDelta: 2600 },
      { name: 'Property', records: 1, bytes: 1, meanMs: 2100, anomalyCount: 4, maxAnomalyMs: 8200, maxAnomalyDelta: 6100 },
    ]);
    const lines = detail.split('\n');
    expect(lines[0]).toContain('slower than');
    expect(lines[1]).toBe('Property (mean 2.1s): 4 anomalies, max 8.2s (+6.1s)');
    expect(lines[2]).toBe('Member (mean 800ms): 2 anomalies, max 3.4s (+2.6s)');
  });

  it('skips resources with no anomalies', () => {
    const detail = buildAnomalyDetail([
      { name: 'Clean', records: 1, bytes: 1, anomalyCount: 0 },
      { name: 'Noisy', records: 1, bytes: 1, meanMs: 500, anomalyCount: 1, maxAnomalyMs: 2000, maxAnomalyDelta: 1500 },
    ]);
    expect(detail).not.toContain('Clean');
    expect(detail).toContain('Noisy (mean 500ms): 1 anomaly, max 2.0s (+1.5s)');
  });
});
