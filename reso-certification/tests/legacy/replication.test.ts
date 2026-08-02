import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getMetadata } = require(resolve(import.meta.dirname, '../../src/etl/common.cjs'));
const { createReplicationStateServiceInstance } = require(resolve(import.meta.dirname, '../../src/legacy/common.js'));
const { scorePayload, computeLastIsoTimestamp, REPLICATION_STRATEGIES } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/replication/utils.js')
);

describe('Replication related tests', () => {
  it('Should not throw error is non-string non-array value is present', async () => {
    const metadataReport = getMetadata('2.0');
    const payload = {
      '@reso.context': 'urn:reso:metadata:1.7:resource:property',
      value: [
        {
          Country: 'CA', // expected case non-array string lookup value
          StateOrProvince: 'ON',
          BusinessType: 5 // non-array non-string lookup value
        }
      ]
    };

    const replicationInstance = createReplicationStateServiceInstance();
    replicationInstance.setMetadataMap(metadataReport);

    expect(() => {
      scorePayload({
        expansionInfo: [],
        jsonData: payload,
        replicationStateServiceInstance: replicationInstance,
        resourceName: 'Property'
      });
    }).not.toThrow();
  });
});

// The timestamp strategies advance a `ge`/`lt` boundary between pages. When an entire page shares one
// timestamp the boundary doesn't move, so the collision branch nudges it by 1ms. Regression: the ASC branch
// used `new Date(dateObj + 1)`, which coerces the Date to a string → Invalid Date → toISOString() throws.
describe('computeLastIsoTimestamp — timestamp-collision boundary (TimestampAsc/Desc)', () => {
  const TS = '2024-06-15T10:00:00.000Z';
  const collidingPage = { value: [{ ModificationTimestamp: TS }, { ModificationTimestamp: TS }] };
  const args = (strategy: string, lastIsoTimestamp: string) => ({
    jsonData: collidingPage,
    lastIsoTimestamp,
    strategy,
    timestampFieldName: 'ModificationTimestamp'
  });

  it('ASC nudges the boundary forward 1ms on a collision (no Invalid Date throw)', () => {
    let result: string;
    expect(() => {
      result = computeLastIsoTimestamp(args(REPLICATION_STRATEGIES.TIMESTAMP_ASC, TS));
    }).not.toThrow();
    expect(new Date(result!).getTime()).toBe(new Date(TS).getTime() + 1);
  });

  it('DESC nudges the boundary backward 1ms on a collision', () => {
    const result = computeLastIsoTimestamp(args(REPLICATION_STRATEGIES.TIMESTAMP_DESC, TS));
    expect(new Date(result).getTime()).toBe(new Date(TS).getTime() - 1);
  });

  it('returns the page max/min unchanged when the boundary advances (no collision)', () => {
    const earlier = '2024-06-15T09:00:00.000Z';
    expect(computeLastIsoTimestamp(args(REPLICATION_STRATEGIES.TIMESTAMP_ASC, earlier))).toBe(TS);
    expect(computeLastIsoTimestamp(args(REPLICATION_STRATEGIES.TIMESTAMP_DESC, '2024-06-15T11:00:00.000Z'))).toBe(TS);
  });
});
