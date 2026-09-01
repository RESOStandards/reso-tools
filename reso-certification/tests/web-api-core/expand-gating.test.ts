import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { generateMetadataReport } from '@reso-standards/reso-metadata-utils';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import type { ExpandScenario } from '../../src/web-api-core/scenarios.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import {
  runExpandNavScenarios,
  validateExpandedItems,
  summarizeScenarios,
} from '../../src/web-api-core/test-runner.js';
import { createExpandSchemaValidator } from '../../src/sdk/expand-schema.js';
import { coreVerdict } from '../../src/sdk/core.js';

// FULL Core 2.1.0 $expand gating. THE RULE (RESO standards lead): $expand is tested per declared COLLECTION
// navigation property. No nav → N/A skip (never a failure). A declared collection nav is GATING: non-200 →
// FAIL; 200 → schema-validate each expanded child item against its target entity type (a schema-invalid item →
// FAIL). The RRK expanded-item warning still rides alongside, non-gating. A compliant server never false-fails.

const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));
// A real DD 2.0 metadata report → a real legacy-backed validator. `Property` is a real resource in the report,
// so we schema-validate expanded items against it (the nav→target wiring is what's under test, not the nav's
// real-world semantics). AboveGradeFinishedAreaSource is a single enum with advertised values: 'Appraiser' is
// valid, 'InvalidEnum' is a real schema-invalid fixture.
const report = getReferenceMetadata('2.0');

const expandScenario: ExpandScenario = {
  tag: 'expand',
  name: '$expand navigation property',
  category: 'expand',
  fieldParam: 'expandField',
  minVersion: '2.1.0',
};

type Nav = { readonly name: string; readonly targetType: string };

const paramsFor = (navs: ReadonlyArray<Nav>): TestParams => ({
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: 'P1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
  expandField: navs[0]?.name,
  expandNavs: navs,
});

// One parent Property (ListingKey P1) whose expanded collection under `navField` is exactly `children`.
const okExpand = (children: unknown, navField = 'Media'): ODataResponse => {
  const body = { value: [{ ListingKey: 'P1', [navField]: children }] };
  return { status: 200, headers: { 'odata-version': '4.01' }, body, rawBody: JSON.stringify(body) };
};

const status = (code: number): ODataResponse => ({
  status: code,
  headers: { 'odata-version': '4.01' },
  body: { error: { code: String(code) } },
  rawBody: '{}',
});

// A requester that dispatches by which nav is being expanded (matches `$expand=<nav>` in the URL).
const requesterFor = (byNav: Readonly<Record<string, ODataResponse>>): ODataRequester => ({
  request: async ({ url }) => {
    const nav = Object.keys(byNav).find((n) => url.includes(`$expand=${n}`));
    if (!nav) throw new Error(`no scripted response for ${url}`);
    return byNav[nav];
  },
});

// Guards the "no request should be made" cases.
const throwingRequester: ODataRequester = {
  request: async () => {
    throw new Error('no request should have been issued');
  },
};

describe('runExpandNavScenarios — no collection nav → N/A skip (never a failure)', () => {
  it('a resource with no collection nav yields one SKIPPED result and issues no request', async () => {
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([]), 'tok', throwingRequester);
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].passed).toBe(true); // a skip renders N/A, not a failure
    const summary = summarizeScenarios(results);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

describe('runExpandNavScenarios — a declared collection nav is GATING', () => {
  it('200 + a schema-valid expanded item → PASS', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({ Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results).toHaveLength(1);
    expect(results[0].tag).toBe('expand-Media');
    expect(results[0].passed).toBe(true);
    expect(results[0].skipped).toBe(false);
    expect(results[0].warnings).toBeUndefined();
    expect(summarizeScenarios(results).passed).toBe(1);
  });

  it('a declared nav that non-200s → FAIL (declared but not expandable)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({ Media: status(400) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].passed).toBe(false);
    expect(results[0].skipped).toBe(false);
    expect(summarizeScenarios(results).failed).toBe(1);
  });

  it('200 but a SCHEMA-INVALID expanded item → FAIL (validate the data, not just the 200)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({ Media: okExpand([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', req, validator);
    expect(results[0].passed).toBe(false);
    expect(results[0].skipped).toBe(false);
    expect(results[0].assertions.some((a) => !a.passed && a.message.includes('schema-invalid'))).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(1);
  });

  it('a transport error (no server response) → SKIPPED + errored, NOT a failure (indeterminate)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const blip: ODataRequester = { request: async () => { throw new Error('network blip'); } };
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Property' }]), 'tok', blip, validator);
    expect(results[0].skipped).toBe(true);
    expect(results[0].errored).toBe(true);
    expect(summarizeScenarios(results).failed).toBe(0);
  });
});

describe('runExpandNavScenarios — the RRK warning still rides alongside, non-gating', () => {
  it('a mismatched ResourceRecordKey on a schema-valid item → nav STILL passes, warning on .warnings', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    // A schema-valid Media item — `ResourceRecordKey` is a real Media field, and under additionalProperties:false
    // the item must carry ONLY advertised fields. RRK 'WRONG' ≠ parent Property ListingKey 'P1' → non-gating
    // warning. (Validate against the Media target the expanded child actually is — matching the RRK doc: an
    // expanded Media's ResourceRecordKey should echo the parent Property's ListingKey.)
    const req = requesterFor({ Media: okExpand([{ ResourceRecordKey: 'WRONG' }]) });
    const results = await runExpandNavScenarios('http://x', 'Property', expandScenario, paramsFor([{ name: 'Media', targetType: 'Media' }]), 'tok', req, validator);
    expect(results[0].passed).toBe(true); // 200 + schema-valid → passes despite the RRK mismatch
    expect(results[0].warnings?.[0]).toContain('WRONG');
    expect(summarizeScenarios(results).failed).toBe(0); // the warning is inert to the verdict
  });
});

describe('runExpandNavScenarios — several navs, one bad fails exactly that nav', () => {
  it('Media (valid) passes and Rooms (schema-invalid) fails; the failure counts in the verdict tally', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const req = requesterFor({
      Media: okExpand([{ AboveGradeFinishedAreaSource: 'Appraiser' }], 'Media'),
      Rooms: okExpand([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }], 'Rooms'),
    });
    const results = await runExpandNavScenarios(
      'http://x',
      'Property',
      expandScenario,
      paramsFor([{ name: 'Media', targetType: 'Property' }, { name: 'Rooms', targetType: 'Property' }]),
      'tok',
      req,
      validator,
    );
    expect(results).toHaveLength(2);
    const media = results.find((r) => r.tag === 'expand-Media')!;
    const rooms = results.find((r) => r.tag === 'expand-Rooms')!;
    expect(media.passed).toBe(true);
    expect(rooms.passed).toBe(false);

    const summary = summarizeScenarios(results);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1); // GATING: an expand failure is a real failure now
    // And the run verdict derived from those counts is `failed` (the failure is not softened to incomplete).
    expect(coreVerdict({ totalFailed: summary.failed, coverageFailed: false, deadlineReached: false })).toBe('failed');
  });
});

describe('validateExpandedItems — the data-validation unit', () => {
  const nav: Nav = { name: 'Media', targetType: 'Property' };
  const parents = (children: unknown): ReadonlyArray<Record<string, unknown>> => [{ ListingKey: 'P1', Media: children }];

  it('no validator (couldn’t be built this run) → PASS on the 200 alone (never a false fail)', () => {
    const a = validateExpandedItems(parents([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }]), nav, undefined);
    expect(a.passed).toBe(true);
  });

  it('no expanded items → PASS (nothing to schema-validate)', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    expect(validateExpandedItems(parents([]), nav, validator).passed).toBe(true);
    expect(validateExpandedItems([{ ListingKey: 'P1' }], nav, validator).passed).toBe(true); // nav absent
  });

  it('a schema-invalid item → FAIL naming the offending item', async () => {
    const validator = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const a = validateExpandedItems(parents([{ AboveGradeFinishedAreaSource: 'InvalidEnum' }]), nav, validator);
    expect(a.passed).toBe(false);
    expect(a.message).toContain('schema-invalid');
  });
});

describe('createExpandSchemaValidator — the legacy-backed item validator', () => {
  it('a valid item → valid; a schema-invalid item → invalid with error messages', async () => {
    const v = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    expect(v).toBeDefined();
    expect(v!.validate({ AboveGradeFinishedAreaSource: 'Appraiser' }, 'Property').valid).toBe(true);
    const bad = v!.validate({ AboveGradeFinishedAreaSource: 'InvalidEnum' }, 'Property');
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('an unadvertised field on a KNOWN target → invalid (additionalProperties:false, DD/Core mode)', async () => {
    const v = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    const bad = v!.validate({ AboveGradeFinishedAreaSource: 'Appraiser', DefinitelyNotAPropertyField: 'x' }, 'Property');
    expect(bad.valid).toBe(false);
    expect(bad.errors.some((e) => e.includes('advertised in the metadata'))).toBe(true);
  });

  it('an unknown target type → treated VALID (indeterminate, never a false fail)', async () => {
    const v = await createExpandSchemaValidator({ metadataReport: report, version: '2.0' });
    expect(v!.validate({ Anything: 'x' }, 'NoSuchResourceType').valid).toBe(true);
  });
});

// The REAL production path: a provider-style EDMX → generateMetadataReport → createExpandSchemaValidator, then
// validate genuine expanded items. Proves the DD/Core policy end-to-end (isRCF:false, additionalProperties:false,
// the ignoreEnumerations exemptions, the totalErrors gate) against the metadata shape the runner actually builds
// from (`src/sdk/core.ts` calls generateMetadataReport before this validator), not the DD reference alone.
const PROVIDER_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="org.reso.metadata">
      <EntityType Name="Media">
        <Key><PropertyRef Name="MediaKey"/></Key>
        <Property Name="MediaKey" Type="Edm.String" MaxLength="255" Nullable="false"/>
        <Property Name="ShortText" Type="Edm.String" MaxLength="5"/>
        <Property Name="Order" Type="Edm.Int64"/>
        <Property Name="MediaCategory" Type="org.reso.metadata.enums.MediaCategory"/>
        <Property Name="ImageSizeDescription" Type="org.reso.metadata.enums.ImageSizeDescription"/>
        <Property Name="Features" Type="Collection(org.reso.metadata.enums.Feature)" Nullable="false"/>
      </EntityType>
    </Schema>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="org.reso.metadata.enums">
      <EnumType Name="MediaCategory"><Member Name="Photo"/><Member Name="Video"/></EnumType>
      <EnumType Name="ImageSizeDescription"><Member Name="Thumbnail"/></EnumType>
      <EnumType Name="Feature"><Member Name="Pool"/><Member Name="Garage"/></EnumType>
    </Schema>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="ODataService">
      <EntityContainer Name="Container"><EntitySet Name="Media" EntityType="org.reso.metadata.Media"/></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

// The endorsement carries the full semver (2.1.0); the exemptions file is keyed by DD major.minor (2.1).
const PROVIDER_VERSION = '2.1.0';
// Mirror the shape of schema-validation-settings.json for the one exempt Media field the fixture exercises.
const EXEMPTIONS = { '2.1': { Media: { ImageSizeDescription: { ignoreEnumerations: true } } } };

const buildProviderValidator = (validationConfig?: Readonly<Record<string, unknown>>) =>
  createExpandSchemaValidator({
    metadataReport: generateMetadataReport(PROVIDER_EDMX, PROVIDER_VERSION),
    version: PROVIDER_VERSION,
    validationConfig,
  });

describe('createExpandSchemaValidator — provider path (EDMX → generateMetadataReport → validator)', () => {
  it('a valid item (incl. a populated enum collection) → passes with 0 errors', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', MediaCategory: 'Photo', Order: 3, ShortText: 'abc', Features: ['Pool', 'Garage'] }, 'Media');
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('a bad enum value on a non-exempt field → FAIL', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', MediaCategory: 'NotAdvertised' }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('advertised in the metadata'))).toBe(true);
  });

  it('a number served as a JSON string for an Int64 → FAIL', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', Order: '3' }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('MUST be integer'))).toBe(true);
  });

  it('a string exceeding the provider’s declared maxLength → FAIL (isRCF:false: advertised, not suggested)', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', ShortText: 'waytoolong' }, 'Media');
    expect(r.valid).toBe(false);
    // DD/Core mode wording — a hard "MUST … advertised length", NOT the RCF "SHOULD … suggested length" warning.
    expect(r.errors.some((e) => e.includes('advertised length'))).toBe(true);
    expect(r.errors.some((e) => e.includes('suggested length'))).toBe(false);
  });

  it('null for a (non-nullable) collection field → FAIL', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', Features: null }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('MUST be array'))).toBe(true);
  });

  it('a field absent from the provider metadata → FAIL (additionalProperties:false)', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', UndeclaredField: 'x' }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('advertised in the metadata'))).toBe(true);
  });

  it('a novel value on an ignoreEnumerations field → does NOT fail (downgraded to a warning)', async () => {
    const v = await buildProviderValidator(EXEMPTIONS);
    const r = v!.validate({ MediaKey: 'm1', ImageSizeDescription: 'HugeSize' }, 'Media');
    expect(r.valid).toBe(true); // the exemption converts the unadvertised-enum error into a warning
    expect(r.errors).toHaveLength(0);
  });

  it('WITHOUT the exemption the SAME novel value fails — proving the exemption is what downgrades it', async () => {
    const v = await buildProviderValidator({}); // no exemptions threaded
    const r = v!.validate({ MediaKey: 'm1', ImageSizeDescription: 'HugeSize' }, 'Media');
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('advertised in the metadata'))).toBe(true);
  });

  it('a schema that cannot be built → validator is undefined; the nav then gates on the 200 alone', async () => {
    // A report the legacy generator cannot project (returns null) → construction fails determinately.
    const brokenReport = {
      description: '', version: '2.1', generatedOn: '', resources: [], models: [],
      fields: [], lookups: undefined, actions: [], functions: [],
    } as unknown as MetadataReport;
    // The legacy generator logs the caught projection error; silence that ONE expected line to keep output clean.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const v = await createExpandSchemaValidator({ metadataReport: brokenReport, version: PROVIDER_VERSION });
    spy.mockRestore();
    expect(v).toBeUndefined();
    // An undefined validator makes the nav gate on the 200 alone — a determinate tooling failure, never a
    // silent per-item pass (validateExpandedItems short-circuits to passed:true without inspecting items).
    const parent = [{ ListingKey: 'P1', Media: [{ MediaCategory: 'anything' }] }];
    expect(validateExpandedItems(parent, { name: 'Media', targetType: 'Media' }, v).passed).toBe(true);
  });
});
