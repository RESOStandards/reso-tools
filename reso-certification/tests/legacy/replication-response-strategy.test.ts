/**
 * Every page the replicator scores is logged as a response entry on the run's state and written to
 * `data-availability-responses.json`. The entry had a `strategy` field that was never filled in: `scorePayload` reads
 * it from its arguments, and `replicate()` did not pass it. So which strategy fetched a page had to be worked out from
 * the shape of its URL.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import certUtilsCommon from '../../src/legacy/common.js';
import certUtils from '../../src/legacy/index.js';
import { startReplicationMockServer } from './replication-mock-server.js';

type ResponseEntry = Record<string, unknown>;
const { createReplicationStateServiceInstance } = certUtilsCommon as {
  createReplicationStateServiceInstance: () => { getResponses: () => ReadonlyArray<ResponseEntry> };
};
const { replicate } = certUtils as { replicate: (options: Record<string, unknown>) => Promise<void> };

const RESOURCE = 'Property';
const RESPONSES_FILE = 'data-availability-responses.json';
const AVAILABILITY_FILE = 'data-availability-report.json';

const metadataReport = {
  description: 'response-strategy-test',
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

const records = [
  { ListingKey: 'P1', ModificationTimestamp: '2024-01-01T00:00:00.000Z' },
  { ListingKey: 'P2', ModificationTimestamp: '2024-02-01T00:00:00.000Z' },
  { ListingKey: 'P3', ModificationTimestamp: '2024-03-01T00:00:00.000Z' }
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const setUp = async (): Promise<{ url: string; outputPath: string; reportPath: string }> => {
  const server = await startReplicationMockServer({ resource: RESOURCE, records });
  cleanups.push(server.close);
  const outputPath = await mkdtemp(join(tmpdir(), 'response-strategy-'));
  cleanups.push(() => rm(outputPath, { recursive: true, force: true }));
  const reportPath = join(outputPath, 'metadata-report.json');
  await writeFile(reportPath, JSON.stringify(metadataReport));
  return { url: server.url, outputPath, reportPath };
};

/** One strategy of a run, two records to a page, on the run's state. */
const replicateWith = (base: { url: string; outputPath: string; reportPath: string }, state: unknown, strategy: string) =>
  replicate({
    serviceRootUri: base.url,
    strategy,
    bearerToken: '<sentinel_token>',
    pathToMetadataReportJson: base.reportPath,
    outputPath: base.outputPath,
    version: '2.0',
    top: 2,
    maxPageSize: 2,
    throwOnError: true,
    secondsDelayBetweenRequests: 0,
    REPLICATION_STATE_SERVICE: state
  });

const writtenResponses = async (outputPath: string): Promise<ReadonlyArray<ResponseEntry>> =>
  (JSON.parse(await readFile(join(outputPath, RESPONSES_FILE), 'utf-8')) as { responses: ReadonlyArray<ResponseEntry> }).responses;

describe('a response entry names the strategy that fetched it', () => {
  it.each(['TopAndSkip', 'TimestampAsc', 'TimestampDesc', 'NextLink'])(
    '%s: on the run’s state and in the responses report',
    async strategy => {
      const base = await setUp();
      const state = createReplicationStateServiceInstance();
      await replicateWith(base, state, strategy);

      const logged = state.getResponses();
      expect(logged.length).toBeGreaterThanOrEqual(2);
      expect(logged.map(entry => entry.strategy)).toEqual(logged.map(() => strategy));
      const written = await writtenResponses(base.outputPath);
      expect(written).toHaveLength(logged.length);
      expect(written.map(entry => entry.strategy)).toEqual(written.map(() => strategy));
    }
  );

  it('tells the strategies of one run apart without reading a URL', async () => {
    const base = await setUp();
    const state = createReplicationStateServiceInstance();
    await replicateWith(base, state, 'TopAndSkip');
    const afterFirst = state.getResponses().length;
    await replicateWith(base, state, 'NextLink');

    const strategies = (await writtenResponses(base.outputPath)).map(entry => entry.strategy);
    expect(strategies.slice(0, afterFirst)).toEqual(strategies.slice(0, afterFirst).map(() => 'TopAndSkip'));
    expect(strategies.slice(afterFirst).length).toBeGreaterThanOrEqual(2);
    expect(strategies.slice(afterFirst)).toEqual(strategies.slice(afterFirst).map(() => 'NextLink'));
  });

  // Additive: the entry keeps every field it had, and the availability report, which is computed from the entries,
  // gains nothing.
  it('adds the one field and changes nothing else a reader sees', async () => {
    const base = await setUp();
    const state = createReplicationStateServiceInstance();
    await replicateWith(base, state, 'TopAndSkip');

    const [entry] = await writtenResponses(base.outputPath);
    expect(Object.keys(entry).sort()).toEqual(
      ['recordCount', 'requestUri', 'resourceName', 'responseBytes', 'responseTimeMs', 'startTime', 'stopTime', 'strategy'].sort()
    );
    expect(await readFile(join(base.outputPath, AVAILABILITY_FILE), 'utf-8')).not.toMatch(/strategy|TopAndSkip/);
  });
});
