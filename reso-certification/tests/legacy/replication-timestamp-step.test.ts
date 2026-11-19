/**
 * A timestamp walk is stuck when a whole page shares one timestamp: the next request would ask for the same page
 * again. The walk then steps one second past that timestamp, the only rule that needs nothing from the server beyond a
 * timestamp comparison Web API Core tests (a whole unit at every precision a server can serve), and records the step as
 * a gap, so a reader of the report can see where the sample is incomplete rather than having it hidden.
 *
 * A gap is recorded only when the stuck page may have been cut off: it holds as many records as the `$top` it asked
 * for, or it carries a next link. A shorter page without one is the server saying it returned everything. That is the
 * last page of every walk, which repeats the walk's final record (the walks page inclusively) and so looks stuck, and
 * a whole resource that shares one timestamp and fits on one page, which the first comparison on real servers (System,
 * 61 records at one timestamp) wrongly reported as a gap when the test was the fullest page the walk had seen.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import certUtils from '../../src/legacy/index.js';
import { newReplicationState } from '../helpers/replication-state.js';
import { startReplicationMockServer } from './replication-mock-server.js';

type Entry = Record<string, unknown>;
const require = createRequire(import.meta.url);
const { replicate } = certUtils as { replicate: (options: Record<string, unknown>) => Promise<void> };
const { computeLastIsoTimestamp, REPLICATION_STRATEGIES } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/replication/utils.js')
) as {
  computeLastIsoTimestamp: (args: Record<string, unknown>) => string | undefined;
  REPLICATION_STRATEGIES: Record<string, string>;
};

const RESOURCE = 'Property';
const PAGE = 2;
const T = '2024-03-01T00:00:05.000Z';

const metadataReport = {
  description: 'timestamp-step-test',
  version: '2.0',
  generatedOn: '2024-01-01T00:00:00.000Z',
  resources: [{ resourceName: RESOURCE }],
  fields: [
    { resourceName: RESOURCE, fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
    { resourceName: RESOURCE, fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] }
  ],
  lookups: [],
  actions: [],
  functions: []
};

const at = (key: string, timestamp: string): Entry => ({ ListingKey: key, ModificationTimestamp: timestamp });
/** Five records share T, more than a page of two. */
const tieGroup = ['G1', 'G2', 'G3', 'G4', 'G5'].map(key => at(key, T));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Runs one timestamp walk over the records, two to a page, and returns what it wrote and which keys it was served. */
const walk = async (strategy: string, records: ReadonlyArray<Entry>, top: number = PAGE) => {
  const served = new Set<string>();
  const server = await startReplicationMockServer({
    resource: RESOURCE,
    records,
    transformPage: page => {
      for (const record of page) served.add(String(record.ListingKey));
      return page;
    }
  });
  cleanups.push(server.close);
  const outputPath = await mkdtemp(join(tmpdir(), 'timestamp-step-'));
  cleanups.push(() => rm(outputPath, { recursive: true, force: true }));
  const reportPath = join(outputPath, 'metadata-report.json');
  await writeFile(reportPath, JSON.stringify(metadataReport));
  const state = newReplicationState<{ getResponses: () => ReadonlyArray<Entry> }>();
  await replicate({
    serviceRootUri: server.url,
    strategy,
    bearerToken: '<sentinel_token>',
    pathToMetadataReportJson: reportPath,
    outputPath,
    version: '2.0',
    top,
    throwOnError: true,
    secondsDelayBetweenRequests: 0,
    REPLICATION_STATE_SERVICE: state
  });
  const read = async (file: string) => JSON.parse(await readFile(join(outputPath, file), 'utf-8'));
  return {
    served,
    responses: (await read('data-availability-responses.json')).responses as ReadonlyArray<Entry>,
    availability: (await read('data-availability-report.json')) as Entry
  };
};

describe('a stuck timestamp walk steps one second', () => {
  const stuckPage = { value: [at('G1', T), at('G2', T)] };

  it('descending: one second back from the shared timestamp', () => {
    expect(
      computeLastIsoTimestamp({
        jsonData: stuckPage,
        lastIsoTimestamp: T,
        strategy: REPLICATION_STRATEGIES.TIMESTAMP_DESC,
        timestampFieldName: 'ModificationTimestamp'
      })
    ).toBe('2024-03-01T00:00:04.000Z');
  });

  it('ascending: one second forward from the shared timestamp', () => {
    expect(
      computeLastIsoTimestamp({
        jsonData: stuckPage,
        lastIsoTimestamp: T,
        strategy: REPLICATION_STRATEGIES.TIMESTAMP_ASC,
        timestampFieldName: 'ModificationTimestamp'
      })
    ).toBe('2024-03-01T00:00:06.000Z');
  });
});

describe('a step past a cut-off page is recorded as a gap', () => {
  it('descending: the gap is on the page’s response entry and in the availability report', async () => {
    const records = [
      at('A', '2024-03-01T00:00:10.000Z'),
      ...tieGroup,
      at('SKIPPED', '2024-03-01T00:00:04.500Z'),
      at('EDGE', '2024-03-01T00:00:04.000Z'),
      at('Z', '2024-03-01T00:00:01.000Z')
    ];
    const { served, responses, availability } = await walk('TimestampDesc', records);

    const gap = { stuckAt: T, steppedTo: '2024-03-01T00:00:04.000Z', recordsRead: PAGE };
    expect(responses.map(entry => entry.timestampWalkGap).filter(Boolean)).toEqual([gap]);
    expect(availability.timestampWalkGaps).toEqual([
      {
        resourceName: RESOURCE,
        strategy: 'TimestampDesc',
        requestUri: expect.stringMatching(/ModificationTimestamp(%20| )le(%20| )2024-03-01T00:00:05\.000Z/),
        ...gap
      }
    ]);

    // What the step costs, made visible: the rest of the group at T and the record inside the skipped second are
    // never read; the record exactly one second back is.
    expect(served.has('EDGE')).toBe(true);
    expect(served.has('Z')).toBe(true);
    expect(served.has('SKIPPED')).toBe(false);
    expect(tieGroup.filter(record => served.has(String(record.ListingKey)))).toHaveLength(PAGE);
  });

  it('ascending: the same, one second forward', async () => {
    const records = [
      at('A', '2024-03-01T00:00:01.000Z'),
      ...tieGroup,
      at('SKIPPED', '2024-03-01T00:00:05.500Z'),
      at('EDGE', '2024-03-01T00:00:06.000Z'),
      at('Z', '2024-03-01T00:00:10.000Z')
    ];
    const { served, availability } = await walk('TimestampAsc', records);

    expect(availability.timestampWalkGaps).toEqual([
      {
        resourceName: RESOURCE,
        strategy: 'TimestampAsc',
        requestUri: expect.stringMatching(/ModificationTimestamp(%20| )ge(%20| )2024-03-01T00:00:05\.000Z/),
        stuckAt: T,
        steppedTo: '2024-03-01T00:00:06.000Z',
        recordsRead: PAGE
      }
    ]);
    expect(served.has('EDGE')).toBe(true);
    expect(served.has('SKIPPED')).toBe(false);
  });
});

describe('a walk that never had to step records no gap', () => {
  it.each(['TimestampDesc', 'TimestampAsc'])('%s: the report says so with an empty list', async strategy => {
    const records = ['01', '02', '03', '04', '05'].map((second, i) => at(`R${i}`, `2024-03-01T00:00:${second}.000Z`));
    const { served, responses, availability } = await walk(strategy, records);

    expect(served.size).toBe(records.length);
    expect(availability.timestampWalkGaps).toEqual([]);
    // A page without a gap keeps exactly the keys it had.
    expect(responses.every(entry => !('timestampWalkGap' in entry))).toBe(true);
  });

  it('a short last page that repeats the final record is the walk’s end, not a gap', async () => {
    // Two records at the bottom share a timestamp, but the page holding them is not full: nothing lies past it.
    const records = [at('R1', '2024-03-01T00:00:09.000Z'), at('R2', '2024-03-01T00:00:08.000Z'), at('R3', '2024-03-01T00:00:01.000Z')];
    const { served, availability } = await walk('TimestampDesc', records);

    expect(served.size).toBe(records.length);
    expect(availability.timestampWalkGaps).toEqual([]);
  });

  it.each(['TimestampDesc', 'TimestampAsc'])(
    '%s: a whole resource that shares one timestamp and fits on one page is read whole, not a gap',
    async strategy => {
      // Fewer records than $top and no next link: the server returned everything. The stuck page that follows repeats
      // them, and stepping past it skips nothing.
      const records = ['S1', 'S2', 'S3'].map(key => at(key, T));
      const { served, availability } = await walk(strategy, records, 5);

      expect(served.size).toBe(records.length);
      expect(availability.timestampWalkGaps).toEqual([]);
    }
  );
});
