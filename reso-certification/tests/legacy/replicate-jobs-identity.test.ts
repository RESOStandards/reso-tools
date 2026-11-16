/**
 * One driver for a run's strategies writes what one `replicate()` call per strategy wrote.
 *
 * A Data Dictionary run made three calls on one run's state: ModificationTimestamp descending, natural-order NextLink,
 * and NextLink from three years back going forward. `replicateJobs` runs the same three as jobs of one call. This is
 * a refactor, so its proof is identity: against one server, the three calls and the one call must ask for the same
 * things in the same order and leave the same files, the same state and, when a strict run stops, the same error.
 *
 * Only what a clock decides is masked before comparing: the times and durations of the responses and the figures
 * computed from them, each report's `generatedOn`, and the moment a descending timestamp walk starts from. Everything
 * else is compared as serialized text, so the order of every array and key counts.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import certUtils from '../../src/legacy/index.js';
import { newReplicationState } from '../helpers/replication-state.js';
import { type ReplicationMockOptions, startMultiResourceReplicationMockServer } from './replication-mock-server.js';

type Json = Record<string, unknown>;
interface Job {
  readonly strategy: string;
  readonly top?: number;
  readonly maxPageSize?: number;
  readonly filter?: string;
  readonly orderby?: string;
  readonly label?: string;
}
interface ReplicationState {
  readonly getResponses: () => ReadonlyArray<Json>;
  readonly getSchemaValidationResults: () => unknown;
  readonly getTopLevelResourceCounts: () => unknown;
  readonly getResourceAvailabilityMap: () => unknown;
}

const { replicate, replicateJobs } = certUtils as {
  replicate: (options: Json) => Promise<void>;
  replicateJobs: (options: Json & { jobs: ReadonlyArray<Job> }) => Promise<void>;
};

const ERRORS_FILE = 'data-availability-schema-validation-errors.json';
const WARNINGS_FILE = 'data-availability-schema-validation-warnings.json';
const AVAILABILITY_FILE = 'data-availability-report.json';
const RESPONSES_FILE = 'data-availability-responses.json';
const MEDIA_TYPE = 'org.reso.metadata.Media';

const metadataReport = {
  description: 'replicate-jobs-identity-test',
  version: '2.0',
  generatedOn: '2024-01-01T00:00:00.000Z',
  resources: [{ resourceName: 'Property' }, { resourceName: 'Member' }, { resourceName: 'Office' }, { resourceName: 'Media' }],
  fields: [
    { resourceName: 'Property', fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
    { resourceName: 'Property', fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    { resourceName: 'Property', fieldName: 'BedroomsTotal', type: 'Edm.Int64', annotations: [] },
    {
      resourceName: 'Property',
      fieldName: 'Media',
      type: MEDIA_TYPE,
      typeName: 'Media',
      isExpansion: true,
      isCollection: true,
      annotations: []
    },
    { resourceName: 'Member', fieldName: 'MemberKey', type: 'Edm.String', annotations: [] },
    { resourceName: 'Member', fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    { resourceName: 'Member', fieldName: 'MemberLoginId', type: 'Edm.Int64', annotations: [] },
    { resourceName: 'Office', fieldName: 'OfficeKey', type: 'Edm.String', annotations: [] },
    { resourceName: 'Office', fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    { resourceName: 'Media', fieldName: 'MediaKey', type: 'Edm.String', annotations: [] },
    { resourceName: 'Media', fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] }
  ],
  lookups: [],
  actions: [],
  functions: []
};

const testStarted = Date.now();
const thisYear = new Date().getUTCFullYear();
/** Older than the lookback job's filter: only the two unfiltered jobs reach a record this old. */
const old = (month: number) => `${thisYear - 10}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;
/** Inside the lookback: every job reaches it. */
const recent = (month: number) => `${thisYear - 1}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;
const LOOKBACK = `ModificationTimestamp ge ${thisYear - 2}-01-01T00:00:00.000Z`;

/** The Data Dictionary run's three strategies, with a page of two so every walk has several pages and boundaries. */
const JOBS: ReadonlyArray<Job> = [
  { strategy: 'TimestampDesc', top: 2, label: 'Timestamp Descending' },
  { strategy: 'NextLink', maxPageSize: 2, label: 'NextLink' },
  {
    strategy: 'NextLink',
    maxPageSize: 2,
    filter: LOOKBACK,
    orderby: 'ModificationTimestamp asc',
    label: 'NextLink (modified-since filter)'
  }
];

const keysOf = (page: ReadonlyArray<Json>, keyField: string): string => page.map(record => record[keyField]).join(',');

/**
 * A page context only one job's walk meets, so each job has a finding of its own and a job whose end was skipped
 * would be missing from the reports. The pages are told apart by the records on them, in order:
 *   - `P2,P1` is the descending walk's (the natural order has `P1,P2`);
 *   - `P1,P2` is the natural-order walk's;
 *   - `P4,P5` is the lookback walk's (the natural order pairs `P3,P4` and `P5,P6`).
 */
const propertyPageContext = (page: ReadonlyArray<Json>): string | undefined =>
  ({
    'P2,P1': 'urn:reso:metadata:2.0:resource:office',
    'P1,P2': 'urn:reso:metadata:2.0:resource:member',
    'P4,P5': 'not-a-context'
  })[keysOf(page, 'ListingKey')];

/** Six properties, three older than the lookback. `bad` puts the violations in; without it every record is clean. */
const properties = (bad: boolean): ReadonlyArray<Json> => [
  { ListingKey: 'P1', ModificationTimestamp: old(1), ...(bad ? { BedroomsTotal: 'three', OldOnlyField: 'x' } : {}) },
  { ListingKey: 'P2', ModificationTimestamp: old(2), BedroomsTotal: 2 },
  { ListingKey: 'P3', ModificationTimestamp: old(3) },
  { ListingKey: 'P4', ModificationTimestamp: recent(4), ...(bad ? { NewOnlyField: 'y' } : {}) },
  { ListingKey: 'P5', ModificationTimestamp: recent(5), BedroomsTotal: 5 },
  { ListingKey: 'P6', ModificationTimestamp: recent(6) }
];

const offices: ReadonlyArray<Json> = [
  { OfficeKey: 'O1', ModificationTimestamp: old(1) },
  { OfficeKey: 'O2', ModificationTimestamp: recent(2) },
  { OfficeKey: 'O3', ModificationTimestamp: recent(3) }
];

/**
 * Media is a resource of its own as well as Property's expansion, so the server answers for it. A resource the server
 * did not serve would make the comparison depend on the clock: a descending timestamp walk whose first request fails
 * asks again only when the millisecond has changed, because the clock is in that request's URL.
 */
const media: ReplicationMockOptions = {
  resource: 'Media',
  records: [
    { MediaKey: 'M1', ModificationTimestamp: old(4) },
    { MediaKey: 'M2', ModificationTimestamp: recent(5) }
  ],
  nextLinkKeepsQuery: true
};

/** A server whose three jobs each meet errors and warnings, some of them the job's own. */
const serverWithErrors: ReadonlyArray<ReplicationMockOptions> = [
  {
    resource: 'Property',
    records: properties(true),
    pageContext: propertyPageContext,
    // an unadvertised field on the expanded records: a violation only the expansion walks reach
    expansions: { Media: [{ MediaKey: 'M1', UnadvertisedMediaField: 'z' }] },
    nextLinkKeepsQuery: true
  },
  {
    resource: 'Member',
    records: [
      { MemberKey: 'A1', ModificationTimestamp: old(1), MemberLoginId: 'not-a-number' },
      { MemberKey: 'A2', ModificationTimestamp: recent(2), MemberLoginId: 2 },
      { MemberKey: 'A3', ModificationTimestamp: recent(3), MemberLoginId: 3 }
    ],
    pageContext: 'not-a-context',
    nextLinkKeepsQuery: true
  },
  { resource: 'Office', records: offices, nextLinkKeepsQuery: true },
  media
];

/** The same shape with nothing wrong in any record: warnings only, and each job still has one of its own. */
const serverWithWarningsOnly: ReadonlyArray<ReplicationMockOptions> = [
  {
    resource: 'Property',
    records: properties(false),
    pageContext: propertyPageContext,
    expansions: { Media: [{ MediaKey: 'M1' }] },
    nextLinkKeepsQuery: true
  },
  {
    resource: 'Member',
    records: [
      { MemberKey: 'A1', ModificationTimestamp: old(1), MemberLoginId: 1 },
      { MemberKey: 'A2', ModificationTimestamp: recent(2), MemberLoginId: 2 },
      { MemberKey: 'A3', ModificationTimestamp: recent(3), MemberLoginId: 3 }
    ],
    pageContext: 'not-a-context',
    nextLinkKeepsQuery: true
  },
  { resource: 'Office', records: offices, nextLinkKeepsQuery: true },
  media
];

/**
 * A server the first job passes and the second fails on, with a limit of two records a walk. The descending walk
 * takes the two newest members and stops; the natural-order walk takes the first two as stored, and the first of
 * those has a violation. Property comes before Member, so the second job has finished one walk when it stops.
 */
const serverFailingTheSecondJob: ReadonlyArray<ReplicationMockOptions> = [
  {
    resource: 'Property',
    records: properties(false),
    // the two newest properties, in the descending walk's order: the first job passes with a warning
    pageContext: page => (keysOf(page, 'ListingKey') === 'P6,P5' ? 'not-a-context' : undefined),
    expansions: { Media: [{ MediaKey: 'M1' }] },
    nextLinkKeepsQuery: true
  },
  {
    resource: 'Member',
    records: [
      { MemberKey: 'A1', ModificationTimestamp: old(1), MemberLoginId: 'not-a-number' },
      { MemberKey: 'A2', ModificationTimestamp: old(2), MemberLoginId: 2 },
      { MemberKey: 'A3', ModificationTimestamp: recent(3), MemberLoginId: 3 },
      { MemberKey: 'A4', ModificationTimestamp: recent(4), MemberLoginId: 4 }
    ],
    // only the natural-order page carries a context, so the failing job has a warning of its own
    pageContext: page => (keysOf(page, 'MemberKey') === 'A1,A2' ? 'urn:reso:metadata:2.0:resource:office' : undefined),
    nextLinkKeepsQuery: true
  },
  { resource: 'Office', records: offices, nextLinkKeepsQuery: true },
  media
];

/**
 * A server that answers one request of the second job with HTTP 500: the natural-order walk's first Office page, told
 * apart by its records as the pages above are. The walk gets nothing, and the job goes on to its next walk.
 */
const serverFailingOneRequest: ReadonlyArray<ReplicationMockOptions> = serverWithErrors.map(resource =>
  resource.resource === 'Office'
    ? {
        ...resource,
        transformPage: page => {
          if (keysOf(page, 'OfficeKey') === 'O1,O2') throw new Error('this page is not served');
          return page;
        }
      }
    : resource
);

/**
 * A progress reader that throws once, on the first update from the second job's Member walk. Every walk sends an
 * update with its first page, so this is a fault inside a page of the second job, after its Property walk.
 */
const progressReaderFailingInTheSecondJob = (): ((info: Json) => void) => {
  const reader = { hasFailed: false };
  return info => {
    if (reader.hasFailed || info.strategy !== 'NextLink' || info.resourceName !== 'Member') return;
    reader.hasFailed = true;
    throw new Error('The progress reader failed');
  };
};

// ── What a clock decides, removed before comparing ──

const without = (value: unknown, drop: (key: string) => boolean): unknown =>
  Array.isArray(value)
    ? value.map(item => without(item, drop))
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !drop(key))
            .map(([key, inner]) => [key, without(inner, drop)])
        )
      : value;

/** The moment a descending timestamp walk starts from is the clock's; a record's timestamp is years older. */
const withoutWalkStart = (requestUri: unknown): string =>
  String(requestUri).replace(/(ModificationTimestamp(?:%20| )le(?:%20| ))([0-9T:.-]+Z)/g, (whole, clause: string, timestamp: string) =>
    new Date(timestamp).getTime() >= testStarted ? `${clause}<walk start>` : whole
  );

const RESPONSE_TIMING = ['startTime', 'stopTime', 'responseTimeMs'];
const STATS_TIMING = ['meanResponseMs', 'stddevMs', 'anomalyCount', 'anomaliesByResource', 'totalRequests'];

const maskedResponse = (response: Json): Json => ({
  ...Object.fromEntries(Object.entries(response).filter(([key]) => !RESPONSE_TIMING.includes(key))),
  requestUri: withoutWalkStart(response.requestUri)
});

/** One report file with the clock taken out. Each file loses only its own timing fields, and `generatedOn`. */
const masked = (file: string, report: Json): unknown => {
  if (file === AVAILABILITY_FILE) return without(report, key => key === 'generatedOn' || /ResponseTime(Ms|Millis)$/.test(key));
  if (file === RESPONSES_FILE) {
    const {
      generatedOn: _generatedOn,
      stats = {},
      responses = [],
      ...rest
    } = report as {
      generatedOn?: unknown;
      stats?: Json;
      responses?: ReadonlyArray<Json>;
    };
    return {
      ...rest,
      stats: Object.fromEntries(Object.entries(stats).filter(([key]) => !STATS_TIMING.includes(key))),
      responses: responses.map(maskedResponse)
    };
  }
  return without(report, key => key === 'generatedOn');
};

// ── The two sides ──

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Side {
  /** Every file in the output folder, by name, with the clock taken out, serialized. */
  readonly files: Readonly<Record<string, string>>;
  /** Every request the server received, the count probes included, in order. */
  readonly requests: ReadonlyArray<string>;
  /** The run's state when it ended or stopped. */
  readonly state: {
    readonly responses: string;
    readonly schemaValidationResults: string;
    readonly counts: string;
    readonly availability: string;
  };
  /** What the run threw, when it did. */
  readonly failure?: { readonly message: string; readonly schemaValidationResults: string; readonly job?: unknown };
}

const failureOf = (err: unknown): Side['failure'] => {
  const thrown = err as { message?: string; schemaValidationResults?: unknown; replicationJob?: unknown };
  return {
    message: String(thrown?.message),
    schemaValidationResults: JSON.stringify(thrown?.schemaValidationResults),
    job: thrown?.replicationJob
  };
};

/**
 * One run of the three jobs against the server, in a folder and on a state of its own. `run` is given the options
 * every job shares and makes the calls.
 */
const sideOf = async (
  server: ReadonlyArray<ReplicationMockOptions>,
  options: Json,
  run: (shared: Json) => Promise<void>
): Promise<Side> => {
  const requests: string[] = [];
  const mock = await startMultiResourceReplicationMockServer(server, { onRequest: request => requests.push(request) });
  const outputPath = await mkdtemp(join(tmpdir(), 'replicate-jobs-identity-'));
  const reportFolder = await mkdtemp(join(tmpdir(), 'replicate-jobs-identity-metadata-'));
  cleanups.push(
    mock.close,
    () => rm(outputPath, { recursive: true, force: true }),
    () => rm(reportFolder, { recursive: true, force: true })
  );
  const reportPath = join(reportFolder, 'metadata-report.json');
  await writeFile(reportPath, JSON.stringify(metadataReport));
  const state = newReplicationState<ReplicationState>();

  const failure = await run({
    serviceRootUri: mock.url,
    bearerToken: '<sentinel_token>',
    pathToMetadataReportJson: reportPath,
    outputPath,
    version: '2.0',
    jsonSchemaValidation: true,
    shouldGenerateReports: true,
    throwOnError: true,
    secondsDelayBetweenRequests: 0,
    softwareVersion: '0.0.0-test',
    REPLICATION_STATE_SERVICE: state,
    ...options
  }).then(
    () => undefined,
    err => failureOf(err)
  );
  await mock.close();

  // the server's port is the one thing the two sides cannot share
  const portless = (text: string): string => text.replaceAll(mock.url, 'http://server');
  const names = (await readdir(outputPath, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(outputPath.length + 1))
    .sort();
  const files = Object.fromEntries(
    await Promise.all(
      names.map(async name => [name, portless(JSON.stringify(masked(name, JSON.parse(await readFile(join(outputPath, name), 'utf-8')))))])
    )
  );

  return {
    files,
    requests: requests.map(withoutWalkStart),
    state: {
      responses: portless(JSON.stringify(state.getResponses().map(maskedResponse))),
      schemaValidationResults: JSON.stringify(state.getSchemaValidationResults()),
      counts: JSON.stringify(state.getTopLevelResourceCounts()),
      availability: JSON.stringify(without(state.getResourceAvailabilityMap(), key => /ResponseTime(Ms|Millis)$/.test(key)))
    },
    failure
  };
};

/** What the Data Dictionary run did: one `replicate()` call a job, in order, and nothing after one that throws. */
const threeCalls = (shared: Json): Promise<void> =>
  JOBS.reduce<Promise<void>>(
    (previous, { label: _label, ...job }) => previous.then(() => replicate({ ...shared, ...job })),
    Promise.resolve()
  );

/** The same jobs, as one call to the driver. */
const oneCall = (shared: Json): Promise<void> => replicateJobs({ ...shared, jobs: JOBS });

/** Both sides of one run. `options` is asked for once a side, so a side can be given a reader of its own. */
const bothSides = async (
  server: ReadonlyArray<ReplicationMockOptions>,
  options: Json | (() => Json)
): Promise<{ calls: Side; driver: Side }> => {
  const optionsOf = typeof options === 'function' ? options : () => options;
  return {
    calls: await sideOf(server, optionsOf(), threeCalls),
    driver: await sideOf(server, optionsOf(), oneCall)
  };
};

/**
 * Every part of the two sides, compared: what was asked for, what is on disk, and what the state holds. Each part is
 * checked whether or not the one before it differed, so a failure lists everything that moved.
 */
const expectIdentical = ({ calls, driver }: { calls: Side; driver: Side }): void => {
  expect.soft(driver.requests, 'requests').toEqual(calls.requests);
  expect.soft(Object.keys(driver.files), 'files written').toEqual(Object.keys(calls.files));
  for (const name of Object.keys(calls.files)) {
    // as text, so the order of every array and key counts
    expect.soft(driver.files[name] === calls.files[name], `${name} is identical`).toBe(true);
    // and parsed, so a difference is shown as the value that moved
    expect.soft(JSON.parse(driver.files[name] ?? 'null'), name).toEqual(JSON.parse(calls.files[name]));
  }
  for (const part of ['responses', 'schemaValidationResults', 'counts', 'availability'] as const) {
    expect.soft(driver.state[part] === calls.state[part], `state ${part} is identical`).toBe(true);
  }
};

/** Whether a request is the lookback job's: it alone filters with `ge`. */
const isLookback = (requestUri: string): boolean => /ModificationTimestamp(%20| )ge(%20| )/.test(requestUri);

const reportOf = (side: Side, file: string): { totalErrors: number; totalWarnings: number; errors: Json; warnings: Json } =>
  JSON.parse(side.files[file]);

const responsesOf = (side: Side): ReadonlyArray<{ strategy: string; resourceName: string; requestUri: string }> =>
  (JSON.parse(side.files[RESPONSES_FILE]) as { responses: ReadonlyArray<{ strategy: string; resourceName: string; requestUri: string }> })
    .responses;

describe('one call with three jobs is identical to three calls', () => {
  it('a relaxed run with errors and warnings: the same requests, files and state', async () => {
    const sides = await bothSides(serverWithErrors, { strictMode: false });
    expectIdentical(sides);
    expect(sides.driver.failure).toBeUndefined();
    expect(sides.calls.failure).toBeUndefined();

    // The run is the one this test means to compare: both report files' subjects are there, and each job found
    // something no other job did, so every job's end is in the result.
    expect(Object.keys(sides.calls.files)).toEqual([AVAILABILITY_FILE, RESPONSES_FILE, ERRORS_FILE]);
    const report = reportOf(sides.calls, ERRORS_FILE);
    expect(report.totalErrors).toBeGreaterThan(0);
    expect(Object.keys(report.warnings).filter(message => /resource:office|office/i.test(message))).toHaveLength(1);
    expect(Object.keys(report.warnings).filter(message => /resource:member|member/i.test(message))).toHaveLength(1);
    expect(Object.keys(report.warnings).filter(message => /MUST be urn:reso:metadata/.test(message))).toHaveLength(1);
  });

  it('a relaxed run: the responses are in job order, and within a job in request order', async () => {
    const { driver, calls } = await bothSides(serverWithErrors, { strictMode: false });
    const walkOrder = (side: Side): ReadonlyArray<string> =>
      responsesOf(side)
        .map(
          ({ strategy, resourceName, requestUri }) =>
            `${strategy} ${resourceName}${requestUri.includes('$expand') || requestUri.includes('%24expand') ? '+Media' : ''}`
        )
        .filter((walk, i, all) => walk !== all[i - 1]);
    const jobOf = (strategy: string) => ['Property', 'Member', 'Office', 'Media', 'Property+Media'].map(walk => `${strategy} ${walk}`);
    expect(walkOrder(driver)).toEqual([...jobOf('TimestampDesc'), ...jobOf('NextLink'), ...jobOf('NextLink')]);
    expect(walkOrder(driver)).toEqual(walkOrder(calls));
  });

  it('a relaxed run: each resource is counted once, by the first job', async () => {
    const { driver, calls } = await bothSides(serverWithErrors, { strictMode: false });
    const probes = (side: Side) => side.requests.filter(request => request.includes('$count=true'));
    expect(probes(driver)).toEqual(['Property', 'Member', 'Office', 'Media'].map(resource => `/${resource}?$count=true []`));
    expect(probes(driver)).toEqual(probes(calls));
  });

  it('a strict run that passes with warnings: the same requests, files and state', async () => {
    const sides = await bothSides(serverWithWarningsOnly, { strictMode: true });
    expectIdentical(sides);
    expect(sides.driver.failure).toBeUndefined();
    expect(sides.calls.failure).toBeUndefined();

    expect(Object.keys(sides.calls.files)).toEqual([AVAILABILITY_FILE, RESPONSES_FILE, WARNINGS_FILE]);
    const report = reportOf(sides.calls, WARNINGS_FILE);
    expect(report.totalErrors).toBe(0);
    // each job's own warning, and the one every job met on the Member pages
    expect(Object.keys(report.warnings).length).toBeGreaterThanOrEqual(3);
  });

  it('a strict run that fails in the second job: the same error, and the same files on disk at the stop', async () => {
    const sides = await bothSides(serverFailingTheSecondJob, { strictMode: true, limit: 2 });
    expectIdentical(sides);

    // both stopped, in the second job, with the same message and the same attached results
    expect(sides.calls.failure?.message).toMatch(/^Schema validation errors found in the Member payload: 1 error, 1 warning/);
    expect(sides.driver.failure?.message).toBe(sides.calls.failure?.message);
    expect(sides.driver.failure?.schemaValidationResults).toBe(sides.calls.failure?.schemaValidationResults);
    expect(sides.driver.failure?.job).toEqual({ index: 1, strategy: 'NextLink', label: 'NextLink' });

    // On disk at the stop: the first job's reports and its warnings file, and the failing job's errors file, which
    // has that job's findings alone. The reports are the first job's: the second never reached its end.
    expect(Object.keys(sides.calls.files)).toEqual([AVAILABILITY_FILE, RESPONSES_FILE, ERRORS_FILE, WARNINGS_FILE]);
    // the first job's one warning, met in the Property walk and again in the walk that expands Media
    expect(reportOf(sides.calls, WARNINGS_FILE).totalWarnings).toBe(2);
    expect(reportOf(sides.calls, ERRORS_FILE)).toMatchObject({ totalErrors: 1, totalWarnings: 1 });
    expect(new Set(responsesOf(sides.calls).map(response => response.strategy))).toEqual(new Set(['TimestampDesc']));
    // the state had recorded the second job's first walk before it stopped; the third job never ran
    const stateStrategies = (JSON.parse(sides.calls.state.responses) as ReadonlyArray<{ strategy: string; resourceName: string }>).map(
      ({ strategy, resourceName }) => `${strategy} ${resourceName}`
    );
    expect(stateStrategies.filter(entry => entry.startsWith('NextLink'))).toEqual(['NextLink Property']);
  });
});

describe('one call with three jobs is identical to three calls when something goes wrong', () => {
  it('a request the server fails in the second job: the walk ends, the job goes on, the same files', async () => {
    const sides = await bothSides(serverFailingOneRequest, { strictMode: false });
    expectIdentical(sides);
    expect(sides.driver.failure).toBeUndefined();
    // the request was made once by each side and never followed, and the second job has no Office response: the only
    // NextLink responses for Office are the lookback job's, which carry its filter
    const officeRequests = sides.driver.requests.filter(
      request => request.startsWith('/Office') && request.endsWith('[odata.maxpagesize=2]')
    );
    expect(officeRequests.filter(request => !request.includes('$filter'))).toEqual(['/Office [odata.maxpagesize=2]']);
    const officeWalks = responsesOf(sides.driver).filter(
      response => response.resourceName === 'Office' && response.strategy === 'NextLink'
    );
    expect(officeWalks.length).toBeGreaterThan(0);
    expect(officeWalks.every(response => isLookback(response.requestUri))).toBe(true);
  });

  it('a throw inside the second job: the same error, and the first job’s files on disk', async () => {
    const sides = await bothSides(serverWithErrors, () => ({ strictMode: false, onProgress: progressReaderFailingInTheSecondJob() }));
    expectIdentical(sides);
    expect(sides.calls.failure?.message).toBe('The progress reader failed');
    expect(sides.driver.failure?.message).toBe('The progress reader failed');
    expect(sides.driver.failure?.job).toEqual({ index: 1, strategy: 'NextLink', label: 'NextLink' });
    // what the first job wrote, and nothing of the second: its findings were never merged
    expect(new Set(responsesOf(sides.calls).map(response => response.strategy))).toEqual(new Set(['TimestampDesc']));
    expect(Object.keys(reportOf(sides.calls, ERRORS_FILE).warnings).filter(message => /member/i.test(message))).toHaveLength(0);
  });

  it('the same throw in a run that logs errors and goes on: the second job is left out, the third runs', async () => {
    const sides = await bothSides(serverWithErrors, () => ({
      strictMode: false,
      throwOnError: false,
      onProgress: progressReaderFailingInTheSecondJob()
    }));
    expectIdentical(sides);
    expect(sides.calls.failure).toBeUndefined();
    expect(sides.driver.failure).toBeUndefined();
    const report = reportOf(sides.calls, ERRORS_FILE);
    // the third job ended and wrote: its own warning is there, the second job's is not
    expect(Object.keys(report.warnings).filter(message => /MUST be urn:reso:metadata/.test(message))).toHaveLength(1);
    expect(Object.keys(report.warnings).filter(message => /member/i.test(message))).toHaveLength(0);
    // the second job's Property walk had been recorded before it stopped, so the last reports list it
    const walks = responsesOf(sides.calls).map(response =>
      `${response.strategy} ${response.resourceName} ${isLookback(response.requestUri) ? 'lookback' : ''}`.trim()
    );
    expect(walks).toContain('NextLink Property');
    expect(walks).not.toContain('NextLink Member');
    expect(walks).toContain('NextLink Member lookback');
  });
});

// The two sides above share the page handler, so they cannot tell a walk's state from a job's. This can.
describe('what belongs to a walk ends with the walk', () => {
  // A descending walk remembers the records at its last page's boundary so the next page's repeat of them is not
  // validated twice. Here the limit stops the Property walk after its first page, P6 and P5, with P5 remembered. The
  // job's last walk asks for the same records with Media expanded, and this server expands nothing, so P5 comes back
  // exactly as remembered. It is another walk's record: it must be validated again, once per request shape.
  it('the boundary window: a record the walk before remembered is validated again in the next walk', async () => {
    const outputPath = await mkdtemp(join(tmpdir(), 'replicate-jobs-walk-state-'));
    const mock = await startMultiResourceReplicationMockServer([
      {
        resource: 'Property',
        records: properties(false).map(record => (record.ListingKey === 'P5' ? { ...record, BoundaryField: 'x' } : record))
      },
      // no Media records, so the walk between the two Property walks has no page to replace the window with
      { resource: 'Media', records: [] }
    ]);
    cleanups.push(mock.close, () => rm(outputPath, { recursive: true, force: true }));

    await replicateJobs({
      serviceRootUri: mock.url,
      bearerToken: '<sentinel_token>',
      metadataReportJson: metadataReport,
      outputPath,
      version: '2.0',
      jsonSchemaValidation: true,
      strictMode: false,
      throwOnError: true,
      secondsDelayBetweenRequests: 0,
      limit: 2,
      REPLICATION_STATE_SERVICE: newReplicationState(),
      jobs: [JOBS[0]]
    });

    const report = JSON.parse(await readFile(join(outputPath, ERRORS_FILE), 'utf-8')) as {
      errors: Record<string, { resources: Record<string, { fields: Record<string, { count: number }> }> }>;
    };
    expect(report.errors['Fields MUST be advertised in the metadata'].resources.Property.fields.BoundaryField.count).toBe(2);
  });
});

describe('what the driver refuses before it asks a server for anything', () => {
  const refused = async (jobs: ReadonlyArray<Job>): Promise<{ message: string; requests: number }> => {
    const requests: string[] = [];
    const mock = await startMultiResourceReplicationMockServer(serverWithWarningsOnly, { onRequest: request => requests.push(request) });
    cleanups.push(mock.close);
    const message = await replicateJobs({
      serviceRootUri: mock.url,
      bearerToken: '<sentinel_token>',
      metadataReportJson: metadataReport,
      throwOnError: true,
      shouldGenerateReports: false,
      secondsDelayBetweenRequests: 0,
      REPLICATION_STATE_SERVICE: newReplicationState(),
      jobs
    }).then(
      () => 'resolved',
      err => String((err as Error).message)
    );
    return { message, requests: requests.length };
  };

  it('an empty list of jobs', async () => {
    expect(await refused([])).toEqual({ message: 'No replication jobs were given!', requests: 0 });
  });

  it('a strategy it does not know, in any job', async () => {
    expect(await refused([JOBS[0], { strategy: 'Sideways' }])).toEqual({ message: "Unknown strategy: 'Sideways'!", requests: 0 });
  });
});
