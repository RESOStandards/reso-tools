import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, stopMockServer } from '../../src/add-edit/mock/server.js';
import { runAddEditCompliance } from '../../src/sdk/add-edit.js';
import { serializeAddEditRemarks } from '../../src/sdk/reports.js';
import type { AddEditConfig, PipelineResult } from '../../src/sdk/types.js';

/**
 * The Add/Edit pipeline against the mock, with every request recorded. RCP-010 has those being certified "provide
 * known good and bad payloads", so a run needs the provider's payloads for each action it tests, and refuses
 * before writing anything when it has none. Auto payloads are the other way to run, as on the reference server and
 * the mock, and certify what they pass like any other run.
 */

const metadataXml = readFileSync(resolve(import.meta.dirname, '../../sample-metadata.xml'), 'utf-8');
const sample = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../sample-payloads', file), 'utf-8'));

let server: Server;
let serverUrl: string;
const sent: string[] = [];

beforeAll(async () => {
  const mock = await startMockServer({ metadataXml, resource: 'Property', port: 0 });
  server = mock.server;
  serverUrl = mock.url;
  server.on('request', request => sent.push(`${request.method} ${decodeURIComponent(request.url ?? '')}`));
});

afterAll(async () => {
  await stopMockServer(server);
});

beforeEach(() => {
  sent.length = 0;
});

let lastOutputDir = '';

/**
 * A run is told what to test (Josh, 2026-11-03), so a test that is about something else names a selection: the
 * actions it gives, or all three, with both formats for a create or an update among them. A test about the
 * selection itself passes its own.
 */
const BOTH = ['representation', 'minimal'] as const;
const selectionFor = (over: Partial<AddEditConfig>): Pick<AddEditConfig, 'actions' | 'formats'> => {
  const actions = over.actions ?? ['create', 'update', 'delete'];
  const formats =
    over.formats ??
    Object.fromEntries((['create', 'update'] as const).filter(action => actions.includes(action)).map(action => [action, [...BOTH]]));
  return { actions, formats };
};

const runWith = async (over: Partial<AddEditConfig>, selection: Pick<AddEditConfig, 'actions' | 'formats'> = selectionFor(over)) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'add-edit-run-'));
  lastOutputDir = outputDir;
  return runAddEditCompliance({
    endorsement: 'add-edit',
    server: { url: serverUrl, auth: { mode: 'token', authToken: 'test-token' } },
    resource: 'Property',
    options: { skipHealthCheck: true, outputDir },
    ...over,
    ...selection
  });
};

const stepOf = (result: PipelineResult, name: string) => result.steps.find(step => step.name === name);

/** The summary report the last run wrote, as a reader of the results would find it. */
const writtenReport = async (): Promise<Record<string, unknown>> => {
  const files = await readdir(lastOutputDir, { recursive: true });
  const report = files.find(file => file.endsWith('report.json') && !file.endsWith('detailed.json'));
  if (report === undefined) throw new Error(`No report.json under ${lastOutputDir}`);
  return JSON.parse(await readFile(join(lastOutputDir, report), 'utf-8'));
};
const payloadErrors = (result: PipelineResult): string => (stepOf(result, 'Generate payloads')?.errors ?? []).join(' ');
const writes = (): ReadonlyArray<string> => sent.filter(line => /^(POST|PATCH|DELETE) /.test(line));

const CREATE_PAYLOADS = { createSucceeds: sample('create-succeeds.json'), createFails: sample('create-fails.json') };

describe('an Add/Edit run that is not told what to test', () => {
  // Josh, 2026-11-03: running everything "could have unintended side effects, they may not expect us to try and delete
  // something". A run with payloads for every action still tests none of them unless it is told to.
  it('refuses before writing anything, naming what to choose', async () => {
    const everything = {
      ...CREATE_PAYLOADS,
      updateSucceeds: { ListPrice: 1 },
      updateFails: { ListPrice: -1 },
      deleteSucceeds: {},
      deleteFails: { id: '00000000-0000-0000-0000-000000000000' }
    };
    const unchosen = await runWith({ payloads: everything }, {});
    expect(payloadErrors(unchosen)).toContain('Choose the actions to test: create, update, delete. Nothing is tested unless it is chosen.');
    const noFormats = await runWith({ payloads: everything }, { actions: ['create', 'delete'] });
    expect(payloadErrors(noFormats)).toContain('Choose the create responses to test: representation, minimal.');
    expect(writes()).toEqual([]);
  });
});

describe('an Add/Edit run with no payloads, or with them given wrong', () => {
  it('refuses a run given no payloads, and writes nothing to the server', async () => {
    const result = await runWith({});
    expect(payloadErrors(result)).toContain('needs the payloads to test with');
    expect(stepOf(result, 'Run Add/Edit scenarios')?.errors).toEqual(['No test ran, because the payloads were not ready']);
    expect(result.certification.valid).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('still writes its report, which says the run failed and why', async () => {
    const result = await runWith({});
    expect(stepOf(result, 'Write reports')?.status).toBe('passed');
    expect(result.status).toBe('failed');
    const report = await writtenReport();
    expect(report.outcome).toBe('failed');
    expect(report.remarks).toContain('No test ran.');
    expect(serializeAddEditRemarks(result)).toBe(
      'No test ran. Add/Edit needs the payloads to test with: a payloads folder, or payloads in the configuration. Auto payloads are for the reference server and the mock.'
    );
  });

  it('refuses payloads given two ways', async () => {
    const result = await runWith({ payloads: CREATE_PAYLOADS, autoPayloads: true });
    expect(payloadErrors(result)).toContain('Give the payloads one way');
    expect(writes()).toEqual([]);
  });

  it('refuses a selection it cannot test', async () => {
    const result = await runWith({ actions: [], payloads: CREATE_PAYLOADS });
    expect(payloadErrors(result)).toContain('Choose at least one action');
    expect(writes()).toEqual([]);
  });

  it('refuses an update that names no record when no create runs to make one', async () => {
    const result = await runWith({ actions: ['update'], payloads: { updateSucceeds: { ListPrice: 1 }, updateFails: { ListPrice: -1 } } });
    expect(payloadErrors(result)).toContain('update-succeeds.json names no ListingKey');
    expect(writes()).toEqual([]);
  });

  it('refuses a missing payload for an action it tests, by file', async () => {
    const result = await runWith({ actions: ['create', 'delete'], payloads: CREATE_PAYLOADS });
    expect(payloadErrors(result)).toContain('Missing: delete-succeeds.json, delete-fails.json');
    expect(writes()).toEqual([]);
  });
});

describe('an Add/Edit run with the provider’s payloads', () => {
  it('certifies the actions it was given when every one passes, and its report says what was tested', async () => {
    const result = await runWith({ actions: ['create'], payloads: CREATE_PAYLOADS });
    expect(stepOf(result, 'Run Add/Edit scenarios')?.counts).toMatchObject({ total: 3, passed: 3, failed: 0 });
    expect(result.certification).toEqual({ valid: true });
    expect(serializeAddEditRemarks(result)).toContain('Tested create (representation, minimal)');
    expect(writes().every(line => line.startsWith('POST '))).toBe(true);
  });
});

describe('an Add/Edit run with auto payloads', () => {
  it('runs every action on the records it creates, and certifies what it passed like any other run', async () => {
    const result = await runWith({ autoPayloads: true });
    expect(stepOf(result, 'Run Add/Edit scenarios')?.counts).toMatchObject({ total: 8, failed: 0 });
    expect(result.certification).toEqual({ valid: true });
    expect(serializeAddEditRemarks(result)).toContain('Tested create (representation, minimal), update (representation, minimal), delete');
    expect(serializeAddEditRemarks(result)).toContain('The tool wrote the payloads');
  });

  it('writes them for Property only', async () => {
    const result = await runWith({ autoPayloads: true, resource: 'Lookup' });
    expect(payloadErrors(result)).toContain('Auto payloads are written for Property. For Lookup, give the payloads.');
    expect(writes()).toEqual([]);
  });
});
