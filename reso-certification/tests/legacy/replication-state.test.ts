/**
 * Replication state belongs to one run. It holds the responses, the record hashes and the availability map the
 * availability report is built from, so a second Data Dictionary run in the same process must start from nothing.
 *
 * `createReplicationStateServiceInstance` read like a constructor and returned a module-level singleton: Node caches
 * the module, and `init` returned early after the first call. A config-file run with several Data Dictionary entries
 * runs them in one process, so the second entry's availability report carried the first entry's responses, and the
 * check that a run received records could pass an empty server that followed a full one.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReplicate } from '../../src/cli/replicate-command.js';
import { newReplicationState } from '../helpers/replication-state.js';
import { startReplicationMockServer } from './replication-mock-server.js';

const RESOURCE = 'Property';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const metadataReport = {
  description: 'replication-state-test',
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

/** One replication run against a server holding these records, in its own output folder. Returns its availability report. */
const replicateOnce = async (records: ReadonlyArray<Record<string, unknown>>): Promise<Record<string, unknown>> => {
  const server = await startReplicationMockServer({ resource: RESOURCE, records });
  cleanups.push(server.close);
  const outputPath = await mkdtemp(join(tmpdir(), 'replication-state-'));
  cleanups.push(() => rm(outputPath, { recursive: true, force: true }));
  const reportPath = join(outputPath, 'metadata-report.json');
  await writeFile(reportPath, JSON.stringify(metadataReport));
  await runReplicate({
    serviceRootUri: server.url,
    strategy: 'TopAndSkip',
    bearerToken: 'test-token',
    metadataReportPath: reportPath,
    outputPath,
    version: '2.0',
    secondsDelayBetweenRequests: 0
  });
  return JSON.parse(await readFile(join(outputPath, 'data-availability-report.json'), 'utf-8'));
};

const fieldFrequencies = (report: Record<string, unknown>): ReadonlyArray<number> =>
  (Array.isArray(report.fields) ? report.fields : []).map(field => Number((field as { frequency?: unknown }).frequency ?? 0));

describe('replication state', () => {
  it('is a new object for each run, sharing nothing with the one before', () => {
    const first = newReplicationState<{ getResponses: () => Array<Record<string, unknown>> }>();
    first.getResponses().push({ resourceName: RESOURCE, recordCount: 5 });
    const second = newReplicationState<{ getResponses: () => Array<Record<string, unknown>> }>();
    expect(second).not.toBe(first);
    expect(second.getResponses()).toEqual([]);
  });

  it('keeps a second run in the same process from reporting the first run’s records', async () => {
    const full = await replicateOnce([
      { ListingKey: 'P1', ModificationTimestamp: '2024-01-01T00:00:00.000Z' },
      { ListingKey: 'P2', ModificationTimestamp: '2024-02-01T00:00:00.000Z' }
    ]);
    expect(Math.max(0, ...fieldFrequencies(full))).toBeGreaterThan(0);

    const empty = await replicateOnce([]);
    expect(fieldFrequencies(empty).every(frequency => frequency === 0)).toBe(true);
  });
});
