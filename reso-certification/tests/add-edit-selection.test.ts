import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStore } from '../src/add-edit/mock/handlers.js';
import { startMockServer, stopMockServer } from '../src/add-edit/mock/server.js';
import { createdKeyOf, runAllScenarios } from '../src/add-edit/test-runner.js';
import type { TestConfig } from '../src/test-runner/types.js';

/**
 * The runner against the mock, with every request it receives recorded: it runs only what it is given, updates and
 * deletes the record its create made when a payload names none, and never sends a write it has no record for.
 */

const metadataXml = readFileSync(resolve(import.meta.dirname, '../sample-metadata.xml'), 'utf-8');
const samplePayloads = (file: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../sample-payloads', file), 'utf-8'));

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

/** A payloads folder holding only the files given. */
const payloadsFolder = async (files: Readonly<Record<string, unknown>>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'add-edit-payloads-'));
  await Promise.all(Object.entries(files).map(([file, body]) => writeFile(join(dir, file), JSON.stringify(body))));
  return dir;
};

const run = (payloadsDir: string, options: Partial<TestConfig> = {}) =>
  runAllScenarios({ serverUrl, resource: 'Property', payloadsDir, auth: { mode: 'token', authToken: 'test-token' }, ...options });

const writes = (): ReadonlyArray<string> => sent.filter(line => /^(POST|PATCH|DELETE) /.test(line));
const scenarioNames = (report: Awaited<ReturnType<typeof run>>) => report.scenarios.map(s => s.scenario);

const CREATE_FILES = {
  'create-succeeds.json': samplePayloads('create-succeeds.json'),
  'create-fails.json': samplePayloads('create-fails.json')
};

describe('an Add/Edit run tests what it is given', () => {
  it('runs only the actions it is given, needing only their payload files', async () => {
    const report = await run(await payloadsFolder(CREATE_FILES), { actions: ['create'] });
    expect(scenarioNames(report)).toEqual(['create-succeeds-representation', 'create-succeeds-minimal', 'create-fails']);
    expect(report.summary).toMatchObject({ total: 3, passed: 3, failed: 0 });
    expect(writes().every(line => line.startsWith('POST '))).toBe(true);
  });

  it('runs only the formats it is given', async () => {
    const report = await run(await payloadsFolder(CREATE_FILES), { actions: ['create'], formats: { create: ['minimal'] } });
    expect(scenarioNames(report)).toEqual(['create-succeeds-minimal', 'create-fails']);
    expect(report.summary.passed).toBe(2);
  });

  it('names a payload file the run needs and does not have', async () => {
    await expect(run(await payloadsFolder(CREATE_FILES), { actions: ['create', 'update'] })).rejects.toThrow('has no update-succeeds.json');
    expect(writes()).toEqual([]);
  });

  it('refuses a selection it cannot test, before writing anything', async () => {
    await expect(run(await payloadsFolder(CREATE_FILES), { actions: [] })).rejects.toThrow('Choose at least one action');
    expect(writes()).toEqual([]);
  });
});

describe('an update or a delete whose payload names no record', () => {
  it('uses the record the run just created, and never one that was there before', async () => {
    seedStore('existing-0001', { ListingKey: 'existing-0001', ListPrice: 100000 });
    const report = await run(
      await payloadsFolder({
        ...CREATE_FILES,
        'update-succeeds.json': { ListPrice: 222222 },
        'update-fails.json': { ListPrice: -1 },
        'delete-succeeds.json': {},
        'delete-fails.json': { id: '00000000-0000-0000-0000-000000000000' }
      })
    );
    expect(report.summary).toMatchObject({ total: 8, failed: 0 });
    const created = sent.filter(line => line.startsWith('POST ')).length;
    expect(created).toBe(3);
    // Every update and delete went to a record by key, none to the record that was there before.
    const changed = writes().filter(line => !line.startsWith('POST '));
    expect(changed.every(line => /\/Property\('[^']+'\)/.test(line))).toBe(true);
    expect(changed.some(line => line.includes('existing-0001'))).toBe(false);
  });

  it('sends nothing when no create runs to make one, rather than writing to the whole collection', async () => {
    const report = await run(
      await payloadsFolder({ 'update-succeeds.json': { ListPrice: 222222 }, 'update-fails.json': { ListPrice: -1 } }),
      { actions: ['update'] }
    );
    expect(report.summary).toMatchObject({ total: 3, failed: 3 });
    expect(report.scenarios[0]?.assertions[0]?.actual).toContain('names no ListingKey');
    expect(writes()).toEqual([]);
  });

  it('never deletes to the collection for a delete that should fail and names no record', async () => {
    const report = await run(await payloadsFolder({ 'delete-succeeds.json': { id: 'gone-0001' }, 'delete-fails.json': {} }), {
      actions: ['delete']
    });
    const deleteFails = report.scenarios.find(s => s.scenario === 'delete-fails');
    expect(deleteFails?.passed).toBe(false);
    expect(writes().some(line => /DELETE \/Property$/.test(line))).toBe(false);
  });
});

describe('the key a create gives the record it made', () => {
  const entityType = { name: 'Property', keyProperties: ['ListingKey'], properties: [] };
  const response = (status: number, headers: Record<string, string>, body: unknown = undefined) => ({
    status,
    headers,
    body,
    rawBody: ''
  });

  it('is read from the record a representation create returns', () => {
    expect(createdKeyOf(response(201, {}, { ListingKey: 'L-1' }), entityType)).toBe('L-1');
  });

  it('is read from EntityId, which RESO defines as the key itself, quoted or not', () => {
    expect(createdKeyOf(response(204, { entityid: '197afaca-cc4f-4521-a321-8fa6d5bae17e' }), entityType)).toBe(
      '197afaca-cc4f-4521-a321-8fa6d5bae17e'
    );
    expect(createdKeyOf(response(204, { entityid: '"12345"' }), entityType)).toBe('12345');
  });

  it('is read from an entity URL when that is what the header holds', () => {
    expect(createdKeyOf(response(204, { location: "http://localhost/Property('O''Brien%20Way')" }), entityType)).toBe("O'Brien Way");
    expect(createdKeyOf(response(204, { 'odata-entityid': 'https://api.example.test/Property(123)' }), entityType)).toBe('123');
  });

  it('is nothing for a create that did not succeed', () => {
    expect(createdKeyOf(response(400, { entityid: 'L-1' }, { ListingKey: 'L-1' }), entityType)).toBeUndefined();
  });
});

describe('a resource other than Property', () => {
  // A resource keyed by its own key, as RCP-010's Open Houses, Showings, Member and Office are.
  const openHouseXml = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="OpenHouse">
        <Key><PropertyRef Name="OpenHouseKey"/></Key>
        <Property Name="OpenHouseKey" Type="Edm.String" MaxLength="255"/>
        <Property Name="OpenHouseRemarks" Type="Edm.String" MaxLength="500"/>
        <Property Name="OpenHouseAttendedBy" Type="Edm.Int64"/>
      </EntityType>
      <EntityContainer Name="Default">
        <EntitySet Name="OpenHouse" EntityType="org.reso.metadata.OpenHouse"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
  let openHouseServer: Server;
  let openHouseUrl: string;
  const openHouseSent: string[] = [];

  beforeAll(async () => {
    const mock = await startMockServer({ metadataXml: openHouseXml, resource: 'OpenHouse', port: 0 });
    openHouseServer = mock.server;
    openHouseUrl = mock.url;
    openHouseServer.on('request', request => openHouseSent.push(`${request.method} ${decodeURIComponent(request.url ?? '')}`));
  });

  afterAll(async () => {
    await stopMockServer(openHouseServer);
  });

  it('updates and deletes by its own key, the record its create made', async () => {
    const report = await runAllScenarios({
      serverUrl: openHouseUrl,
      resource: 'OpenHouse',
      payloadsDir: await payloadsFolder({
        'create-succeeds.json': { OpenHouseRemarks: 'Open Sunday', OpenHouseAttendedBy: 3 },
        'create-fails.json': { OpenHouseAttendedBy: -1 },
        'update-succeeds.json': { OpenHouseRemarks: 'Open Saturday' },
        'update-fails.json': { OpenHouseAttendedBy: -1 },
        'delete-succeeds.json': {},
        'delete-fails.json': { id: '00000000-0000-0000-0000-000000000000' }
      }),
      auth: { mode: 'token', authToken: 'test-token' },
      formats: { create: ['minimal'], update: ['minimal'] }
    });
    expect(report.summary).toMatchObject({ total: 6, failed: 0 });
    const changed = openHouseSent.filter(line => /^(PATCH|DELETE) /.test(line));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every(line => /\/OpenHouse\('[^']+'\)/.test(line))).toBe(true);
  });
});
