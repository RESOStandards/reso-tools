import { describe, it, expect } from 'vitest';
import { parseReplicationProgress } from '../src/components/cert/replication-progress';

describe('parseReplicationProgress', () => {
  it('returns null for plain text detail', () => {
    expect(parseReplicationProgress('Auth credentials present')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseReplicationProgress('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseReplicationProgress('{not json')).toBeNull();
  });

  it('returns null for JSON without _type marker', () => {
    expect(parseReplicationProgress('{"resources": [], "totalRecords": 0}')).toBeNull();
  });

  it('returns null for JSON with wrong _type', () => {
    expect(parseReplicationProgress('{"_type":"other-thing","resources":[]}')).toBeNull();
  });

  it('parses a valid replication-progress payload with currentStrategy', () => {
    const payload = JSON.stringify({
      _type: 'replication-progress',
      currentStrategy: 'NextLink (modified-since filter)',
      resources: [
        { name: 'Property', records: 1000, bytes: 500000 },
        { name: 'Member', records: 200, bytes: 50000 },
      ],
      totalRecords: 1200,
      totalBytes: 550000,
      throughput: 50,
      meanResponseMs: 200,
      anomalyCount: 0,
    });

    const result = parseReplicationProgress(payload);
    expect(result).not.toBeNull();
    expect(result?.currentStrategy).toBe('NextLink (modified-since filter)');
    expect(result?.resources).toHaveLength(2);
    expect(result?.resources[0].name).toBe('Property');
    expect(result?.totalRecords).toBe(1200);
    expect(result?.throughput).toBe(50);
  });

  it('parses a payload without currentStrategy (back-compat)', () => {
    // Older SDK builds emit replication-progress without currentStrategy.
    // The UI should still parse them — currentStrategy is optional.
    const payload = JSON.stringify({
      _type: 'replication-progress',
      resources: [{ name: 'Property', records: 100, bytes: 1000 }],
      totalRecords: 100,
      totalBytes: 1000,
      throughput: null,
      meanResponseMs: null,
      anomalyCount: 0,
    });

    const result = parseReplicationProgress(payload);
    expect(result).not.toBeNull();
    expect(result?.currentStrategy).toBeUndefined();
    expect(result?.resources[0].name).toBe('Property');
  });
});
