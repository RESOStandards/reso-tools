/**
 * Issue-2 suppression tests for the legacy v3.0.0 `computeVariations`.
 *
 * Issue 2: "if the vendor already has the suggestion's target, the local
 * element shouldn't be flagged." Uncovered during the M00000050-50039 /
 * M00000460 investigation.
 *
 * The dual-form existence check in `lib/variations/index.js` implements it:
 * suppress when the suggestion's WIRE form is present in the vendor's
 * `legacyODataValues` map, OR its DISPLAY form is present in the
 * `lookupValues` map — each value form matched against its correctly-keyed
 * map (legacyODataValues is keyed by wire form, lookupValues by the
 * StandardName-annotated display form; see common.js buildMetadataMap).
 *
 * These tests assert that invariant. Case 3 (no canonical present anywhere)
 * confirms a genuine variation still flags.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);

const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const APPLIANCES_ENUM = 'Cotality.DataStandard.RESO.DD.Enums.Multi.Appliances';
const DD_2_0 = '2.0';
const FUZZ = 0.25;

const field = {
  resourceName: 'Property',
  fieldName: 'Appliances',
  type: APPLIANCES_ENUM,
  typeName: 'Appliances',
  nullable: true,
  annotations: [],
};
const lookup = (lookupValue: string, standardName?: string) => ({
  lookupName: APPLIANCES_ENUM,
  lookupValue,
  type: 'Edm.Int64',
  annotations: [
    { term: 'RESO.OData.Metadata.StandardName', value: standardName ?? lookupValue },
    { term: 'RESO.OData.Metadata.TrestleName', value: lookupValue },
  ],
});
const metadataReport = (lookups: ReturnType<typeof lookup>[]) => ({
  description: 'Suppression-test synthetic metadata report',
  version: DD_2_0,
  generatedOn: new Date().toISOString(),
  fields: [field],
  lookups,
});
const suggestionsFor = (sourceKey: string, sug: Record<string, unknown>) => ({
  Property: { Appliances: { [sourceKey]: { suggestions: [sug] } } },
});
const wasFlagged = (report: unknown, sourceKey: string): boolean => {
  const entries = (report as { variations?: { lookups?: Array<Record<string, unknown>> } })?.variations?.lookups ?? [];
  return entries.some(
    (e) =>
      e.resourceName === 'Property' &&
      e.fieldName === 'Appliances' &&
      (e.legacyODataValue === sourceKey || e.lookupValue === sourceKey)
  );
};

describe('computeVariations: Issue 2 suppression (v3.0.0)', () => {
  // 1. Realistic — exactly the M00000460 / CommonWaterHeater shape.
  // Vendor has WaterHeater (wire form) + StandardName "Water Heater", plus a
  // local CommonWaterHeater. Cloud-supplied suggestion is display-form
  // "Water Heater" on `suggestedLookupValue`. The display form matches the
  // vendor's `lookupValues` map (keyed by StandardName) → suppressed.
  it('display-form suggestion + vendor canonical present → suppressed (Issue 2)', async () => {
    const result = await computeVariations({
      metadataReportJson: metadataReport([
        lookup('WaterHeater', 'Water Heater'),
        lookup('CommonWaterHeater', 'Common Water Heater'),
      ]),
      version: DD_2_0,
      fuzziness: FUZZ,
      suggestionsMap: suggestionsFor('CommonWaterHeater', {
        suggestedResourceName: 'Property',
        suggestedFieldName: 'Appliances',
        suggestedLookupValue: 'Water Heater',
        isFastTrack: true,
      }),
    });
    expect(wasFlagged(result, 'CommonWaterHeater')).toBe(false);
  });

  // 2. Vendor literally declares display-form lookupValue "Water Heater"
  // (its StandardName resolves to "Water Heater"). The display-form
  // suggestion matches the `lookupValues` map → suppressed.
  it('vendor has literal display-form lookupValue + matching display-form suggestion → suppressed', async () => {
    const result = await computeVariations({
      metadataReportJson: metadataReport([
        lookup('Water Heater', 'Water Heater'),
        lookup('CommonWaterHeater', 'Common Water Heater'),
      ]),
      version: DD_2_0,
      fuzziness: FUZZ,
      suggestionsMap: suggestionsFor('CommonWaterHeater', {
        suggestedResourceName: 'Property',
        suggestedFieldName: 'Appliances',
        suggestedLookupValue: 'Water Heater',
        isFastTrack: true,
      }),
    });
    expect(wasFlagged(result, 'CommonWaterHeater')).toBe(false);
  });

  // 3. No canonical present anywhere — the flag is genuinely correct. Neither
  // the wire nor display form of the suggestion exists in the vendor's maps,
  // so nothing suppresses it.
  it('no canonical present + display-form suggestion → flags (correct)', async () => {
    const result = await computeVariations({
      metadataReportJson: metadataReport([
        lookup('CommonWaterHeater', 'Common Water Heater'),
      ]),
      version: DD_2_0,
      fuzziness: FUZZ,
      suggestionsMap: suggestionsFor('CommonWaterHeater', {
        suggestedResourceName: 'Property',
        suggestedFieldName: 'Appliances',
        suggestedLookupValue: 'Water Heater',
        isFastTrack: true,
      }),
    });
    expect(wasFlagged(result, 'CommonWaterHeater')).toBe(true);
  });

  // 4. Wire-form suggestion (post-v2 cleanup shape). The vendor has the
  // canonical WIRE form (WaterHeater). This was the original bug: the wire
  // value `suggestedLegacyODataValue` was looked up in the DISPLAY-keyed
  // `lookupValues` map, so it never matched for inline-EnumType vendors. The
  // dual-form check now matches it against `legacyODataValues` → suppressed.
  it('wire-form suggestion + vendor canonical wire form present → suppressed', async () => {
    const result = await computeVariations({
      metadataReportJson: metadataReport([
        lookup('WaterHeater', 'Water Heater'),
        lookup('CommonWaterHeater', 'Common Water Heater'),
      ]),
      version: DD_2_0,
      fuzziness: FUZZ,
      suggestionsMap: suggestionsFor('CommonWaterHeater', {
        suggestedResourceName: 'Property',
        suggestedFieldName: 'Appliances',
        suggestedLegacyODataValue: 'WaterHeater',
        isFastTrack: true,
      }),
    });
    expect(wasFlagged(result, 'CommonWaterHeater')).toBe(false);
  });

  // 5. Cross-field, single-cap source — v2's checkLookupForm (≥2 caps) does
  // NOT rewrite the suggestion, so it stays on `suggestedLookupValue`. Mirrors
  // the real-world `Barbecue → ExteriorFeatures.Barbecue` case. The existence
  // check consults the SUGGESTED field's map (ExteriorFeatures), where the
  // vendor declares Barbecue → suppressed.
  it('single-cap source + display-form cross-field suggestion + vendor has target → suppressed', async () => {
    const EXTERIOR = 'Cotality.DataStandard.RESO.DD.Enums.Multi.ExteriorFeatures';
    const result = await computeVariations({
      metadataReportJson: {
        ...metadataReport([lookup('Barbecue', 'Barbecue')]),
        fields: [
          field,
          { ...field, fieldName: 'ExteriorFeatures', type: EXTERIOR, typeName: 'ExteriorFeatures' },
        ],
        lookups: [
          lookup('Barbecue', 'Barbecue'),
          { ...lookup('Barbecue', 'Barbecue'), lookupName: EXTERIOR },
        ],
      },
      version: DD_2_0,
      fuzziness: FUZZ,
      suggestionsMap: suggestionsFor('Barbecue', {
        suggestedResourceName: 'Property',
        suggestedFieldName: 'ExteriorFeatures',
        suggestedLookupValue: 'Barbecue',
        isFastTrack: true,
      }),
    });
    expect(wasFlagged(result, 'Barbecue')).toBe(false);
  });
});
