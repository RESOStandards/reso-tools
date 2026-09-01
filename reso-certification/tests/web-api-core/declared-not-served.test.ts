/**
 * End-to-end guardrails for the Core 2.1.0 "declared-but-not-served" carve-out.
 *
 * A whole `runCoreCompliance` against a fetch-level mock, asserting the masking DECISION and — critically —
 * that a masked resource issues NO sampling request, while a resource under any doubt (surfaces disagree,
 * 2.0.0) is sampled and run exactly as today. The overriding rule is anti-false-PASS.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_WIDE_LABEL, runCoreCompliance } from '../../src/sdk/core.js';
import type { CoreConfig } from '../../src/sdk/types.js';
import type { ResourceTestReport } from '../../src/web-api-core/test-runner.js';

const BASE = 'http://mask.local';

// ── Custom EDMX + service-document mock ──

const RESOURCE_NS = 'org.reso.metadata';
const entityTypeXml = (name: string, keyField: string): string =>
  `      <EntityType Name="${name}">
        <Key><PropertyRef Name="${keyField}"/></Key>
        <Property Name="${keyField}" Type="Edm.String" MaxLength="255" Nullable="false"/>
        <Property Name="ListPrice" Type="Edm.Int64"/>
      </EntityType>`;
const entitySetXml = (name: string, type: string): string =>
  `        <EntitySet Name="${name}" EntityType="${RESOURCE_NS}.${type}"/>`;

/** Build a minimal, XSD/semantically-valid EDMX from a list of entity types + entity sets. */
const buildEdmx = (
  entityTypes: ReadonlyArray<readonly [string, string]>,
  entitySets: ReadonlyArray<readonly [string, string]>,
): string => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="${RESOURCE_NS}">
${entityTypes.map(([n, k]) => entityTypeXml(n, k)).join('\n')}
    </Schema>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Default">
      <EntityContainer Name="Container">
${entitySets.map(([n, t]) => entitySetXml(n, t)).join('\n')}
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const serviceDoc = (names: ReadonlyArray<string>): unknown => ({
  '@odata.context': `${BASE}/$metadata`,
  value: names.map(n => ({ name: n, kind: 'EntitySet', url: n })),
});

const SAMPLE_ROW = { ListingKey: '1', MediaKey: '1', OfficeKey: '1', MemberKey: '1', FieldKey: '1', LookupKey: '1', ListPrice: 100 };

interface MockOptions {
  readonly edmx: string;
  readonly serviceDoc: unknown;
  /** Resource names whose queries 404 (declared-but-not-served at the wire level). */
  readonly notFound?: ReadonlySet<string>;
}

interface InstalledMock {
  readonly calls: ReadonlyArray<string>;
  restore(): void;
}

const odataJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'odata-version': '4.01' } });

/** The resource segment of a path like `Property?$top=1000` / `Property('1')` / `Property/x`. */
const resourceOf = (path: string): string => path.split(/[?(/]/)[0];

const installMock = (opts: MockOptions): InstalledMock => {
  const calls: string[] = [];
  const notFound = opts.notFound ?? new Set<string>();
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    if (url.includes('/$metadata')) {
      return new Response(opts.edmx, { status: 200, headers: { 'content-type': 'application/xml', 'odata-version': '4.01' } });
    }
    const path = url.startsWith(BASE) ? url.slice(BASE.length).replace(/^\//, '') : url;
    if (path === '' || path.startsWith('?')) return odataJson(opts.serviceDoc);

    const res = resourceOf(path);
    if (res === 'ResourceNotFound' || notFound.has(res)) return odataJson({ value: [] }, 404);
    return odataJson({ value: [SAMPLE_ROW], '@odata.count': 1 });
  });
  return { calls, restore: () => spy.mockRestore() };
};

const makeConfig = (outputDir: string, over: Partial<CoreConfig>): CoreConfig => ({
  endorsement: 'core',
  version: '2.1.0',
  server: { url: BASE, auth: { mode: 'token', authToken: 'test' } },
  options: { outputDir },
  ...over,
});

const reportFor = (result: Awaited<ReturnType<typeof runCoreCompliance>>, resource: string): ResourceTestReport | undefined =>
  (result.context.resourceReports as ReadonlyArray<ResourceTestReport> | undefined)?.find(r => r.resource === resource);

const sampledResources = (calls: ReadonlyArray<string>): ReadonlyArray<string> =>
  calls.filter(u => u.includes('?$top=1000')).map(u => resourceOf(u.slice(BASE.length).replace(/^\//, '')));

describe('Core 2.1.0 declared-but-not-served carve-out (end-to-end)', () => {
  let outputDir = '';
  let mock: InstalledMock | undefined;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'core-mask-'));
  });
  afterEach(async () => {
    mock?.restore();
    mock = undefined;
    vi.restoreAllMocks();
    await rm(outputDir, { recursive: true, force: true });
  });

  it('2.1.0: a non-required well-known resource absent on BOTH surfaces → Not Applicable, NO sampling request', async () => {
    // Property is served; Media has an EntityType (declared shape) but no EntitySet and is absent from the doc.
    mock = installMock({
      edmx: buildEdmx([['Property', 'ListingKey'], ['Media', 'MediaKey']], [['Property', 'Property']]),
      serviceDoc: serviceDoc(['Property']),
      notFound: new Set(['Media']),
    });

    const result = await runCoreCompliance(makeConfig(outputDir, { version: '2.1.0', resources: ['Property', 'Media'] }));

    const media = reportFor(result, 'Media');
    expect(media?.scenarios).toHaveLength(1);
    expect(media?.scenarios[0].tag).toBe('resource-not-applicable');
    expect(media?.scenarios[0].skipped).toBe(true);
    expect(media?.scenarios[0].passed).toBe(true); // NA renders as a clean skip, never a failure
    expect(media?.summary.failed).toBe(0);
    expect(media?.deadlineReached).toBeUndefined();

    // The proof: masking issued NO sampling request for Media, but Property (served) WAS sampled.
    expect(sampledResources(mock.calls)).not.toContain('Media');
    expect(sampledResources(mock.calls)).toContain('Property');
  });

  it('2.1.0: a REQUIRED resource absent on BOTH surfaces → one clean FAIL, NO sampling request', async () => {
    mock = installMock({
      edmx: buildEdmx([['Property', 'ListingKey'], ['Member', 'MemberKey']], [['Member', 'Member']]),
      serviceDoc: serviceDoc(['Member']),
    });

    const result = await runCoreCompliance(makeConfig(outputDir, { version: '2.1.0', resources: ['Property'] }));

    const property = reportFor(result, 'Property');
    expect(property?.scenarios).toHaveLength(1); // ONE clean failure, not a 40-scenario 404 cascade
    expect(property?.scenarios[0].tag).toBe('required-resource-not-served');
    expect(property?.scenarios[0].passed).toBe(false);
    expect(property?.scenarios[0].skipped).toBe(false);
    expect(property?.summary.failed).toBe(1);
    expect(sampledResources(mock.calls)).not.toContain('Property'); // no sampling request
    expect(result.status).toBe('failed');
  });

  it('2.1.0: DECLARED as an EntitySet but 404ing + omitted from the service doc (surfaces DISAGREE) → runs + fails for real, never masked', async () => {
    // The anti-false-PASS guard: Property is a declared EntitySet (Surface 2 present) but the service doc
    // omits it (Surface 1 absent) and a GET 404s. It must stay in the run and fail for real.
    mock = installMock({
      edmx: buildEdmx([['Property', 'ListingKey'], ['Member', 'MemberKey']], [['Property', 'Property']]),
      serviceDoc: serviceDoc(['Member']),
      notFound: new Set(['Property']),
    });

    const result = await runCoreCompliance(makeConfig(outputDir, { version: '2.1.0', resources: ['Property'] }));

    const property = reportFor(result, 'Property');
    // It ran the full scenario set (not a 1-scenario masked stub) and produced real failures.
    expect(property?.scenarios.length ?? 0).toBeGreaterThan(1);
    expect(property?.scenarios.some(s => s.tag === 'resource-not-applicable' || s.tag === 'required-resource-not-served')).toBe(false);
    expect(property?.summary.failed ?? 0).toBeGreaterThan(0);
    expect(sampledResources(mock.calls)).toContain('Property'); // it WAS sampled — not masked
    expect(result.status).toBe('failed');
  });

  it('2.0.0: behavior UNCHANGED — a declared-but-not-served resource is still sampled + run (never masked)', async () => {
    // Identical topology to the NA test, but at 2.0.0 the carve-out is off: Media must be sampled as today.
    mock = installMock({
      edmx: buildEdmx([['Property', 'ListingKey'], ['Media', 'MediaKey']], [['Property', 'Property']]),
      serviceDoc: serviceDoc(['Property']),
      notFound: new Set(['Media']),
    });

    const result = await runCoreCompliance(makeConfig(outputDir, { version: '2.0.0', resources: ['Property', 'Media'] }));

    const media = reportFor(result, 'Media');
    // Media ran real scenarios (not the NA stub) and was sampled — exactly as before the carve-out.
    expect(media?.scenarios.some(s => s.tag === 'resource-not-applicable')).toBe(false);
    expect(media?.scenarios.length ?? 0).toBeGreaterThan(1);
    expect(sampledResources(mock.calls)).toContain('Media');
  });

  it('2.1.0: the provider-wide scenarios run ONCE even when EVERY resource is masked', async () => {
    // Only Office is served/declared; Property (required) and Media (well-known) are both absent on both
    // surfaces → all requested resources are masked. The provider pass must still run + record its scenarios.
    mock = installMock({
      edmx: buildEdmx([['Property', 'ListingKey'], ['Media', 'MediaKey'], ['Office', 'OfficeKey']], [['Office', 'Office']]),
      serviceDoc: serviceDoc(['Office']),
    });

    const result = await runCoreCompliance(makeConfig(outputDir, { version: '2.1.0', resources: ['Property', 'Media'] }));

    // The provider-wide scenarios were hoisted into a single synthetic report and both passed.
    const provider = reportFor(result, PROVIDER_WIDE_LABEL);
    const providerTags = provider?.scenarios.map(s => s.tag) ?? [];
    expect(providerTags).toContain('metadata');
    expect(providerTags).toContain('service-document');
    expect(provider?.scenarios.every(s => s.passed)).toBe(true);

    // They ran ONCE — no per-resource report carries a metadata / service-document scenario.
    const perResource = (result.context.resourceReports as ReadonlyArray<ResourceTestReport>).filter(r => r.resource !== PROVIDER_WIDE_LABEL);
    for (const r of perResource) {
      expect(r.scenarios.some(s => s.tag === 'metadata' || s.tag === 'service-document')).toBe(false);
    }

    // No masked resource was sampled; Property (required) forces the run to fail.
    expect(sampledResources(mock.calls)).toHaveLength(0);
    expect(reportFor(result, 'Property')?.scenarios[0].tag).toBe('required-resource-not-served');
    expect(reportFor(result, 'Media')?.scenarios[0].tag).toBe('resource-not-applicable');
    expect(result.status).toBe('failed');
  });
});
