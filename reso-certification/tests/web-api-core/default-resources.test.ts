/**
 * Which resources a Core run tests (Josh, 2026-11-12): "It should be every RESO resource, we can't expect their local
 * ones to be compliant", unless the run names them ("anyone can choose a subset anyway").
 *
 * Before, a run that named none tested six listing resources (Property, Member, Office, Media, OpenHouse, Showing). RESO's
 * own Web API serves OUID, Lookup and EntityEvent, so its run asked for nothing and reported "No resource returned any
 * records", with the cause left on a step that passed. A whole `runCoreCompliance` against a fetch-level mock.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_RESOURCE_RECORDS, declaredResourcesOf, noRecordsReason, runCoreCompliance } from '../../src/sdk/core.js';
import type { CoreConfig } from '../../src/sdk/types.js';
import type { ParsedMetadata } from '../../src/test-runner/types.js';

const BASE = 'http://default-resources.local';
const NS = 'org.reso.metadata';

const entityTypeXml = (name: string, keyField: string): string =>
  `      <EntityType Name="${name}">
        <Key><PropertyRef Name="${keyField}"/></Key>
        <Property Name="${keyField}" Type="Edm.String" MaxLength="255" Nullable="false"/>
        <Property Name="ListPrice" Type="Edm.Int64"/>
      </EntityType>`;

/** A minimal valid EDMX: one entity type and one entity set of the same name per resource. */
const buildEdmx = (resources: ReadonlyArray<readonly [string, string]>): string => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="${NS}">
${resources.map(([name, key]) => entityTypeXml(name, key)).join('\n')}
    </Schema>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Default">
      <EntityContainer Name="Container">
${resources.map(([name]) => `        <EntitySet Name="${name}" EntityType="${NS}.${name}"/>`).join('\n')}
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const SAMPLE_ROW = { ListingKey: '1', MemberKey: '1', TeamKey: '1', WidgetKey: '1', GadgetKey: '1', ListPrice: 100 };

const odataJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'odata-version': '4.01' } });

const resourceOf = (path: string): string => path.split(/[?(/]/)[0];

const installMock = (resources: ReadonlyArray<readonly [string, string]>): { readonly calls: ReadonlyArray<string> } => {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes('/$metadata')) {
      return new Response(buildEdmx(resources), { status: 200, headers: { 'content-type': 'application/xml', 'odata-version': '4.01' } });
    }
    const path = url.startsWith(BASE) ? url.slice(BASE.length).replace(/^\//, '') : url;
    if (path === '' || path.startsWith('?')) {
      return odataJson({ '@odata.context': `${BASE}/$metadata`, value: resources.map(([n]) => ({ name: n, kind: 'EntitySet', url: n })) });
    }
    if (resourceOf(path) === 'ResourceNotFound') return odataJson({ value: [] }, 404);
    return odataJson({ value: [SAMPLE_ROW], '@odata.count': 1 });
  });
  return { calls };
};

const sampled = (calls: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(calls.filter(u => u.includes('?$top=1000')).map(u => resourceOf(u.slice(BASE.length).replace(/^\//, ''))))
];

const makeConfig = (outputDir: string, over: Partial<CoreConfig> = {}): CoreConfig => ({
  endorsement: 'core',
  version: '2.1.0',
  server: { url: BASE, auth: { mode: 'token', authToken: 'test' } },
  options: { outputDir },
  ...over
});

describe('the resources a Core run tests', () => {
  let outputDir = '';
  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'core-default-resources-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outputDir, { recursive: true, force: true });
  });

  it('with none named, tests every Data Dictionary resource the server declares, and leaves local ones out by name', async () => {
    // Teams is a Data Dictionary resource outside the six listing resources the old default tested.
    const mock = installMock([
      ['Property', 'ListingKey'],
      ['Member', 'MemberKey'],
      ['Teams', 'TeamKey'],
      ['Widget', 'WidgetKey']
    ]);
    const result = await runCoreCompliance(makeConfig(outputDir));

    expect([...sampled(mock.calls)].sort()).toEqual(['Member', 'Property', 'Teams']);
    const fetch = result.steps.find(s => s.name === 'Fetch metadata');
    expect(fetch?.summary).toContain('testing the 3 RESO resources it declares, not Widget');
  });

  it('with none named and no Data Dictionary resource declared, says so instead of "no resource returned any records"', async () => {
    installMock([
      ['Widget', 'WidgetKey'],
      ['Gadget', 'GadgetKey']
    ]);
    const result = await runCoreCompliance(makeConfig(outputDir, { fullCoverage: true }));

    const scenarios = result.steps.find(s => s.name === 'Run Core scenarios');
    expect(scenarios?.status).toBe('failed');
    expect(scenarios?.errors).toEqual([
      "The server's metadata declares no Data Dictionary resource, so no records were requested. Resources it declares: Widget, Gadget. Name the resources to test. A system can only be certified on records it serves."
    ]);
    // Nothing was tested, so coverage was not measured: no type is reported missing, and coverage fails nothing.
    expect(scenarios?.summary).toContain('Type coverage was not measured: no records were tested');
    expect(scenarios?.summary).not.toContain('Missing coverage');
    expect(result.status).toBe('failed');
  });

  it('names the resources a run asked for that the metadata does not declare', async () => {
    installMock([['Widget', 'WidgetKey']]);
    const result = await runCoreCompliance(makeConfig(outputDir, { resources: ['Property', 'Member'] }));

    const scenarios = result.steps.find(s => s.name === 'Run Core scenarios');
    expect(scenarios?.errors?.[0]).toBe(
      "None of the resources named for this run is in the server's metadata (Property, Member), so no records were requested. Resources the metadata declares: Widget. A system can only be certified on records it serves."
    );
  });

  it('tests exactly the resources a run names, local ones included', async () => {
    const mock = installMock([
      ['Property', 'ListingKey'],
      ['Member', 'MemberKey'],
      ['Widget', 'WidgetKey']
    ]);
    await runCoreCompliance(makeConfig(outputDir, { resources: ['Widget'] }));

    expect(sampled(mock.calls)).toEqual(['Widget']);
  });
});

describe('the pieces', () => {
  const metadata = (over: Partial<ParsedMetadata>): ParsedMetadata => ({
    namespace: NS,
    entityTypes: [
      { name: 'Property', properties: [] },
      { name: 'Widget', properties: [] }
    ],
    enumTypes: [],
    ...over
  });

  it('reads the declared resources from the entity sets, and from the entity types only with no container', () => {
    expect(declaredResourcesOf(metadata({ entitySets: [{ name: 'Property', entityType: 'Property' }] }))).toEqual(['Property']);
    expect(declaredResourcesOf(metadata({}))).toEqual(['Property', 'Widget']);
  });

  it('keeps the old reason when resources were requested and returned nothing', () => {
    expect(noRecordsReason({ resources: ['Property'], resourcesNamed: false })).toBe(NO_RESOURCE_RECORDS);
  });
});
