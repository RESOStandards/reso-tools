/**
 * The record deduplication set, wired into replication.
 *
 * Replication counts a record once however many strategies fetch it. The set that answers "have I counted this one"
 * is handed to the run's replication state by whoever owns the run, with a ceiling in bytes. When the ceiling is
 * reached the set cannot tell a new record from a counted one, so every record after that is skipped: the
 * availability totals are then a floor, and the availability report says so.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReplicate } from '../../src/cli/replicate-command.js';
import certUtilsCommon from '../../src/legacy/common.js';
import certUtils from '../../src/legacy/index.js';
import { startReplicationMockServer } from './replication-mock-server.js';

const { createReplicationStateServiceInstance } = certUtilsCommon as {
  createReplicationStateServiceInstance: (options?: unknown) => unknown;
};
const { replicate } = certUtils as { replicate: (options: Record<string, unknown>) => Promise<void> };

const RESOURCE = 'Property';
const AVAILABILITY_FILE = 'data-availability-report.json';

const metadataReport = {
  description: 'record-dedup-test',
  version: '2.0',
  generatedOn: '2024-01-01T00:00:00.000Z',
  resources: [{ resourceName: RESOURCE }],
  fields: [
    { resourceName: RESOURCE, fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
    { resourceName: RESOURCE, fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    { resourceName: RESOURCE, fieldName: 'City', type: 'Edm.String', annotations: [] }
  ],
  lookups: [],
  actions: [],
  functions: []
};

/** Twenty records; every one has a key and a timestamp, every other one a city. */
const records = Array.from({ length: 20 }, (_unused, i) => ({
  ListingKey: `P${String(i).padStart(2, '0')}`,
  ModificationTimestamp: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  ...(i % 2 === 0 ? { City: 'Springfield' } : {})
}));

interface AvailabilityReport {
  readonly recordDeduplication?: Record<string, unknown>;
  readonly resources: ReadonlyArray<{
    readonly resourceName: string;
    readonly numUniqueRecordsFetched?: number;
    readonly numRecordsFetched?: number;
  }>;
  readonly fields: ReadonlyArray<{ readonly resourceName: string; readonly fieldName: string; readonly frequency: number }>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Two strategies of the replicate command over the same records, in one output folder; returns the second's report. */
const availabilityOf = async (options: { readonly recordDeduplicationMaxBytes?: number } = {}): Promise<AvailabilityReport> => {
  const server = await startReplicationMockServer({ resource: RESOURCE, records });
  cleanups.push(server.close);
  const outputPath = await mkdtemp(join(tmpdir(), 'record-dedup-'));
  cleanups.push(() => rm(outputPath, { recursive: true, force: true }));
  const reportPath = join(outputPath, 'metadata-report.json');
  await writeFile(reportPath, JSON.stringify(metadataReport));
  await runReplicate({
    serviceRootUri: server.url,
    strategy: 'TopAndSkip',
    bearerToken: '<sentinel_token>',
    metadataReportPath: reportPath,
    outputPath,
    version: '2.0',
    top: 5,
    secondsDelayBetweenRequests: 0,
    ...options
  });
  return JSON.parse(await readFile(join(outputPath, AVAILABILITY_FILE), 'utf-8'));
};

const frequencies = (report: AvailabilityReport): Record<string, number> =>
  Object.fromEntries(report.fields.map(field => [`${field.resourceName}.${field.fieldName}`, field.frequency]));

describe('the availability report says whether its totals are a floor', () => {
  it('reports a run that never reached the ceiling as counted, with the two flags and nothing else', async () => {
    const report = await availabilityOf();
    expect(report.recordDeduplication).toEqual({ saturated: false, totalsAreFloor: false });
    expect(frequencies(report)).toEqual({ 'Property.ListingKey': 20, 'Property.ModificationTimestamp': 20, 'Property.City': 10 });
    expect(report.resources[0].numUniqueRecordsFetched).toBe(20);
  });

  // 64 bytes holds five record keys. The other fifteen records cannot be told from counted ones, so they are skipped.
  it('reports a run that reached the ceiling as a floor, and counts no more than the run that did not', async () => {
    const counted = await availabilityOf();
    const floor = await availabilityOf({ recordDeduplicationMaxBytes: 64 });

    expect(floor.recordDeduplication).toEqual({ saturated: true, totalsAreFloor: true });
    const full = frequencies(counted);
    const low = frequencies(floor);
    expect(Object.keys(low).sort()).toEqual(Object.keys(full).sort());
    for (const [field, frequency] of Object.entries(low)) expect(frequency).toBeLessThanOrEqual(full[field]);
    expect(low['Property.ListingKey']).toBe(5);
    expect(floor.resources[0].numUniqueRecordsFetched).toBe(5);
    expect(floor.resources[0].numUniqueRecordsFetched).toBeLessThanOrEqual(counted.resources[0].numUniqueRecordsFetched ?? 0);
    // the requests made are a fact about the run, not about the set
    expect(floor.resources[0].numRecordsFetched).toBe(counted.resources[0].numRecordsFetched);
  });
});

describe('replication state is given its record set', () => {
  it('refuses to be created without one, and says what to pass', () => {
    expect(() => createReplicationStateServiceInstance()).toThrow(/recordKeySet/);
    expect(() => createReplicationStateServiceInstance({})).toThrow(/recordKeySet/);
  });

  it('fails a replicate() call that was given no state, before any request is made', async () => {
    const server = await startReplicationMockServer({ resource: RESOURCE, records });
    cleanups.push(server.close);
    await expect(
      replicate({
        serviceRootUri: server.url,
        strategy: 'TopAndSkip',
        bearerToken: '<sentinel_token>',
        resourceName: RESOURCE,
        throwOnError: true
      })
    ).rejects.toThrow(/recordKeySet/);
  });

  it('counts a record on "added" and skips it on "present" and on "refused"', async () => {
    const outcomes = ['added', 'present', 'refused', 'added'];
    const asked: string[] = [];
    const recordKeySet = {
      add: (key: string) => {
        asked.push(key);
        return outcomes[asked.length - 1];
      },
      has: () => false,
      isSaturated: () => false,
      stats: () => ({ recorded: 2, capacity: 2, loadFactor: 1, bytesReserved: 16, hashBits: 64, saturated: true, refused: 1 })
    };
    const server = await startReplicationMockServer({ resource: RESOURCE, records: records.slice(0, 4) });
    cleanups.push(server.close);
    const outputPath = await mkdtemp(join(tmpdir(), 'record-dedup-'));
    cleanups.push(() => rm(outputPath, { recursive: true, force: true }));
    const reportPath = join(outputPath, 'metadata-report.json');
    await writeFile(reportPath, JSON.stringify(metadataReport));

    await replicate({
      serviceRootUri: server.url,
      strategy: 'TopAndSkip',
      bearerToken: '<sentinel_token>',
      pathToMetadataReportJson: reportPath,
      outputPath,
      version: '2.0',
      throwOnError: true,
      secondsDelayBetweenRequests: 0,
      REPLICATION_STATE_SERVICE: createReplicationStateServiceInstance({ recordKeySet })
    });

    const report: AvailabilityReport = JSON.parse(await readFile(join(outputPath, AVAILABILITY_FILE), 'utf-8'));
    // one add per record, with the key replication has always used: 15 hex characters of a SHA-256
    expect(asked).toHaveLength(4);
    expect(asked.every(key => /^[0-9a-f]{15}$/.test(key))).toBe(true);
    expect(report.resources[0].numUniqueRecordsFetched).toBe(2);
    expect(frequencies(report)['Property.ListingKey']).toBe(2);
    expect(report.recordDeduplication).toEqual({ saturated: true, totalsAreFloor: true });
  });
});
