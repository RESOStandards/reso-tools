/**
 * Full type coverage across resources (Josh, 2026-11-15). Coverage is always required, and the types a server has are
 * read across every resource it declares, whichever resources a run tests: "we need to make sure someone can't just
 * select a resource with one type, choose full coverage, and then pass". A run whose resources cannot meet a type the
 * server declares elsewhere fails at once, from the metadata, and says how to reach full coverage: "test another
 * resource that looks like it has full coverage (we could identify candidates), or have them test across all resources".
 *
 * And the strict option is gone: `--full-coverage` also failed a type the server does not have, which the rule does not
 * require. It is still accepted, and changes nothing.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCoreCompliance } from '../../src/sdk/core.js';
import type { CoreConfig } from '../../src/sdk/types.js';
import type { EntityProperty } from '../../src/test-runner/types.js';
import { coverageScanReason, resourceTypesOf, scanResourceCoverage } from '../../src/web-api-core/resource-coverage.js';

const LOOKUP = 'RESO.OData.Metadata.LookupName';
const prop = (name: string, type: string, annotations?: Readonly<Record<string, string>>): EntityProperty => ({
  name,
  type,
  ...(annotations && { annotations })
});

describe('the quick scan', () => {
  const PROPERTY = resourceTypesOf(
    'Property',
    [
      prop('ListPrice', 'Edm.Decimal'),
      prop('BedroomsTotal', 'Edm.Int32'),
      prop('CloseDate', 'Edm.Date'),
      prop('ModificationTimestamp', 'Edm.DateTimeOffset'),
      prop('StandardStatus', 'Edm.String', { [LOOKUP]: 'StandardStatus' }),
      prop('Appliances', 'Collection(Edm.String)', { [LOOKUP]: 'Appliances' })
    ],
    []
  );
  const MEMBER = resourceTypesOf(
    'Member',
    [prop('ModificationTimestamp', 'Edm.DateTimeOffset'), prop('MemberStatus', 'Edm.String', { [LOOKUP]: 'MemberStatus' })],
    []
  );
  const OFFICE = resourceTypesOf('Office', [prop('ModificationTimestamp', 'Edm.DateTimeOffset'), prop('OfficeCount', 'Edm.Int64')], []);

  it('reads every lookup form the specification allows', () => {
    const enumTypes: ReadonlyArray<CsdlEnumType> = [
      { name: 'Heating', isFlags: false, members: [] },
      { name: 'Cooling', isFlags: true, members: [] }
    ] as unknown as ReadonlyArray<CsdlEnumType>;
    const forms = resourceTypesOf(
      'Property',
      [
        prop('A', 'org.reso.metadata.enums.Heating'),
        prop('B', 'org.reso.metadata.enums.Cooling'),
        prop('C', 'Collection(org.reso.metadata.enums.Heating)')
      ],
      enumTypes
    );
    expect(forms.declared).toEqual(['singleLookup', 'multiLookup']);
  });

  it('flags nothing when the resources tested can meet every type the server declares', () => {
    expect(scanResourceCoverage([PROPERTY, MEMBER, OFFICE], ['Property']).unreachable).toEqual([]);
    expect(coverageScanReason(scanResourceCoverage([PROPERTY, MEMBER, OFFICE], ['Property']))).toBeUndefined();
  });

  it('flags a type declared only on resources the run does not test, and names a resource that has every type', () => {
    const scan = scanResourceCoverage([PROPERTY, MEMBER, OFFICE], ['Member']);
    expect(scan.unreachable).toEqual([
      { type: 'integer', declaredOn: ['Property', 'Office'] },
      { type: 'decimal', declaredOn: ['Property'] },
      { type: 'date', declaredOn: ['Property'] },
      { type: 'multiLookup', declaredOn: ['Property'] }
    ]);
    expect(scan.wholeResources).toEqual(['Property']);
    expect(coverageScanReason(scan)).toContain('Property declares every type the server has: test it');
  });

  it('says to test across resources when no one resource has every type', () => {
    const scan = scanResourceCoverage([MEMBER, OFFICE], ['Member']);
    expect(scan.unreachable).toEqual([{ type: 'integer', declaredOn: ['Office'] }]);
    expect(scan.wholeResources).toEqual([]);
    expect(coverageScanReason(scan)).toContain('No one resource declares every type the server has, so test across resources');
  });

  it('never flags a type a field of a tested resource could fill, even one the metadata does not count as declared', () => {
    // An empty LookupName: selection still reads the field as a lookup (resolveEnum), so the run can meet the type,
    // and the scan must not fail a run the coverage step could pass.
    const odd = resourceTypesOf('Member', [prop('MemberStatus', 'Edm.String', { [LOOKUP]: '' })], []);
    expect(odd.declared).toEqual([]);
    expect(odd.fillable).toEqual(['singleLookup']);
    const other = resourceTypesOf('Office', [prop('OfficeStatus', 'Edm.String', { [LOOKUP]: 'OfficeStatus' })], []);
    expect(scanResourceCoverage([odd, other], ['Member']).unreachable).toEqual([]);
  });
});

// ── A whole run against a fetch-level mock ──

const BASE = 'http://coverage-scan.local';
const NS = 'org.reso.metadata';

interface MockResource {
  readonly name: string;
  readonly key: string;
  readonly props: ReadonlyArray<readonly [string, string]>;
  readonly row: Readonly<Record<string, unknown>>;
}

const buildEdmx = (resources: ReadonlyArray<MockResource>): string => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="${NS}">
${resources
  .map(
    r => `      <EntityType Name="${r.name}">
        <Key><PropertyRef Name="${r.key}"/></Key>
        <Property Name="${r.key}" Type="Edm.String" MaxLength="255" Nullable="false"/>
${r.props.map(([name, type]) => `        <Property Name="${name}" Type="${type}"/>`).join('\n')}
      </EntityType>`
  )
  .join('\n')}
    </Schema>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Default">
      <EntityContainer Name="Container">
${resources.map(r => `        <EntitySet Name="${r.name}" EntityType="${NS}.${r.name}"/>`).join('\n')}
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const odataJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'odata-version': '4.01' } });

const pathOf = (url: string): string | undefined => {
  const parsed = new URL(url);
  return parsed.origin === BASE ? `${parsed.pathname.replace(/^\//, '')}${parsed.search}` : undefined;
};

const installMock = (resources: ReadonlyArray<MockResource>): void => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = pathOf(url);
    if (path === undefined) return odataJson({ value: [] }, 404);
    if (path.startsWith('$metadata')) {
      return new Response(buildEdmx(resources), { status: 200, headers: { 'content-type': 'application/xml', 'odata-version': '4.01' } });
    }
    if (path === '' || path.startsWith('?')) {
      return odataJson({
        '@odata.context': `${BASE}/$metadata`,
        value: resources.map(r => ({ name: r.name, kind: 'EntitySet', url: r.name }))
      });
    }
    const resource = resources.find(r => path.split(/[?(/]/)[0] === r.name);
    return resource ? odataJson({ value: [resource.row], '@odata.count': 1 }) : odataJson({ value: [] }, 404);
  });
};

const TS = '2026-01-01T00:00:00Z';
const PROPERTY: MockResource = {
  name: 'Property',
  key: 'ListingKey',
  props: [
    ['ListPrice', 'Edm.Int64'],
    ['CloseDate', 'Edm.Date'],
    ['ModificationTimestamp', 'Edm.DateTimeOffset']
  ],
  row: { ListingKey: '1', ListPrice: 100, CloseDate: '2025-06-01', ModificationTimestamp: TS }
};
const MEMBER: MockResource = {
  name: 'Member',
  key: 'MemberKey',
  props: [
    ['MemberCount', 'Edm.Int64'],
    ['ModificationTimestamp', 'Edm.DateTimeOffset']
  ],
  row: { MemberKey: '1', MemberCount: 3, ModificationTimestamp: TS }
};
const WIDGET: MockResource = {
  name: 'Widget',
  key: 'WidgetKey',
  props: [['WidgetDate', 'Edm.Date']],
  row: { WidgetKey: '1', WidgetDate: '2025-06-01' }
};

const makeConfig = (outputDir: string, over: Partial<CoreConfig> = {}): CoreConfig => ({
  endorsement: 'core',
  version: '2.1.0',
  server: { url: BASE, auth: { mode: 'token', authToken: 'test' } },
  options: { outputDir },
  ...over
});

describe('a Core run whose resources cannot meet every type the server has', () => {
  let outputDir = '';
  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'core-coverage-scan-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outputDir, { recursive: true, force: true });
  });

  it('fails at the metadata step when the one resource named lacks a type, and names a resource that has every type', async () => {
    installMock([PROPERTY, MEMBER]);
    const result = await runCoreCompliance(makeConfig(outputDir, { resources: ['Member'] }));

    const fetch = result.steps.find(s => s.name === 'Fetch metadata');
    expect(fetch?.status).toBe('failed');
    const reason = fetch?.errors?.find(e => e.includes('full type coverage cannot be met'));
    expect(reason).toContain('Declared on resources not tested: date on Property');
    expect(reason).toContain('Property declares every type the server has: test it');
    // The coverage step reaches the same verdict at the end: the scan only says it sooner.
    const scenarios = result.steps.find(s => s.name === 'Run Core scenarios');
    expect(scenarios?.errors?.some(e => e.includes('The server declares date'))).toBe(true);
    expect(result.status).toBe('failed');
  });

  it('fails at the metadata step when a type is declared only on a local resource a default run leaves out', async () => {
    installMock([MEMBER, WIDGET]);
    const result = await runCoreCompliance(makeConfig(outputDir));

    const fetch = result.steps.find(s => s.name === 'Fetch metadata');
    expect(fetch?.errors?.find(e => e.includes('full type coverage cannot be met'))).toContain('date on Widget');
  });

  it('raises nothing at the metadata step when the resources tested can meet every type', async () => {
    installMock([PROPERTY, MEMBER]);
    const result = await runCoreCompliance(makeConfig(outputDir, { resources: ['Property'] }));

    const fetch = result.steps.find(s => s.name === 'Fetch metadata');
    expect(fetch?.errors?.some(e => e.includes('full type coverage')) ?? false).toBe(false);
  });

  it('decides coverage the same with or without the old --full-coverage flag', async () => {
    // A server with no decimal, no date and no lookups anywhere: those types are not required.
    installMock([MEMBER]);
    const without = await runCoreCompliance(makeConfig(outputDir));
    const withFlag = await runCoreCompliance(makeConfig(outputDir, { fullCoverage: true }));

    const scenarios = (r: typeof without) => r.steps.find(s => s.name === 'Run Core scenarios');
    expect(scenarios(withFlag)?.status).toBe(scenarios(without)?.status);
    expect(scenarios(withFlag)?.errors ?? []).toEqual(scenarios(without)?.errors ?? []);
    expect(scenarios(withFlag)?.errors?.some(e => e.includes('Full coverage required')) ?? false).toBe(false);
    expect(scenarios(withFlag)?.summary).toContain('--full-coverage no longer changes anything');
  });
});
