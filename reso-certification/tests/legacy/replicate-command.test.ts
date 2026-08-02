import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReplicate, REPLICATION_STRATEGY_VALUES } from '../../src/cli/replicate-command.js';
import { startReplicationMockServer } from './replication-mock-server.js';

const RESOURCE = 'Property';

// Distinct timestamps → every strategy (incl. the exclusive-lt Desc walk) traverses cleanly with a tiny page.
const distinctRecords = [
  { ListingKey: 'P1', ModificationTimestamp: '2024-01-01T00:00:00.000Z' },
  { ListingKey: 'P2', ModificationTimestamp: '2024-02-01T00:00:00.000Z' },
  { ListingKey: 'P3', ModificationTimestamp: '2024-03-01T00:00:00.000Z' },
  { ListingKey: 'P4', ModificationTimestamp: '2024-04-01T00:00:00.000Z' },
  { ListingKey: 'P5', ModificationTimestamp: '2024-05-01T00:00:00.000Z' },
];

/** Collect the ListingKeys across every saved page — the proof each strategy fetched all rows and terminated. */
const savedKeys = async (outputPath: string, resource: string): Promise<ReadonlyArray<string>> => {
  const base = join(outputPath, 'reso-replication-output', resource);
  const keys = new Set<string>();
  for (const runDir of await readdir(base)) {
    const pageDir = join(base, runDir);
    for (const file of await readdir(pageDir)) {
      if (!file.endsWith('.json')) continue;
      const body = JSON.parse(await readFile(join(pageDir, file), 'utf-8')) as { value?: ReadonlyArray<{ ListingKey?: unknown }> };
      for (const record of body.value ?? []) keys.add(String(record.ListingKey));
    }
  }
  return [...keys].sort();
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Returns the distinct ListingKeys the run actually pulled and saved — the ground truth for full traversal +
// termination. (We assert on WHICH records, not the run's record-count stat: that stat comes from the legacy
// engine's 500ms-throttled onProgress, which never fires on a sub-500ms test run — see replicate-command.ts.)
const replicateAgainst = async (
  records: ReadonlyArray<Record<string, unknown>>,
  strategy: string,
): Promise<ReadonlyArray<string>> => {
  const server = await startReplicationMockServer({ resource: RESOURCE, records });
  cleanups.push(server.close);
  const outputPath = await mkdtemp(join(tmpdir(), 'replicate-'));
  cleanups.push(() => rm(outputPath, { recursive: true, force: true }));

  await runReplicate({
    serviceRootUri: server.url,
    strategy,
    bearerToken: 'test-token',
    resourceName: RESOURCE,
    top: 2, // tiny pages force multi-page pagination across all strategies
    maxPageSize: 2, // NextLink's odata.maxpagesize
    outputPath,
    shouldSaveResults: true, // raw pages are what savedKeys reads back
    shouldGenerateReports: false, // single-resource mode has no metadata to score against
    secondsDelayBetweenRequests: 0, // no inter-request sleep in tests
  });

  return savedKeys(outputPath, RESOURCE);
};

// Build-and-check EVERY strategy, including the two the dd pipeline never exercises (TopAndSkip, TimestampAsc).
describe('runReplicate — each strategy paginates, terminates, and fetches every record', () => {
  it.each(REPLICATION_STRATEGY_VALUES)('strategy %s traverses the whole resource via 2-record pages', async strategy => {
    expect(await replicateAgainst(distinctRecords, strategy)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
  });
});

// Both timestamp strategies must survive a duplicate timestamp that straddles a page boundary. Pre-fix:
// TimestampAsc CRASHED (Invalid Date) and TimestampDesc SILENTLY DROPPED the tied record (exclusive `lt`).
// C3 and C4 share a timestamp and, at page size 2, land across the boundary — the exact hazard.
describe('runReplicate — timestamp strategies across a boundary-straddling collision', () => {
  const collisionRecords = [
    { ListingKey: 'C1', ModificationTimestamp: '2024-01-01T00:00:00.000Z' },
    { ListingKey: 'C2', ModificationTimestamp: '2024-02-01T00:00:00.000Z' },
    { ListingKey: 'C3', ModificationTimestamp: '2024-03-01T00:00:00.000Z' },
    { ListingKey: 'C4', ModificationTimestamp: '2024-03-01T00:00:00.000Z' }, // shares C3's timestamp
    { ListingKey: 'C5', ModificationTimestamp: '2024-04-01T00:00:00.000Z' },
  ];

  it.each(['TimestampAsc', 'TimestampDesc'])('%s reaches every record across the collision', async strategy => {
    expect(await replicateAgainst(collisionRecords, strategy)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
  });
});

// --strict must FAIL the run on a schema violation. Pre-fix the strictMode throw was swallowed by a bare-return
// catch in the replication loop, so the run resolved as success (exit 0) — a false pass in a cert tool.
describe('runReplicate — --strict propagates a schema-validation failure (no false pass)', () => {
  const minimalReport = {
    description: 'strict-test',
    version: '2.0',
    generatedOn: '2024-01-01T00:00:00.000Z',
    resources: [{ resourceName: RESOURCE }],
    fields: [
      { resourceName: RESOURCE, fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
      { resourceName: RESOURCE, fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] },
    ],
    lookups: [],
    actions: [],
    functions: [],
  };
  // additionalProperties:false in the generated schema → an unknown field is a validation error.
  const violatingRecord = { ListingKey: 'X1', ModificationTimestamp: '2024-01-01T00:00:00.000Z', BogusExtraField: 'nope' };

  it('rejects instead of resolving when a record fails the schema under strictMode', async () => {
    const server = await startReplicationMockServer({ resource: RESOURCE, records: [violatingRecord] });
    cleanups.push(server.close);
    const outputPath = await mkdtemp(join(tmpdir(), 'replicate-strict-'));
    cleanups.push(() => rm(outputPath, { recursive: true, force: true }));
    const reportPath = join(outputPath, 'metadata-report.json');
    await writeFile(reportPath, JSON.stringify(minimalReport));

    await expect(
      runReplicate({
        serviceRootUri: server.url,
        strategy: 'TopAndSkip',
        bearerToken: 'test-token',
        metadataReportPath: reportPath,
        outputPath,
        version: '2.0',
        jsonSchemaValidation: true,
        strictMode: true,
        secondsDelayBetweenRequests: 0,
      }),
    ).rejects.toThrow(/[Ss]chema validation/);
  });

  it('rejects up front when schema validation is requested without a metadata report', async () => {
    await expect(
      runReplicate({
        serviceRootUri: 'http://localhost',
        strategy: 'TopAndSkip',
        bearerToken: 'test-token',
        resourceName: RESOURCE, // single-resource, no metadata
        outputPath: '.',
        jsonSchemaValidation: true,
      }),
    ).rejects.toThrow(/requires a metadata report/);
  });
});
