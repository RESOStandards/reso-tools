/**
 * One `replicate()` call validates a record once.
 *
 * The timestamp walks page inclusively: each page after the first starts at the last timestamp of the page before, so
 * the record on that boundary is fetched again, on purpose, and the availability figures drop the repeat by the
 * record's hash. Schema validation ran on the raw page, so a violation on a boundary record was counted twice: at
 * every page boundary, and always on the walk's last record. A count may be low and must never be high.
 *
 * A record is the same record when its content is the same, expanded data included. The availability guard's hash
 * cannot serve here: it takes the expanded data out of the parent before hashing, so a record fetched alone and then
 * with an expansion has one parent hash, and skipping on it would leave the expanded data unvalidated.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import certUtilsCommon from '../../src/legacy/common.js';
import certUtils from '../../src/legacy/index.js';
import replicationUtils from '../../src/legacy/lib/replication/utils.js';
import { type ReplicationMockOptions, startReplicationMockServer } from './replication-mock-server.js';

const { createReplicationStateServiceInstance } = certUtilsCommon as { createReplicationStateServiceInstance: () => unknown };
const { replicate } = certUtils as { replicate: (options: Record<string, unknown>) => Promise<void> };
const { withoutValidatedRecords } = replicationUtils as {
  withoutValidatedRecords: (args: { jsonData: unknown; resourceName: string; validatedRecordHashes: Set<string> }) => {
    value?: ReadonlyArray<unknown>;
  };
};

const RESOURCE = 'Property';
const ERRORS_FILE = 'data-availability-schema-validation-errors.json';
const NOT_ADVERTISED = 'Fields MUST be advertised in the metadata';
const MEDIA_TYPE = 'org.reso.metadata.Media';

const metadataReport = (withMedia: boolean) => ({
  description: 'validate-once-test',
  version: '2.0',
  generatedOn: '2024-01-01T00:00:00.000Z',
  resources: [{ resourceName: RESOURCE }, ...(withMedia ? [{ resourceName: 'Media' }] : [])],
  fields: [
    { resourceName: RESOURCE, fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
    { resourceName: RESOURCE, fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    { resourceName: RESOURCE, fieldName: 'BedroomsTotal', type: 'Edm.Int64', annotations: [] },
    ...(withMedia
      ? [
          {
            resourceName: RESOURCE,
            fieldName: 'Media',
            type: MEDIA_TYPE,
            typeName: 'Media',
            isExpansion: true,
            isCollection: true,
            annotations: []
          },
          { resourceName: 'Media', fieldName: 'MediaKey', type: 'Edm.String', annotations: [] }
        ]
      : [])
  ],
  lookups: [],
  actions: [],
  functions: []
});

interface SchemaReport {
  readonly totalErrors: number;
  readonly errors: Record<
    string,
    {
      readonly resources: Record<
        string,
        { readonly count: number; readonly keys?: ReadonlyArray<string>; readonly fields: Record<string, { readonly count?: number }> }
      >;
    }
  >;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** One relaxed `replicate()` call against a server holding these records; returns the errors report it wrote. */
const errorsReportOf = async (
  server: Omit<ReplicationMockOptions, 'resource'>,
  options: Record<string, unknown>,
  withMedia = false
): Promise<SchemaReport> => {
  const mock = await startReplicationMockServer({ resource: RESOURCE, ...server });
  cleanups.push(mock.close);
  const outputPath = await mkdtemp(join(tmpdir(), 'validate-once-'));
  cleanups.push(() => rm(outputPath, { recursive: true, force: true }));
  const reportPath = join(outputPath, 'metadata-report.json');
  await writeFile(reportPath, JSON.stringify(metadataReport(withMedia)));
  await replicate({
    serviceRootUri: mock.url,
    bearerToken: '<sentinel_token>',
    pathToMetadataReportJson: reportPath,
    outputPath,
    version: '2.0',
    jsonSchemaValidation: true,
    strictMode: false,
    throwOnError: true,
    secondsDelayBetweenRequests: 0,
    REPLICATION_STATE_SERVICE: createReplicationStateServiceInstance(),
    ...options
  });
  return JSON.parse(await readFile(join(outputPath, ERRORS_FILE), 'utf-8'));
};

const fieldCounts = (report: SchemaReport, message: string, resource = RESOURCE): Record<string, number | undefined> =>
  Object.fromEntries(Object.entries(report.errors[message]?.resources[resource]?.fields ?? {}).map(([field, { count }]) => [field, count]));

/** Five records a month apart, oldest first, each with a field of its own the metadata does not advertise. */
const fiveRecords = [1, 2, 3, 4, 5].map(n => ({
  ListingKey: `P${n}`,
  ModificationTimestamp: `2024-0${n}-01T00:00:00.000Z`,
  [`Field${n}`]: 'x'
}));

describe('one replicate() call validates a record once', () => {
  it('counts one violation on the walk’s last record once', async () => {
    const report = await errorsReportOf(
      { records: [{ ListingKey: 'OLD1', ModificationTimestamp: '2015-06-01T00:00:00.000Z', BedroomsTotal: 'three' }] },
      { strategy: 'TimestampDesc' }
    );
    const [typeError] = Object.keys(report.errors).filter(message => /^MUST be integer/.test(message));
    expect(fieldCounts(report, typeError)).toEqual({ BedroomsTotal: 1 });
    expect(report.errors[typeError].resources[RESOURCE].keys).toEqual(['OLD1']);
    expect(report.totalErrors).toBe(1);
  });

  // Two records to a page, newest first: [P5 P4] [P4 P3] [P3 P2] [P2 P1] [P1]. P5 is fetched once and every other
  // record twice, so only the other four counts were high.
  it.each(['TimestampDesc', 'TimestampAsc'])('%s: counts each record’s violation once at every page boundary', async strategy => {
    const report = await errorsReportOf({ records: fiveRecords }, { strategy, top: 2 });
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ Field1: 1, Field2: 1, Field3: 1, Field4: 1, Field5: 1 });
    expect(report.errors[NOT_ADVERTISED].resources[RESOURCE].count).toBe(5);
    expect(report.totalErrors).toBe(5);
  });

  // The walks that fetch no record twice report what they did before.
  it.each(['TopAndSkip', 'NextLink'])('%s: a walk with no repeat is unchanged', async strategy => {
    const report = await errorsReportOf({ records: fiveRecords }, { strategy, top: 2, maxPageSize: 2 });
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ Field1: 1, Field2: 1, Field3: 1, Field4: 1, Field5: 1 });
    expect(report.totalErrors).toBe(5);
  });

  // The call fetches each record alone, then with its expansion. The second is not a repeat: it carries data the
  // first did not, and the violation is in that data.
  it('validates a record again when it comes back with expanded data', async () => {
    const report = await errorsReportOf(
      {
        records: [{ ListingKey: 'P1', ModificationTimestamp: '2024-01-01T00:00:00.000Z' }],
        expansions: { Media: [{ MediaKey: 'M1', NotAMediaField: 'x' }] }
      },
      { strategy: 'NextLink' },
      true
    );
    expect(JSON.stringify(report.errors)).toContain('NotAMediaField');
    expect(report.totalErrors).toBe(1);
  });
});

// The rule on its own. These add to the run-level tests above and are not their control: the function is new.
describe('dropping the records of a page that this call has validated', () => {
  const page = (...records: ReadonlyArray<Record<string, unknown>>) => ({ '@odata.context': 'ctx', value: records });
  const drop = (jsonData: unknown, validatedRecordHashes: Set<string>, resourceName = RESOURCE) =>
    withoutValidatedRecords({ jsonData, resourceName, validatedRecordHashes }).value;

  it('drops a record with the same content and keeps the rest of the page as it was', () => {
    const seen = new Set<string>();
    expect(drop(page({ ListingKey: 'A' }, { ListingKey: 'B' }), seen)).toEqual([{ ListingKey: 'A' }, { ListingKey: 'B' }]);
    const next = withoutValidatedRecords({
      jsonData: page({ ListingKey: 'B' }, { ListingKey: 'C' }),
      resourceName: RESOURCE,
      validatedRecordHashes: seen
    });
    expect(next).toEqual({ '@odata.context': 'ctx', value: [{ ListingKey: 'C' }] });
  });

  it('keeps a record whose content changed, whose expanded data differs, or that belongs to another resource', () => {
    const seen = new Set<string>();
    drop(page({ ListingKey: 'A', ListPrice: 1 }), seen);
    expect(drop(page({ ListingKey: 'A', ListPrice: 2 }), seen)).toHaveLength(1);
    expect(drop(page({ ListingKey: 'A', ListPrice: 1, Media: [{ MediaKey: 'M1' }] }), seen)).toHaveLength(1);
    expect(drop(page({ ListingKey: 'A', ListPrice: 1, Media: [{ MediaKey: 'M2' }] }), seen)).toHaveLength(1);
    expect(drop(page({ ListingKey: 'A', ListPrice: 1 }), seen, 'Member')).toHaveLength(1);
    expect(drop(page({ ListingKey: 'A', ListPrice: 1 }), seen)).toHaveLength(0);
  });

  it('drops a record repeated inside one page, and leaves a payload that is not a page alone', () => {
    expect(drop(page({ ListingKey: 'A' }, { ListingKey: 'A' }), new Set<string>())).toEqual([{ ListingKey: 'A' }]);
    const single = { ListingKey: 'A' };
    expect(withoutValidatedRecords({ jsonData: single, resourceName: RESOURCE, validatedRecordHashes: new Set<string>() })).toBe(single);
  });
});
