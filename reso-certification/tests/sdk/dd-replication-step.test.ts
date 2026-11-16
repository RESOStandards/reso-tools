/**
 * The Data Dictionary run's "Replicate and validate" step, as the pipeline runs it and as its readers see it.
 *
 * The step replicates with three strategies (one on Data Dictionary 1.7). They ran as three functions of the step and
 * now run as three jobs of one function, so what the step reports must not move: its name, the strategy named in the
 * live progress while each one runs, its summary and counts, and what a strict failure says. The desktop reads the
 * step by its name and reads the strategy from the progress JSON.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { everyStepPassed } from '../../src/sdk/certification.js';
import { replicateAndValidate } from '../../src/sdk/dd.js';
import { createPipeline } from '../../src/sdk/pipeline.js';
import type { DDConfig, StepProgress, StepResult } from '../../src/sdk/types.js';
import { type ReplicationMockOptions, startMultiResourceReplicationMockServer } from '../legacy/replication-mock-server.js';

type Json = Record<string, unknown>;

const metadataReport = {
  description: 'dd-replication-step-test',
  version: '2.0',
  generatedOn: '2024-01-01T00:00:00.000Z',
  resources: [{ resourceName: 'Property' }, { resourceName: 'Member' }],
  fields: [
    { resourceName: 'Property', fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
    { resourceName: 'Property', fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    { resourceName: 'Member', fieldName: 'MemberKey', type: 'Edm.String', annotations: [] },
    { resourceName: 'Member', fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    { resourceName: 'Member', fieldName: 'MemberLoginId', type: 'Edm.Int64', annotations: [] }
  ],
  lookups: [],
  actions: [],
  functions: []
};

const thisYear = new Date().getUTCFullYear();
const old = (month: number) => `${thisYear - 10}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;
const recent = (month: number) => `${thisYear - 1}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;

const properties: ReadonlyArray<Json> = [
  { ListingKey: 'P1', ModificationTimestamp: old(1) },
  { ListingKey: 'P2', ModificationTimestamp: recent(2) },
  { ListingKey: 'P3', ModificationTimestamp: recent(3) }
];
const members: ReadonlyArray<Json> = [
  { MemberKey: 'A1', ModificationTimestamp: old(1), MemberLoginId: 1 },
  { MemberKey: 'A2', ModificationTimestamp: old(2), MemberLoginId: 2 },
  { MemberKey: 'A3', ModificationTimestamp: recent(3), MemberLoginId: 3 }
];

const cleanServer: ReadonlyArray<ReplicationMockOptions> = [
  { resource: 'Property', records: properties, nextLinkKeepsQuery: true },
  { resource: 'Member', records: members, nextLinkKeepsQuery: true }
];

/** A1 with a violation, when a page of several records starts with it. */
const startingWithA1Broken = (page: ReadonlyArray<Json>): ReadonlyArray<Json> =>
  page.length > 1 && page[0]?.MemberKey === 'A1' ? [{ ...page[0], MemberLoginId: 'not-a-number' }, ...page.slice(1)] : page;

/**
 * A server only the second strategy fails on. Its Member page in natural order starts with A1, and that page alone
 * serves A1 with a violation; the descending walk's page ends with A1, and the lookback walk never reaches it.
 */
const serverFailingNaturalOrder: ReadonlyArray<ReplicationMockOptions> = [
  { resource: 'Property', records: properties, nextLinkKeepsQuery: true },
  { resource: 'Member', records: members, transformPage: startingWithA1Broken, nextLinkKeepsQuery: true }
];

/** A server every strategy fails on, at its first Member page. */
const serverFailingEveryStrategy: ReadonlyArray<ReplicationMockOptions> = [
  { resource: 'Property', records: properties, nextLinkKeepsQuery: true },
  {
    resource: 'Member',
    records: members.map(member => (member.MemberKey === 'A3' ? { ...member, MemberLoginId: 'not-a-number' } : member)),
    nextLinkKeepsQuery: true
  }
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface StepRun {
  readonly step: StepResult;
  readonly events: ReadonlyArray<StepProgress>;
}

/** Run the step alone through the pipeline, as a Data Dictionary run does, against a mock server. */
const runStep = async (
  server: ReadonlyArray<ReplicationMockOptions>,
  overrides: Partial<DDConfig> = {},
  contextVersion?: string
): Promise<StepRun> => {
  const mock = await startMultiResourceReplicationMockServer(server);
  const outputPath = await mkdtemp(join(tmpdir(), 'dd-replication-step-'));
  cleanups.push(mock.close, () => rm(outputPath, { recursive: true, force: true }));
  const metadataReportPath = join(outputPath, 'metadata-report.json');
  await writeFile(metadataReportPath, JSON.stringify(metadataReport));

  const config = {
    endorsement: 'dd',
    version: '2.0',
    requestDelay: 0,
    server: { url: mock.url, auth: { mode: 'token', token: '<sentinel_token>' } },
    ...overrides
  } as unknown as DDConfig;

  const events: StepProgress[] = [];
  const step = replicateAndValidate(config);
  type Ctx = Parameters<NonNullable<typeof step.functions>[number]>[0];
  const result = await createPipeline('dd', [step], everyStepPassed).run(
    {
      serverUrl: mock.url,
      version: contextVersion ?? config.version,
      outputPath,
      metadataReportPath,
      authToken: '<sentinel_token>'
    } as unknown as Ctx,
    event => events.push(event)
  );
  expect(result.steps).toHaveLength(1);
  return { step: result.steps[0], events };
};

/** The strategy named in each live progress update, with a run of the same name counted once. */
const strategiesInProgress = (events: ReadonlyArray<StepProgress>): ReadonlyArray<string> =>
  events
    .filter(event => event.step === 'sub:replicate')
    .map(event => {
      const payload = JSON.parse(String(event.message)) as { _type: string; currentStrategy: string };
      expect(payload._type).toBe('replication-progress');
      return payload.currentStrategy;
    })
    .filter((strategy, i, all) => strategy !== all[i - 1]);

const TIMESTAMP_DESC = 'Timestamp Descending with $top=1000';
const NEXT_LINK = 'NextLink with maxPageSize=1000';
const LOOKBACK = 'NextLink (modified-since filter, 3yr lookback)';
const MEMBER_FAILURE = 'Schema validation errors found in the Member payload: 1 error, 0 warnings, 1 distinct type';

describe('the Replicate and validate step', () => {
  it('names each strategy in the live progress, in the order they run', async () => {
    const { step, events } = await runStep(cleanServer);
    expect(step.name).toBe('Replicate and validate');
    expect(strategiesInProgress(events)).toEqual(['Timestamp Descending', 'NextLink', 'NextLink (modified-since filter)']);
  });

  it('summarizes the three strategies and the records received, and counts the records', async () => {
    const { step } = await runStep(cleanServer);
    expect(step.status).toBe('passed');
    // 6 records, each fetched by the descending walk (and its boundary repeat), the natural-order walk and, for the
    // recent ones, the lookback walk: 6 + 2 boundary repeats, 6, and 3
    expect(step.summary).toBe(`${TIMESTAMP_DESC}; ${NEXT_LINK}; ${LOOKBACK}; 17 records received`);
    expect(step.counts).toEqual({ recordsTested: 17 });
    expect(step.errors).toBeUndefined();
  });

  // The one thing a reader of the progress stream sees differently. The strategies were three functions of the step
  // and the pipeline announced each as it finished; they are one function now, announced once, with the same text
  // the step's summary joins them into.
  it('announces the strategies as one finished function, then the record check', async () => {
    const { events } = await runStep(cleanServer);
    expect(events.filter(event => event.step === 'sub:done').map(event => event.message)).toEqual([
      `${TIMESTAMP_DESC}; ${NEXT_LINK}; ${LOOKBACK}`,
      '17 records received'
    ]);
  });

  it('runs the descending strategy alone on Data Dictionary 1.7', async () => {
    const { step, events } = await runStep(cleanServer, { version: '1.7' } as Partial<DDConfig>);
    expect(step.status).toBe('passed');
    expect(step.summary).toBe('Timestamp Descending with $top=100; 8 records received');
    expect(step.counts).toEqual({ recordsTested: 8 });
    expect(strategiesInProgress(events)).toEqual(['Timestamp Descending']);
  });

  // Which strategies run has always followed the configured version, and the page size the run's own. A Data
  // Dictionary run sets both from one value; this holds the two apart to show each is read where it was.
  it('takes the strategies from the configured version and the page size from the run’s', async () => {
    const { step, events } = await runStep(cleanServer, { version: '1.7' } as Partial<DDConfig>, '2.0');
    expect(step.summary).toBe('Timestamp Descending with $top=1000; 8 records received');
    expect(strategiesInProgress(events)).toEqual(['Timestamp Descending']);
  });

  it('fails a strict run in the strategy that met the error, with the strategies before it in the summary', async () => {
    const { step, events } = await runStep(serverFailingNaturalOrder);
    expect(step.status).toBe('failed');
    expect(step.summary).toBe(`${TIMESTAMP_DESC}; ${MEMBER_FAILURE}`);
    expect(step.errors).toEqual([
      `${MEMBER_FAILURE} – 1 error recorded in data-availability-schema-validation-errors.json. Strategy: ${NEXT_LINK}.`
    ]);
    // the descending walk's 8, and the natural-order walk's 3 properties before the Member page stopped it
    expect(step.counts).toEqual({ recordsTested: 11 });
    // the third strategy never ran
    expect(strategiesInProgress(events)).toEqual(['Timestamp Descending', 'NextLink']);
  });

  it('fails a strict run in the first strategy with its message alone as the summary', async () => {
    const { step, events } = await runStep(serverFailingEveryStrategy);
    expect(step.status).toBe('failed');
    expect(step.summary).toBe(MEMBER_FAILURE);
    expect(step.errors).toEqual([
      `${MEMBER_FAILURE} – 1 error recorded in data-availability-schema-validation-errors.json. Strategy: ${TIMESTAMP_DESC}.`
    ]);
    expect(step.counts).toEqual({ recordsTested: 4 });
    expect(strategiesInProgress(events)).toEqual(['Timestamp Descending']);
  });

  it('does not fail a relaxed run on the same server, and still summarizes every strategy', async () => {
    const { step, events } = await runStep(serverFailingEveryStrategy, { strictMode: false });
    expect(step.status).toBe('passed');
    expect(step.summary).toBe(`${TIMESTAMP_DESC}; ${NEXT_LINK}; ${LOOKBACK}; 17 records received`);
    expect(strategiesInProgress(events)).toEqual(['Timestamp Descending', 'NextLink', 'NextLink (modified-since filter)']);
  });
});
