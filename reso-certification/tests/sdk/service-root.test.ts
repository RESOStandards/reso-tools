/**
 * A service root may be given with a trailing slash (`http://127.0.0.1:8801/`). The engine joined paths onto it as
 * text, so a Web API Core run requested `http://127.0.0.1:8801//Property`, which a server is free to answer 404. The
 * root is normalized where a run starts and where a request URL is built from it: the slash at the end of its path
 * goes, and a query or fragment is left as it was given.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReplicate } from '../../src/cli/replicate-command.js';
import { runAddEditCompliance } from '../../src/sdk/add-edit.js';
import { runCoreCompliance } from '../../src/sdk/core.js';
import { runDDCompliance } from '../../src/sdk/dd.js';
import { runEntityEventCompliance } from '../../src/sdk/entity-event.js';
import type { AddEditConfig, CoreConfig, DDConfig, EntityEventConfig } from '../../src/sdk/types.js';
import { normalizeServiceRoot } from '../../src/test-runner/service-root.js';
import { buildLookupUrl, buildScenarioQuery } from '../../src/web-api-core/queries.js';
import { installCoreMockServer } from '../helpers/core-mock-server.js';
import { startReplicationMockServer } from '../legacy/replication-mock-server.js';

const BASE = 'http://service-root.local';
const AUTH = { mode: 'token', authToken: '<sentinel_token>' } as const;

let outputDir = '';
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'service-root-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await rm(outputDir, { recursive: true, force: true });
});

/** The path and query of each request, in order, with anything outside the server left out. */
const pathsOf = (calls: ReadonlyArray<string>): ReadonlyArray<string> =>
  calls.filter(call => call.startsWith(BASE)).map(call => call.slice(BASE.length));

// The rule itself. These add to the run-level tests below and are not their control: the function is new.
describe('normalizing a service root', () => {
  it.each([
    ['http://127.0.0.1:8801/', 'http://127.0.0.1:8801'],
    ['http://127.0.0.1:8801', 'http://127.0.0.1:8801'],
    ['https://api.example.org/odata/', 'https://api.example.org/odata'],
    ['https://api.example.org/odata//', 'https://api.example.org/odata'],
    ['https://api.example.org/odata', 'https://api.example.org/odata'],
    ['https://API.example.org:443/OData/', 'https://API.example.org:443/OData']
  ])('drops the slash at the end of the path: %s', (given, expected) => {
    expect(normalizeServiceRoot(given)).toBe(expected);
    expect(normalizeServiceRoot(expected)).toBe(expected);
  });

  it.each([
    ['https://api.example.org/odata/?key=a/', 'https://api.example.org/odata?key=a/'],
    ['https://api.example.org/odata?path=/x/', 'https://api.example.org/odata?path=/x/'],
    ['https://api.example.org/odata/#section/', 'https://api.example.org/odata#section/'],
    ['https://api.example.org/?a=1#b/', 'https://api.example.org?a=1#b/'],
    ['https://api.example.org?next=http://other.example.org/', 'https://api.example.org?next=http://other.example.org/']
  ])('leaves a query and a fragment as given: %s', (given, expected) => {
    expect(normalizeServiceRoot(given)).toBe(expected);
  });

  it.each([
    ['', ''],
    ['http://', 'http://'],
    ['not a url', 'not a url']
  ])('returns what is not a root as given: %j', (given, expected) => {
    expect(normalizeServiceRoot(given)).toBe(expected);
  });
});

describe('a Web API Core run on a service root with a trailing slash', () => {
  const coreConfig = (url: string): CoreConfig => ({
    endorsement: 'core',
    version: '2.1.0',
    resources: ['Property'],
    server: { url, auth: AUTH },
    options: { outputDir }
  });
  const servedRows = { resourceBody: { value: [{ ListingKey: 'K1', ListingId: 'L1' }], '@odata.count': 1 } };

  it('requests no path that starts with two slashes', async () => {
    const mock = installCoreMockServer(BASE, servedRows);
    await runCoreCompliance(coreConfig(`${BASE}/`));

    const paths = pathsOf(mock.calls);
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.filter(path => path.startsWith('//'))).toEqual([]);
  });

  it('requests the same resource paths as the run without the slash', async () => {
    // The path up to its query: a query can carry the time of the run, which differs between two runs.
    const resourcePaths = (calls: ReadonlyArray<string>): ReadonlyArray<string> =>
      [...new Set(pathsOf(calls).map(path => path.split('?')[0]))].sort();

    const plain = installCoreMockServer(BASE, servedRows);
    await runCoreCompliance(coreConfig(BASE));
    const expected = resourcePaths(plain.calls);
    plain.restore();

    const slashed = installCoreMockServer(BASE, servedRows);
    await runCoreCompliance(coreConfig(`${BASE}/`));
    expect(resourcePaths(slashed.calls)).toEqual(expected);
  });

  it('builds a scenario query and a Lookup query on the root, not on the root and a slash', () => {
    const params = { keyField: 'ListingKey', keyValue: 'K1' } as unknown as Parameters<typeof buildScenarioQuery>[3];
    const byKey = { id: 'fetch-by-key', category: 'structural', assertion: 'fetch-by-key' } as unknown as Parameters<
      typeof buildScenarioQuery
    >[2];
    expect(buildScenarioQuery('http://127.0.0.1:8801/', 'Property', byKey, params)?.url).toBe("http://127.0.0.1:8801/Property('K1')");
    expect(buildLookupUrl('http://127.0.0.1:8801/', 'StandardStatus')).toBe(buildLookupUrl('http://127.0.0.1:8801', 'StandardStatus'));
    expect(buildLookupUrl('http://127.0.0.1:8801/', 'StandardStatus')).toMatch(/^http:\/\/127\.0\.0\.1:8801\/Lookup\?/);
  });
});

describe('each compliance entry point starts its run on the normalized root', () => {
  // The run's context is what every step builds its requests from, and what the reports record as the server.
  const options = { outputDir, skipHealthCheck: true };
  const server = { url: `${BASE}/`, auth: AUTH };

  it('Web API Core', async () => {
    installCoreMockServer(BASE);
    const result = await runCoreCompliance({
      endorsement: 'core',
      version: '2.1.0',
      resources: ['Property'],
      server,
      options: { ...options, outputDir }
    });
    expect(result.context.serverUrl).toBe(BASE);
  });

  it('Data Dictionary', async () => {
    installCoreMockServer(BASE);
    const config = { endorsement: 'dd', version: '2.0', runVariations: false, requestDelay: 0, server, options: { ...options, outputDir } };
    const result = await runDDCompliance(config as unknown as DDConfig);
    expect(result.context.serverUrl).toBe(BASE);
  });

  it('EntityEvent', async () => {
    // metadata that cannot be read ends the run at its first step, which is all this needs
    installCoreMockServer(BASE, { metadataStatus: 500 });
    const config = { endorsement: 'entity-event', server, options: { ...options, outputDir } };
    const result = await runEntityEventCompliance(config as unknown as EntityEventConfig);
    expect(result.context.serverUrl).toBe(BASE);
  });

  it('Add/Edit', async () => {
    installCoreMockServer(BASE);
    const config = { endorsement: 'add-edit', resource: 'Property', payloads: {}, server, options: { ...options, outputDir } };
    const result = await runAddEditCompliance(config as unknown as AddEditConfig);
    expect(result.context.serverUrl).toBe(BASE);
  });
});

describe('the replicate command on a service root with a trailing slash', () => {
  const metadataReport = {
    description: 'service-root-test',
    version: '2.0',
    generatedOn: '2024-01-01T00:00:00.000Z',
    resources: [{ resourceName: 'Property' }],
    fields: [
      { resourceName: 'Property', fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
      { resourceName: 'Property', fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset', annotations: [] }
    ],
    lookups: [],
    actions: [],
    functions: []
  };

  /** One run of the command; returns the responses report it wrote. */
  const responsesReportOf = async (url: string, folder: string) => {
    const outputPath = join(outputDir, folder);
    const reportPath = join(outputDir, `${folder}-metadata-report.json`);
    await mkdir(outputPath);
    await writeFile(reportPath, JSON.stringify(metadataReport));
    await runReplicate({
      serviceRootUri: url,
      strategy: 'TopAndSkip',
      bearerToken: '<sentinel_token>',
      metadataReportPath: reportPath,
      outputPath,
      version: '2.0',
      secondsDelayBetweenRequests: 0
    });
    return JSON.parse(await readFile(join(outputPath, 'data-availability-responses.json'), 'utf-8')) as {
      serviceRootUri: string;
      responses: ReadonlyArray<{ requestUri: string }>;
    };
  };

  it('records the root and each request as the run without the slash does', async () => {
    const server = await startReplicationMockServer({
      resource: 'Property',
      records: [{ ListingKey: 'P1', ModificationTimestamp: '2024-01-01T00:00:00.000Z' }]
    });
    cleanups.push(server.close);

    const plain = await responsesReportOf(server.url, 'plain');
    const slashed = await responsesReportOf(`${server.url}/`, 'slashed');
    expect(plain.responses.map(response => response.requestUri)).toEqual(['/Property?$top=100&$skip=0']);
    expect(slashed.serviceRootUri).toBe(server.url);
    expect(slashed.responses.map(response => response.requestUri)).toEqual(plain.responses.map(response => response.requestUri));
  });
});
