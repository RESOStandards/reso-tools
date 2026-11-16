/**
 * A timestamp walk does not validate its boundary records twice.
 *
 * The timestamp walks page inclusively: each page after the first starts at the last timestamp of the page before
 * (`le` going down, `ge` going up), so the records on that boundary are fetched again, on purpose, and the
 * availability figures drop the repeat by the record's hash. Schema validation ran on the raw page, so a violation on
 * a boundary record was counted twice: at every page boundary, and always on the walk's last record.
 *
 * The fix is a window of one page in that walk only: a record on a page is left out of validation when it is
 * identical, as served, to a record the page before returned at the boundary timestamp. Nothing wider:
 *   - a record is validated once per request shape (alone, and once with each expansion), so the reported totals stay
 *     the occurrence counts that report tools divide by one plus the number of expansions;
 *   - a record whose content changed between the two fetches is validated again;
 *   - a pager that repeats a record in the other walks is a fault of the server, and is still counted.
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
interface BoundaryWindow {
  readonly lastIsoTimestamp?: string | null;
  readonly records?: ReadonlyMap<string, number>;
}
const { withoutBoundaryRepeats } = replicationUtils as {
  withoutBoundaryRepeats: (args: { jsonData: unknown; strategy: string; window?: BoundaryWindow }) => {
    jsonData: { value?: ReadonlyArray<unknown> };
    window: BoundaryWindow;
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

const OLD1 = { ListingKey: 'OLD1', ModificationTimestamp: '2015-06-01T00:00:00.000Z', BedroomsTotal: 'three' };
const typeErrorOf = (report: SchemaReport): string => Object.keys(report.errors).filter(message => /^MUST be integer/.test(message))[0];

describe('a timestamp walk validates a boundary record once', () => {
  it('counts one violation on the walk’s last record once', async () => {
    const report = await errorsReportOf({ records: [OLD1] }, { strategy: 'TimestampDesc' });
    expect(fieldCounts(report, typeErrorOf(report))).toEqual({ BedroomsTotal: 1 });
    expect(report.errors[typeErrorOf(report)].resources[RESOURCE].keys).toEqual(['OLD1']);
    expect(report.totalErrors).toBe(1);
  });

  // Two records to a page, newest first: [P5 P4] [P4 P3] [P3 P2] [P2 P1] [P1]. P5 is fetched once and every other
  // record twice, so only the other four counts were high. The ascending walk is the mirror image.
  it.each(['TimestampDesc', 'TimestampAsc'])('%s: counts each record’s violation once at every page boundary', async strategy => {
    const report = await errorsReportOf({ records: fiveRecords }, { strategy, top: 2 });
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ Field1: 1, Field2: 1, Field3: 1, Field4: 1, Field5: 1 });
    expect(report.errors[NOT_ADVERTISED].resources[RESOURCE].count).toBe(5);
    expect(report.totalErrors).toBe(5);
  });

  // The second fetch of the boundary record is not a repeat when the record changed in between: its values may
  // differ, so it is validated, and here both of its values are recorded.
  it('validates a boundary record again when its content changed between the two pages', async () => {
    const report = await errorsReportOf(
      {
        records: [OLD1],
        transformPage: (page, request) => (request === 2 ? page.map(record => ({ ...record, BedroomsTotal: 'four' })) : page)
      },
      { strategy: 'TimestampDesc' }
    );
    expect(report.errors[typeErrorOf(report)].resources[RESOURCE].fields.BedroomsTotal).toEqual({
      count: 2,
      values: { three: { count: 1 }, four: { count: 1 } }
    });
  });
});

describe('the reported counts stay occurrence counts', () => {
  // The call fetches each Property alone and once more for its Media expansion. This server returns the same content
  // both times (no Media to expand), which is the hardest case: the two are identical as served, and still two
  // occurrences, one per request shape. Report tools divide by one plus the number of expansions.
  it.each(['NextLink', 'TimestampDesc'])('%s: a record with one expansion is validated once per request shape', async strategy => {
    const report = await errorsReportOf({ records: [OLD1] }, { strategy }, true);
    expect(fieldCounts(report, typeErrorOf(report))).toEqual({ BedroomsTotal: 2 });
    expect(report.totalErrors).toBe(2);
  });

  it('validates the expanded data of a record it has already validated alone', async () => {
    const report = await errorsReportOf(
      {
        records: [{ ListingKey: 'P1', ModificationTimestamp: '2024-01-01T00:00:00.000Z' }],
        expansions: { Media: [{ MediaKey: 'M1', NotAMediaField: 'x' }] }
      },
      { strategy: 'TimestampDesc' },
      true
    );
    expect(JSON.stringify(report.errors)).toContain('NotAMediaField');
    expect(report.totalErrors).toBe(1);
  });

  // The walks that fetch no record twice report what they did before.
  it.each(['TopAndSkip', 'NextLink'])('%s: a walk with no repeat is unchanged', async strategy => {
    const report = await errorsReportOf({ records: fiveRecords }, { strategy, top: 2, maxPageSize: 2 });
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ Field1: 1, Field2: 1, Field3: 1, Field4: 1, Field5: 1 });
    expect(report.totalErrors).toBe(5);
  });

  // A server whose second page repeats its first has a pager at fault. That is the server's repeat, not the walk's,
  // and it is not hidden: the record is validated each time it is served.
  it.each(['TopAndSkip', 'NextLink'])('%s: a record the server’s pager repeats is still counted each time', async strategy => {
    const [first, second] = fiveRecords;
    const report = await errorsReportOf(
      { records: [first, second], transformPage: (page, request) => (request === 2 ? [first] : page) },
      { strategy, top: 1, maxPageSize: 1 }
    );
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ Field1: 2 });
  });
});

// The rule on its own. These add to the run-level tests above and are not their control: the function is new.
describe('the boundary window', () => {
  const at = (key: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
    ListingKey: key,
    ModificationTimestamp: timestamp,
    ...extra
  });
  const T3 = '2024-03-01T00:00:00.000Z';
  const T2 = '2024-02-01T00:00:00.000Z';
  const T1 = '2024-01-01T00:00:00.000Z';
  const page = (...records: ReadonlyArray<Record<string, unknown>>) => ({ '@odata.context': 'ctx', value: records });
  const keysOf = (result: { jsonData: { value?: ReadonlyArray<unknown> } }) =>
    (result.jsonData.value ?? []).map(record => (record as { ListingKey: string }).ListingKey);

  it('remembers only the records at the boundary timestamp, and drops them from the next page', () => {
    const first = withoutBoundaryRepeats({ jsonData: page(at('C', T3), at('B', T2)), strategy: 'TimestampDesc' });
    expect(keysOf(first)).toEqual(['C', 'B']);
    expect([...(first.window.records ?? new Map()).keys()]).toEqual([JSON.stringify(at('B', T2))]);

    const second = withoutBoundaryRepeats({ jsonData: page(at('B', T2), at('A', T1)), strategy: 'TimestampDesc', window: first.window });
    expect(second.jsonData).toEqual(page(at('A', T1)));
  });

  it('keeps a record that is not identical to a remembered one, and one that was not at the boundary', () => {
    const first = withoutBoundaryRepeats({ jsonData: page(at('C', T3), at('B', T2)), strategy: 'TimestampDesc' });
    const next = (...records: ReadonlyArray<Record<string, unknown>>) =>
      keysOf(withoutBoundaryRepeats({ jsonData: page(...records), strategy: 'TimestampDesc', window: first.window }));
    expect(next(at('B', T2, { ListPrice: 2 }), at('A', T1))).toEqual(['B', 'A']);
    expect(next(at('B', T2, { Media: [{ MediaKey: 'M1' }] }), at('A', T1))).toEqual(['B', 'A']);
    // C was on the page before, above the boundary: the walk does not ask for it again, so this is the server's repeat
    expect(next(at('C', T3), at('A', T1))).toEqual(['C', 'A']);
  });

  it('lets one remembered record excuse one repeat, not two', () => {
    const first = withoutBoundaryRepeats({ jsonData: page(at('B', T2)), strategy: 'TimestampDesc' });
    const second = withoutBoundaryRepeats({
      jsonData: page(at('B', T2), at('B', T2), at('A', T1)),
      strategy: 'TimestampDesc',
      window: first.window
    });
    expect(keysOf(second)).toEqual(['B', 'A']);
  });

  it('remembers nothing after a page that is all one timestamp twice running: the walk steps past that timestamp', () => {
    const first = withoutBoundaryRepeats({ jsonData: page(at('B', T2)), strategy: 'TimestampDesc' });
    const second = withoutBoundaryRepeats({ jsonData: page(at('B', T2)), strategy: 'TimestampDesc', window: first.window });
    expect(keysOf(second)).toEqual([]);
    expect((second.window.records ?? new Map()).size).toBe(0);
  });

  it('leaves every other walk’s page exactly as it came, and remembers nothing', () => {
    const jsonData = page(at('B', T2), at('B', T2));
    for (const strategy of ['TopAndSkip', 'NextLink']) {
      const result = withoutBoundaryRepeats({
        jsonData,
        strategy,
        window: { lastIsoTimestamp: T2, records: new Map([[JSON.stringify(at('B', T2)), 1]]) }
      });
      expect(result.jsonData).toBe(jsonData);
      expect(result.window).toEqual({});
    }
  });
});
