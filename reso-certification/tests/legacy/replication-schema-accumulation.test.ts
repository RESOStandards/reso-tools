/**
 * A Data Dictionary run replicates with several strategies, each a separate `replicate()` call on one run's state.
 * Each call kept its schema findings in a map of its own and wrote the report from it, so the errors file on disk
 * described the last strategy alone: a finding only an earlier strategy reached was gone from the report, in the
 * relaxed mode that exists to list everything.
 *
 * A call that runs to its end now accumulates across the calls of one run. The rule for counts is conservative,
 * because the calls fetch overlapping records and nothing yet identifies the same violation seen twice: each entry
 * reports the largest count any one strategy gave it, never the sum. Strict mode still stops at the first page with
 * an error and reports that call's findings; a strict call that passes accumulates its warnings.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import certUtilsCommon from '../../src/legacy/common.js';
import certUtils from '../../src/legacy/index.js';
import schemaResults from '../../src/legacy/lib/replication/schema-results.js';
import { replicateAndValidate } from '../../src/sdk/dd.js';
import type { DDConfig } from '../../src/sdk/types.js';
import { type ReplicationMockOptions, startReplicationMockServer } from './replication-mock-server.js';

const { createReplicationStateServiceInstance } = certUtilsCommon as { createReplicationStateServiceInstance: () => unknown };
const { replicate } = certUtils as { replicate: (options: Record<string, unknown>) => Promise<void> };
const { mergeSchemaValidationResults } = schemaResults as {
  mergeSchemaValidationResults: (accumulated: unknown, results: unknown) => Record<string, unknown>;
};

const RESOURCE = 'Property';
const ERRORS_FILE = 'data-availability-schema-validation-errors.json';
const WARNINGS_FILE = 'data-availability-schema-validation-warnings.json';

const NOT_ADVERTISED = 'Fields MUST be advertised in the metadata';
const RESOURCE_MISMATCH = /does not match the requested resource/;
const MALFORMED = /MUST be urn:reso:metadata/;

const metadataReport = {
  description: 'schema-accumulation-test',
  version: '2.0',
  generatedOn: '2024-01-01T00:00:00.000Z',
  resources: [{ resourceName: RESOURCE }],
  fields: [
    { resourceName: RESOURCE, fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
    { resourceName: RESOURCE, fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    { resourceName: RESOURCE, fieldName: 'BedroomsTotal', type: 'Edm.Int64', annotations: [] }
  ],
  lookups: [],
  actions: [],
  functions: []
};

const thisYear = new Date().getUTCFullYear();
/** Older than the Data Dictionary run's three-year lookback, so only the unfiltered strategies reach it. */
const OLD = `${thisYear - 10}-06-01T00:00:00.000Z`;
/** Inside the lookback, so every strategy reaches it. */
const RECENT = `${thisYear - 1}-06-01T00:00:00.000Z`;
/** A filter that keeps the recent records and drops the old ones, as the lookback strategy's does. */
const RECENT_ONLY = `ModificationTimestamp ge ${thisYear - 2}-01-01T00:00:00.000Z`;

// OLD1 has two violations no recent record has: a string in an integer field, and a field of its own that the
// metadata does not advertise. NEW1 has one: another unadvertised field.
const OLD1 = { ListingKey: 'OLD1', ModificationTimestamp: OLD, BedroomsTotal: 'three', OldOnlyField: 'x' };
const NEW1 = { ListingKey: 'NEW1', ModificationTimestamp: RECENT, NewOnlyField: 'y' };
// The oldest record of all, with nothing wrong, so the walks below end on a record that has no findings.
const OLDEST_CLEAN = { ListingKey: 'OLD0', ModificationTimestamp: `${thisYear - 12}-06-01T00:00:00.000Z` };

interface SchemaReport {
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly errors: Record<
    string,
    {
      readonly resources: Record<
        string,
        { readonly count: number; readonly keys?: ReadonlyArray<string>; readonly fields: Record<string, { readonly count?: number }> }
      >;
    }
  >;
  readonly warnings: Record<string, { readonly resources: Record<string, { readonly count: number }> }>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A server and an output folder holding the metadata report, both removed after the test. */
const setUp = async (
  options: Omit<ReplicationMockOptions, 'resource'>
): Promise<{ url: string; outputPath: string; reportPath: string }> => {
  const server = await startReplicationMockServer({ resource: RESOURCE, ...options });
  cleanups.push(server.close);
  const outputPath = await mkdtemp(join(tmpdir(), 'schema-accumulation-'));
  cleanups.push(() => rm(outputPath, { recursive: true, force: true }));
  const reportPath = join(outputPath, 'metadata-report.json');
  await writeFile(reportPath, JSON.stringify(metadataReport));
  return { url: server.url, outputPath, reportPath };
};

const readReport = async (outputPath: string, file: string): Promise<SchemaReport> =>
  JSON.parse(await readFile(join(outputPath, file), 'utf-8'));

/** The message keys of a report section that match, so a test can name a finding without its variable tail. */
const messagesMatching = (section: Record<string, unknown>, pattern: RegExp): ReadonlyArray<string> =>
  Object.keys(section).filter(message => pattern.test(message));

const fieldCounts = (report: SchemaReport, message: string): Record<string, number | undefined> =>
  Object.fromEntries(Object.entries(report.errors[message]?.resources[RESOURCE]?.fields ?? {}).map(([field, { count }]) => [field, count]));

/** One strategy of one run: a `replicate()` call as the Data Dictionary pipeline makes it, on the run's state. */
const replicateWith = (base: { url: string; outputPath: string; reportPath: string }, state: unknown, options: Record<string, unknown>) =>
  replicate({
    serviceRootUri: base.url,
    bearerToken: '<sentinel_token>',
    pathToMetadataReportJson: base.reportPath,
    outputPath: base.outputPath,
    version: '2.0',
    jsonSchemaValidation: true,
    shouldGenerateReports: true,
    throwOnError: true,
    secondsDelayBetweenRequests: 0,
    REPLICATION_STATE_SERVICE: state,
    ...options
  });

/**
 * The Data Dictionary pipeline's own replication step, relaxed: its three strategies in its order, each handed the
 * context the one before returned, as the pipeline's sequential runner does.
 */
const runRelaxedDataDictionaryStrategies = async (
  base: { url: string; outputPath: string; reportPath: string },
  limit?: number
): Promise<void> => {
  const config = {
    endorsement: 'dd',
    version: '2.0',
    strictMode: false,
    requestDelay: 0,
    ...(limit === undefined ? {} : { limit }),
    server: { url: base.url, auth: { mode: 'token', token: '<sentinel_token>' } }
  } as unknown as DDConfig;

  const step = replicateAndValidate(config);
  type Ctx = Parameters<NonNullable<typeof step.functions>[number]>[0];
  const initial = {
    serverUrl: base.url,
    version: '2.0',
    outputPath: base.outputPath,
    metadataReportPath: base.reportPath,
    authToken: '<sentinel_token>'
  } as unknown as Ctx;
  const outputs = await (step.functions ?? []).reduce<Promise<ReadonlyArray<{ status?: string; context: Ctx }>>>(async (previous, fn) => {
    const done = await previous;
    return [...done, await fn(done.at(-1)?.context ?? initial, () => {})];
  }, Promise.resolve([]));
  // relaxed: no strategy fails the step, however many errors it met
  expect(outputs.map(output => output.status ?? 'passed')).toEqual(outputs.map(() => 'passed'));
};

describe('a relaxed Data Dictionary run reports the schema findings of every strategy', () => {
  // The pipeline's own three strategies, in its order. The last one filters to the lookback window, so it never
  // reaches OLD1; the errors file it wrote alone had neither of OLD1's errors and none of the run's warnings.
  it('lists what an earlier strategy found after the last strategy has written the report', async () => {
    const base = await setUp({
      records: [OLDEST_CLEAN, OLD1, NEW1],
      // the page that carries the old record names another resource: a warning on the transport path
      pageContext: page => (page.some(record => record.ListingKey === 'OLD1') ? 'urn:reso:metadata:2.0:resource:member' : undefined)
    });
    await runRelaxedDataDictionaryStrategies(base);

    const report = await readReport(base.outputPath, ERRORS_FILE);
    const typeErrors = messagesMatching(report.errors, /^MUST be integer/);
    // the union of the distinct findings
    expect(typeErrors).toHaveLength(1);
    expect(fieldCounts(report, typeErrors[0])).toEqual({ BedroomsTotal: 1 });
    // one violation on one record is one, though two strategies reached OLD1 and three reached NEW1
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ OldOnlyField: 1, NewOnlyField: 1 });
    expect(report.errors[NOT_ADVERTISED].resources[RESOURCE].count).toBe(2);
    expect([...(report.errors[NOT_ADVERTISED].resources[RESOURCE].keys ?? [])].sort()).toEqual(['NEW1', 'OLD1']);
    expect(report.totalErrors).toBe(3);
    // the warning two strategies met, counted once
    expect(messagesMatching(report.warnings, RESOURCE_MISMATCH)).toHaveLength(1);
    expect(report.totalWarnings).toBe(1);
  });

  // The shape reso-tools #372 reported: a run with a sample limit whose errors file has every error class and
  // `"warnings": {}` with `totalWarnings: 0`, on a feed that does produce warnings. Here every strategy meets the same
  // error, and only the pages with the old record carry a warning; the lookback strategy, which writes last, has none.
  it('reports the warnings of a limited run whose last strategy met none', async () => {
    const base = await setUp({
      records: [
        OLDEST_CLEAN,
        { ListingKey: 'OLD1', ModificationTimestamp: OLD, SharedField: 'x' },
        { ListingKey: 'NEW1', ModificationTimestamp: RECENT, SharedField: 'y' }
      ],
      pageContext: page => (page.some(record => record.ListingKey === 'OLD1') ? 'urn:reso:metadata:2.0:resource:member' : undefined)
    });
    await runRelaxedDataDictionaryStrategies(base, 2);

    const report = await readReport(base.outputPath, ERRORS_FILE);
    expect(Object.keys(report.errors)).toEqual([NOT_ADVERTISED]);
    expect(report.totalWarnings).toBe(1);
    expect(messagesMatching(report.warnings, RESOURCE_MISMATCH)).toHaveLength(1);
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ SharedField: 2 });
  });

  it('counts an entry at the largest count one strategy gave it, never the sum across strategies', async () => {
    const second = { ListingKey: 'NEW2', ModificationTimestamp: RECENT, BedroomsTotal: 'four' };
    const base = await setUp({ records: [OLD1, second] });
    const state = createReplicationStateServiceInstance();

    // Two walks over both records, then one over the recent record alone.
    await replicateWith(base, state, { strategy: 'TopAndSkip', strictMode: false });
    await replicateWith(base, state, { strategy: 'NextLink', strictMode: false });
    await replicateWith(base, state, { strategy: 'NextLink', strictMode: false, filter: RECENT_ONLY });

    const report = await readReport(base.outputPath, ERRORS_FILE);
    const [typeError] = messagesMatching(report.errors, /^MUST be integer/);
    // two records each fail once: 2, not 5 (the sum of 2 + 2 + 1), and not 1 (the last walk alone)
    expect(fieldCounts(report, typeError)).toEqual({ BedroomsTotal: 2 });
    expect(report.errors[typeError].resources[RESOURCE].count).toBe(2);
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ OldOnlyField: 1 });
    // the total is the sum of the entries reported, so the report agrees with itself
    expect(report.totalErrors).toBe(3);
  });

  it('keeps the warnings of an earlier strategy when the run has no errors', async () => {
    const base = await setUp({
      records: [
        { ListingKey: 'OLD1', ModificationTimestamp: OLD },
        { ListingKey: 'NEW1', ModificationTimestamp: RECENT }
      ],
      // one finding on the page with the old record, a different one on a page without it
      pageContext: page => (page.some(record => record.ListingKey === 'OLD1') ? 'urn:reso:metadata:2.0:resource:member' : 'not-a-context')
    });
    const state = createReplicationStateServiceInstance();

    await replicateWith(base, state, { strategy: 'TopAndSkip', strictMode: false });
    await replicateWith(base, state, { strategy: 'NextLink', strictMode: false, filter: RECENT_ONLY });

    expect(await readdir(base.outputPath)).not.toContain(ERRORS_FILE);
    const report = await readReport(base.outputPath, WARNINGS_FILE);
    expect(messagesMatching(report.warnings, RESOURCE_MISMATCH)).toHaveLength(1);
    expect(messagesMatching(report.warnings, MALFORMED)).toHaveLength(1);
    expect(report.totalWarnings).toBe(2);
  });

  it('starts from nothing in another run: the findings belong to the run’s own state', async () => {
    const first = await setUp({ records: [OLD1] });
    await replicateWith(first, createReplicationStateServiceInstance(), { strategy: 'TopAndSkip', strictMode: false });

    const secondRun = await setUp({ records: [NEW1] });
    await replicateWith(secondRun, createReplicationStateServiceInstance(), { strategy: 'TopAndSkip', strictMode: false });

    const report = await readReport(secondRun.outputPath, ERRORS_FILE);
    expect(messagesMatching(report.errors, /^MUST be integer/)).toHaveLength(0);
    expect(fieldCounts(report, NOT_ADVERTISED)).toEqual({ NewOnlyField: 1 });
    expect(report.totalErrors).toBe(1);
  });
});

// The merge on its own. These add to the run-level tests above and are not their control: they cannot fail on the old
// behavior, because the function did not exist.
describe('merging the schema results of two strategies', () => {
  const resultsWith = (fields: Record<string, unknown>, count: number, keys: ReadonlyArray<string>) => ({
    stats: { totalErrors: count, totalWarnings: 0 },
    errorCache: {
      'MUST be listed': {
        resources: { [RESOURCE]: { count, keyField: 'ListingKey', keys: Object.fromEntries(keys.map(key => [key, true])), fields } }
      }
    },
    warningsCache: {}
  });
  const a = resultsWith(
    { City: { lookups: { Springfield: { count: 3 }, Shelbyville: { count: 1 } } }, Height: { count: 2, values: { tall: { count: 2 } } } },
    6,
    ['K1', 'K2']
  );
  const b = resultsWith(
    { City: { lookups: { Springfield: { count: 2 }, Ogdenville: { count: 4 } } }, Height: { count: 2, values: { short: { count: 2 } } } },
    8,
    ['K2', 'K3']
  );
  const resourceOf = (merged: Record<string, unknown>) =>
    (merged as ReturnType<typeof resultsWith>).errorCache['MUST be listed'].resources[RESOURCE] as unknown as {
      count: number;
      keys: Record<string, boolean>;
      fields: {
        City: { lookups: Record<string, { count: number }> };
        Height: { count: number; values: Record<string, { count: number }>; valuesOmitted?: number };
      };
    };

  it('unites the entries, takes the larger count of each, and sums upward from them', () => {
    const merged = mergeSchemaValidationResults(a, b);
    const resource = resourceOf(merged);
    expect(resource.fields.City.lookups).toEqual({ Springfield: { count: 3 }, Shelbyville: { count: 1 }, Ogdenville: { count: 4 } });
    // two different recorded values are two entries, so the field holds both; nothing is left unaccounted for
    expect(resource.fields.Height).toEqual({ count: 4, values: { tall: { count: 2 }, short: { count: 2 } } });
    expect(Object.keys(resource.keys).sort()).toEqual(['K1', 'K2', 'K3']);
    expect(resource.count).toBe(3 + 1 + 4 + 4);
    expect((merged as { stats: unknown }).stats).toEqual({ totalErrors: 12, totalWarnings: 0 });
    // never the sum of the two strategies
    expect(resource.count).toBeLessThan(6 + 8);
  });

  it('gives the same answer in either order, and again when a strategy is merged twice', () => {
    const merged = mergeSchemaValidationResults(a, b);
    expect(mergeSchemaValidationResults(b, a).stats).toEqual(merged.stats);
    expect(resourceOf(mergeSchemaValidationResults(b, a)).fields.City).toEqual(resourceOf(merged).fields.City);
    expect(mergeSchemaValidationResults(merged, b)).toEqual(merged);
    expect(mergeSchemaValidationResults(merged, a)).toEqual(merged);
  });

  it('leaves one strategy’s results as they are, and changes neither argument', () => {
    const before = structuredClone({ a, b });
    expect(mergeSchemaValidationResults(null, a)).toEqual(a);
    expect(mergeSchemaValidationResults(a, a)).toEqual(a);
    mergeSchemaValidationResults(a, b);
    expect({ a, b }).toEqual(before);
  });
});

describe('a strict run fails fast and otherwise accumulates', () => {
  it('stops at the first page with an error and reports that call alone, on a state that already ran a strategy', async () => {
    const base = await setUp({ records: [OLD1, NEW1] });
    const state = createReplicationStateServiceInstance();

    // The filtered walk reaches NEW1 only, and fails on it.
    await expect(replicateWith(base, state, { strategy: 'NextLink', strictMode: true, filter: RECENT_ONLY })).rejects.toThrow(
      /Schema validation errors found in the Property payload: 1 error, 0 warnings, 1 distinct type/
    );
    const afterFirst = await readReport(base.outputPath, ERRORS_FILE);
    expect(fieldCounts(afterFirst, NOT_ADVERTISED)).toEqual({ NewOnlyField: 1 });
    expect(afterFirst.totalErrors).toBe(1);

    // A second strict call on the same state reports its own page: three errors, not those plus the first call's.
    await expect(replicateWith(base, state, { strategy: 'TopAndSkip', strictMode: true })).rejects.toThrow(
      /Schema validation errors found in the Property payload: 3 errors, 0 warnings, 2 distinct types/
    );
    const afterSecond = await readReport(base.outputPath, ERRORS_FILE);
    expect(fieldCounts(afterSecond, NOT_ADVERTISED)).toEqual({ OldOnlyField: 1, NewOnlyField: 1 });
    expect(afterSecond.totalErrors).toBe(3);
  });

  // Warnings never fail a strict run, so a strict run that passes accumulates them as a relaxed run does: its
  // warnings file is the union across its strategies, counted by the same rule.
  it('lists the warnings of every strategy of a passing strict run', async () => {
    const base = await setUp({
      records: [
        { ListingKey: 'OLD1', ModificationTimestamp: OLD },
        { ListingKey: 'NEW1', ModificationTimestamp: RECENT }
      ],
      pageContext: page => (page.some(record => record.ListingKey === 'OLD1') ? 'urn:reso:metadata:2.0:resource:member' : 'not-a-context')
    });
    const state = createReplicationStateServiceInstance();

    await replicateWith(base, state, { strategy: 'TopAndSkip', strictMode: true });
    await replicateWith(base, state, { strategy: 'NextLink', strictMode: true });
    await replicateWith(base, state, { strategy: 'NextLink', strictMode: true, filter: RECENT_ONLY });

    expect(await readdir(base.outputPath)).not.toContain(ERRORS_FILE);
    const report = await readReport(base.outputPath, WARNINGS_FILE);
    // the first two walks met the same page: one warning, not two
    expect(messagesMatching(report.warnings, RESOURCE_MISMATCH)).toHaveLength(1);
    expect(messagesMatching(report.warnings, MALFORMED)).toHaveLength(1);
    expect(report.totalWarnings).toBe(2);
  });

  // A strict failure is the failing call's own findings: the warnings an earlier, passing strategy accumulated are
  // not added to the file the failure writes.
  it('fails with the failing call’s findings alone after a strategy that passed with warnings', async () => {
    const base = await setUp({
      records: [{ ListingKey: 'OLD1', ModificationTimestamp: OLD }, NEW1],
      pageContext: page => (page.some(record => record.ListingKey === 'OLD1') ? 'urn:reso:metadata:2.0:resource:member' : 'not-a-context')
    });
    const state = createReplicationStateServiceInstance();

    // The old record alone: a warning, no error.
    await replicateWith(base, state, {
      strategy: 'NextLink',
      strictMode: true,
      filter: `ModificationTimestamp lt ${thisYear - 2}-01-01T00:00:00.000Z`
    });
    // The recent record alone: it fails.
    await expect(replicateWith(base, state, { strategy: 'NextLink', strictMode: true, filter: RECENT_ONLY })).rejects.toThrow(
      /Schema validation errors found in the Property payload: 1 error, 1 warning, 1 distinct type/
    );

    const report = await readReport(base.outputPath, ERRORS_FILE);
    expect(report.totalErrors).toBe(1);
    expect(report.totalWarnings).toBe(1);
    expect(messagesMatching(report.warnings, MALFORMED)).toHaveLength(1);
    expect(messagesMatching(report.warnings, RESOURCE_MISMATCH)).toHaveLength(0);
  });
});
