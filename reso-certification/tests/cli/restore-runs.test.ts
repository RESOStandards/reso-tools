import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  NOTIFY_PROVIDER_PATH,
  type RunRestoreOptions,
  findStoredRuns,
  parseRunPath,
  projectMetadataReport,
  runRunRestore,
  runVerdict
} from '../../src/cli/restore-runs.js';

const ORIGIN = 'https://cert-api.example.org';

const metadataReport = {
  description: 'Data Dictionary Metadata',
  version: '2.1',
  generatedOn: '2026-11-11T08:51:00.000Z',
  fields: [{ resourceName: 'Property', fieldName: 'ListPrice' }],
  lookups: [],
  resources: [{ resourceName: 'Property' }],
  actions: [],
  functions: []
};
const availabilityReport = { resources: [{ resourceName: 'Property', numRecordsFetched: 3 }] };
const passed = { description: 'Data Dictionary', version: '2.1', generatedOn: '2026-11-11T08:51:00.000Z', remarks: '', outcome: 'passed' };

/** A stored run in the layout the results store keeps, under a fresh root. */
const storedRun = (
  root: string,
  options: { readonly endorsement?: string; readonly provider?: string; readonly run?: string; readonly summary?: unknown } = {}
): string => {
  const dir = join(
    root,
    'production',
    options.endorsement ?? 'data-dictionary-2.1',
    options.provider ?? 'PROVIDER-501',
    'RECIPIENT',
    options.run ?? 'run-1'
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata-report.json'), JSON.stringify(metadataReport));
  writeFileSync(join(dir, 'data-availability-report.json'), JSON.stringify(availabilityReport));
  writeFileSync(join(dir, 'report.json'), JSON.stringify(options.summary ?? passed));
  return dir;
};

const freshRoot = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'reso-runs-')));

const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

/** A Cert API that issues report ids in order and records every request. */
const certApi = (overrides: { readonly create?: Response; readonly availability?: Response; readonly notify?: Response } = {}) => {
  let issued = 0;
  return vi.fn(async (url: string, _init: RequestInit) => {
    if (url.includes('/certification_reports/')) {
      issued += 1;
      return overrides.create ?? reply(200, { id: `report-${issued}` });
    }
    if (url.includes('/payload/data_availability/')) return overrides.availability ?? reply(200, { ok: true });
    if (url.endsWith(NOTIFY_PROVIDER_PATH)) return overrides.notify ?? reply(200, { ok: true });
    throw new Error(`unexpected request ${url}`);
  });
};

const restore = async (
  root: string,
  overrides: Partial<RunRestoreOptions> = {}
): Promise<{ readonly result: Awaited<ReturnType<typeof runRunRestore>>; readonly recorded: string[]; readonly lines: string[] }> => {
  const recorded: string[] = [];
  const lines: string[] = [];
  const result = await runRunRestore(
    {
      path: root,
      origin: ORIGIN,
      execute: false,
      notifyProvider: false,
      done: new Set(),
      record: key => recorded.push(key),
      authorize: async () => 'Bearer minted-token',
      ...overrides
    },
    line => lines.push(line)
  );
  return { result, recorded, lines };
};

describe('parseRunPath', () => {
  it('reads the endorsement, version, provider, system, recipient and run from the stored layout', () => {
    expect(parseRunPath('/x/production/data-dictionary-2.1/PROVIDER-501/RECIPIENT/run-1')).toEqual({
      endorsement: 'data-dictionary',
      version: '2.1',
      providerUoi: 'PROVIDER',
      providerUsi: '501',
      recipientUoi: 'RECIPIENT',
      runId: 'run-1'
    });
  });

  it('takes the provider and system from the last dash, and the version from the dash before the first digit', () => {
    expect(parseRunPath('/x/web-api-core-2.0.0/SOME-PROVIDER-77/R/run')).toMatchObject({
      endorsement: 'web-api-core',
      version: '2.0.0',
      providerUoi: 'SOME-PROVIDER',
      providerUsi: '77'
    });
  });

  it('refuses a path without the stored layout rather than guessing whose run it is', () => {
    expect(parseRunPath('/x/loose/run')).toBeUndefined();
    expect(parseRunPath('/x/data-dictionary/PROVIDER-501/RECIPIENT/run-1')).toBeUndefined();
    expect(parseRunPath('/x/data-dictionary-2.1/PROVIDER/RECIPIENT/run-1')).toBeUndefined();
  });
});

describe('findStoredRuns', () => {
  it('finds every run under any directory above it, keyed relative to that directory', () => {
    const root = freshRoot();
    storedRun(root, { run: 'run-1' });
    storedRun(root, { run: 'run-2' });
    const { runs, unplaced } = findStoredRuns(join(root, 'production', 'data-dictionary-2.1'));
    expect(runs.map(r => r.key)).toEqual([join('PROVIDER-501', 'RECIPIENT', 'run-1'), join('PROVIDER-501', 'RECIPIENT', 'run-2')]);
    expect(unplaced).toEqual([]);
  });

  it('accepts the run directory itself', () => {
    const dir = storedRun(freshRoot());
    expect(findStoredRuns(dir).runs.map(r => r.runId)).toEqual(['run-1']);
  });

  it("reports a directory with a run's files but no stored layout, and does not treat it as a run", () => {
    const root = freshRoot();
    const loose = join(root, 'loose');
    mkdirSync(loose);
    for (const name of ['metadata-report.json', 'data-availability-report.json', 'report.json']) writeFileSync(join(loose, name), '{}');
    expect(findStoredRuns(root)).toEqual({ runs: [], unplaced: [loose] });
  });

  it('finds nothing in a backup, whose reports are compressed documents, not run files', () => {
    const root = freshRoot();
    const backup = join(root, 'data_dictionary-2.0', 'PROVIDER-501', 'RECIPIENT');
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'metadata-report.json.gz'), '');
    expect(findStoredRuns(root)).toEqual({ runs: [], unplaced: [] });
  });
});

describe('runVerdict', () => {
  it('publishes only a passed, certifiable run', () => {
    expect(runVerdict(passed)).toEqual({ publishable: true });
    expect(runVerdict({ ...passed, outcome: 'failed' })).toMatchObject({ publishable: false, reason: expect.stringMatching(/failed/) });
    expect(runVerdict({ ...passed, certification: { valid: false, reasons: ['x'] } })).toMatchObject({
      publishable: false,
      reason: expect.stringMatching(/not eligible/)
    });
    expect(runVerdict(null)).toMatchObject({ publishable: false });
  });
});

describe('projectMetadataReport', () => {
  it('keeps the keys the route accepts and names the ones it would refuse', () => {
    const { body, droppedKeys } = projectMetadataReport(metadataReport);
    expect(Object.keys(body).sort()).toEqual(['description', 'fields', 'generatedOn', 'lookups', 'version']);
    expect(droppedKeys).toEqual(['actions', 'functions', 'resources']);
  });

  it('refuses a report missing a key the route requires', () => {
    expect(() => projectMetadataReport({ description: 'x', version: '2.1' })).toThrow(/generatedOn/);
  });
});

describe('runRunRestore', () => {
  it('sends nothing and asks for no credential on a dry run', async () => {
    const root = freshRoot();
    storedRun(root);
    const api = certApi();
    const authorize = vi.fn(async () => 'Bearer minted-token');
    const { result, recorded } = await restore(root, { fetchFn: api, authorize });
    expect(result.outcomes.map(o => o.status)).toEqual(['would-publish']);
    expect(result.outcomes[0]?.droppedKeys).toEqual(['actions', 'functions', 'resources']);
    expect(api).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('publishes as the run would have: the metadata post, then the availability post against its id', async () => {
    const root = freshRoot();
    storedRun(root);
    const api = certApi();
    const { result, recorded } = await restore(root, { execute: true, fetchFn: api });
    expect(result.outcomes).toMatchObject([{ status: 'published', reportId: 'report-1' }]);

    const [create, availability] = api.mock.calls;
    expect(create?.[0]).toBe(`${ORIGIN}/api/v1/certification_reports/data_dictionary/PROVIDER`);
    expect(create?.[1].headers).toMatchObject({
      Authorization: 'Bearer minted-token',
      recipientUoi: 'RECIPIENT',
      providerUsi: '501',
      send_notification: 'false'
    });
    expect(Object.keys(JSON.parse(String(create?.[1].body)))).not.toContain('resources');
    expect(availability?.[0]).toBe(`${ORIGIN}/api/v1/payload/data_availability/report-1`);
    expect(JSON.parse(String(availability?.[1].body))).toEqual(availabilityReport);
    expect(api).toHaveBeenCalledTimes(2);
    expect(recorded).toEqual([join('production', 'data-dictionary-2.1', 'PROVIDER-501', 'RECIPIENT', 'run-1')]);
  });

  it('emails the provider only when asked, and only after both reports are on file', async () => {
    const root = freshRoot();
    storedRun(root);
    const api = certApi();
    await restore(root, { execute: true, notifyProvider: true, fetchFn: api });
    expect(api.mock.calls.map(call => call[0])).toEqual([
      `${ORIGIN}/api/v1/certification_reports/data_dictionary/PROVIDER`,
      `${ORIGIN}/api/v1/payload/data_availability/report-1`,
      `${ORIGIN}${NOTIFY_PROVIDER_PATH}`
    ]);
    expect(JSON.parse(String(api.mock.calls[2]?.[1].body))).toEqual({ id: 'report-1' });
  });

  it('refuses a failed run and an endorsement other than Data Dictionary, and sends nothing for either', async () => {
    const root = freshRoot();
    storedRun(root, { run: 'failed-run', summary: { ...passed, outcome: 'failed' } });
    storedRun(root, { endorsement: 'web-api-core-2.1.0', run: 'core-run' });
    const api = certApi();
    const { result } = await restore(root, { execute: true, fetchFn: api });
    expect(result.outcomes.map(o => o.status)).toEqual(['refused', 'refused']);
    expect(api).not.toHaveBeenCalled();
  });

  it('skips a run the ledger already holds', async () => {
    const root = freshRoot();
    storedRun(root);
    const api = certApi();
    const key = join('production', 'data-dictionary-2.1', 'PROVIDER-501', 'RECIPIENT', 'run-1');
    const { result } = await restore(root, { execute: true, fetchFn: api, done: new Set([key]) });
    expect(result.outcomes.map(o => o.status)).toEqual(['already-done']);
    expect(api).not.toHaveBeenCalled();
  });

  it("reports a refused post with the server's reason, records nothing, and goes on to the next run", async () => {
    const root = freshRoot();
    storedRun(root, { run: 'run-1' });
    storedRun(root, { run: 'run-2' });
    const api = vi.fn(async (url: string) =>
      url.includes('/certification_reports/') ? reply(400, 'Invalid report body') : reply(200, { ok: true })
    );
    const { result, recorded } = await restore(root, { execute: true, fetchFn: api });
    expect(result.outcomes.map(o => o.status)).toEqual(['failed', 'failed']);
    expect(result.outcomes[0]?.reason).toMatch(/HTTP 400 Invalid report body/);
    expect(recorded).toEqual([]);
  });

  it('asks for the credential once, however many runs it sends', async () => {
    const root = freshRoot();
    storedRun(root, { run: 'run-1' });
    storedRun(root, { run: 'run-2' });
    const authorize = vi.fn(async () => 'Bearer minted-token');
    await restore(root, { execute: true, fetchFn: certApi(), authorize });
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});
