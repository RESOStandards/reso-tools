/**
 * DD reference self-test — the reference must be silent under its own checks.
 *
 * The thesis of the DD-cert architecture port: generate the reference artifacts from the DD
 * (both enum representations), then run the SAME variations check against them that we run
 * against providers. Because the reference follows its own rules, it must come back with ZERO
 * variations. A variation here means the generation pipeline corrupted something relative to the
 * DD (e.g. the historical processEntities "Flex R&D" bug), so this is a regression gate on the
 * generator + serializer, exercised through the real provider entry point (computeVariationsV2).
 *
 * The matching reconciles the generated report's machine values against the reference's display
 * values through the RESO.OData.Metadata.StandardName annotation, so "silent" means that bridge
 * is intact end-to-end. The TEETH tests below deliberately corrupt a value and require a flag —
 * without them, a mis-wired harness would pass silently (the false-negative silent killer).
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';
import { generateReferenceArtifacts } from '../../src/metadata/reference-artifacts.js';
import { runDdMetadataChecks } from '../../src/metadata/dd-metadata-checks.js';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import type { MetadataReport } from '../../src/metadata/serializer.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

type Json = Record<string, unknown>;

// The OUTPUT levels from prepareResults: the internal lookupValues + legacyODataValues accumulators
// are merged and emitted under `lookups` (see src/legacy/lib/variations/index.js prepareResults).
const VARIATION_LEVELS = ['resources', 'fields', 'lookups', 'expansions', 'complexTypes'] as const;
const REP_MODES = ['string', 'enum-type'] as const;
const VERSION = '2.1';

const variationCounts = (variations: Json): Record<string, number> =>
  Object.fromEntries(VARIATION_LEVELS.map((l) => [l, ((variations[l] as unknown[]) ?? []).length]));
const totalVariations = (variations: Json): number =>
  VARIATION_LEVELS.reduce((n, l) => n + ((variations[l] as unknown[]) ?? []).length, 0);

const runSelfCheck = (report: MetadataReport, ref: Json): Json =>
  (computeVariationsV2({ metadataReportJson: report as Json, referenceMetadata: ref, version: VERSION }) as { variations: Json }).variations;

describe('DD reference self-test (DD 2.1)', () => {
  const ref = getReferenceMetadata(VERSION) as MetadataReport;
  const targetResources = ref.resources as unknown as string[];

  it.each(REP_MODES)('rep=%s: the generated reference produces ZERO variations against the DD', (enumMode) => {
    const { metadataReport } = generateReferenceArtifacts(ref, targetResources, enumMode, VERSION);
    const variations = runSelfCheck(metadataReport, ref as Json);
    // Per-level breakdown so a regression shows exactly which level drifted.
    expect(variationCounts(variations)).toEqual(Object.fromEntries(VARIATION_LEVELS.map((l) => [l, 0])));
  });

  it.each(REP_MODES)('rep=%s TEETH: a corrupted lookup value surfaces a variation (the check is live)', (enumMode) => {
    const { metadataReport } = generateReferenceArtifacts(ref, targetResources, enumMode, VERSION);
    // Corrupt one StandardStatus value end-to-end (machine value + every annotation) to a near-miss
    // of its canonical — flags via the lookup path (string rep) or the legacyOData path (enum-type).
    const corrupt = (v: string): string =>
      v === 'ActiveUnderContract' || v === 'Active Under Contract' ? `${v}Xyz` : v;
    const corrupted: MetadataReport = {
      ...metadataReport,
      lookups: metadataReport.lookups.map((l) =>
        String(l.lookupName).endsWith('StandardStatus') && l.lookupValue === 'ActiveUnderContract'
          ? { ...l, lookupValue: `${l.lookupValue}Xyz`, annotations: (l.annotations ?? []).map((a) => ({ ...a, value: corrupt(a.value) })) }
          : l),
    };
    expect(totalVariations(runSelfCheck(corrupted, ref as Json))).toBeGreaterThan(0);
  });

  it('TEETH (fields): a corrupted field name surfaces a field variation (the check is live)', () => {
    const { metadataReport } = generateReferenceArtifacts(ref, targetResources, 'string', VERSION);
    const corrupted: MetadataReport = {
      ...metadataReport,
      fields: metadataReport.fields.map((f, i) => (i === 0 ? { ...f, fieldName: `${f.fieldName}Xyz` } : f)),
    };
    expect(((runSelfCheck(corrupted, ref as Json).fields as unknown[]) ?? []).length).toBeGreaterThan(0);
  });

  // Coverage caveat: an EnumType member must be a valid OData SimpleIdentifier, so the enum-type rep
  // can only carry identifier-shaped lookup values; the string rep (Lookup Resource) carries them all.
  // Assert the filter's contract (every enum-type value is an identifier) and that string is the
  // superset, so a regression that drops a VALID value — or widens the blind spot — is caught.
  it('enum-type emits only valid OData SimpleIdentifier lookup values; the string rep is the superset', () => {
    const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
    const stringLookups = generateReferenceArtifacts(ref, targetResources, 'string', VERSION).metadataReport.lookups;
    const enumLookups = generateReferenceArtifacts(ref, targetResources, 'enum-type', VERSION).metadataReport.lookups;

    const nonIdentifier = enumLookups.filter((l) => !SIMPLE_IDENTIFIER.test(String(l.lookupValue)));
    expect(nonIdentifier).toEqual([]);
    expect(stringLookups.length).toBeGreaterThanOrEqual(enumLookups.length);
  });
});

// The DD metadata GATE (fail-fast metadata-validation, run before variations) must also be silent
// on the reference: the generated reference passes every MUST check in both representations.
describe('DD metadata gate self-test (DD 2.1)', () => {
  const ref = getReferenceMetadata(VERSION) as MetadataReport;
  const targetResources = ref.resources as unknown as string[];
  const gateErrors = (report: MetadataReport) =>
    runDdMetadataChecks(report, ref as unknown as DdReference).filter((f) => f.severity === 'error');

  it.each(REP_MODES)('rep=%s: the generated reference passes the metadata gate with ZERO errors', (enumMode) => {
    const { metadataReport } = generateReferenceArtifacts(ref, targetResources, enumMode, VERSION);
    expect(gateErrors(metadataReport)).toEqual([]);
  });

  it('TEETH: a disallowed-synonym field surfaces a gate error', () => {
    const { metadataReport } = generateReferenceArtifacts(ref, targetResources, 'string', VERSION);
    // NormalizedListingStatus is a disallowed synonym of Property.StandardStatus.
    const corrupted: MetadataReport = {
      ...metadataReport,
      fields: [...metadataReport.fields, { resourceName: 'Property', fieldName: 'NormalizedListingStatus', type: 'Edm.String', annotations: [] }],
    };
    const errors = gateErrors(corrupted);
    expect(errors.some((e) => e.check === 'disallowed-synonym')).toBe(true);
  });

  it('TEETH: a wrong field data type surfaces a gate error', () => {
    const { metadataReport } = generateReferenceArtifacts(ref, targetResources, 'string', VERSION);
    // Force the Decimal field ListPrice to an Edm.String type.
    const corrupted: MetadataReport = {
      ...metadataReport,
      fields: metadataReport.fields.map((f) =>
        f.resourceName === 'Property' && f.fieldName === 'ListPrice' ? { ...f, type: 'Edm.String', isEnumeration: false } : f),
    };
    expect(gateErrors(corrupted).some((e) => e.check === 'field-type')).toBe(true);
  });
});
