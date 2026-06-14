/**
 * buildMetadataMap dual-key construction — the keying the variations
 * presence/suppression checks depend on.
 *
 * - `legacyODataValues` is keyed by the WIRE form (the raw OData value),
 *   populated only for non-string enums.
 * - `lookupValues` is keyed by the DISPLAY form: the StandardName-annotated
 *   value for non-string enums, or the raw value for string enums (which carry
 *   the annotation as `standardLookupValue`).
 * - `Sample…EnumValue` placeholder lookups are excluded from both maps.
 *
 * A regression in this keying silently breaks every downstream form↔map
 * presence check.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { buildMetadataMap } = require(resolve(legacyRoot, 'common.js'));

const SN = 'RESO.OData.Metadata.StandardName';
const ENUM = 'Cotality.DataStandard.RESO.DD.Enums.Multi.Appliances';
const STR_ENUM = 'Cotality.DataStandard.RESO.DD.Enums.String.Single.SomeEnum';

describe('buildMetadataMap: dual-key construction', () => {
  it('non-string enum: legacyODataValues keyed by wire form, lookupValues by StandardName display', () => {
    const { metadataMap } = buildMetadataMap({
      fields: [{ resourceName: 'Property', fieldName: 'Appliances', type: ENUM, annotations: [] }],
      lookups: [{ lookupName: ENUM, lookupValue: 'WaterHeater', type: 'Edm.Int64', annotations: [{ term: SN, value: 'Water Heater' }] }],
    });
    const f = metadataMap.Property.Appliances;
    expect(f.legacyODataValues.WaterHeater).toBeDefined();        // wire key = raw value
    expect(f.lookupValues['Water Heater']).toBeDefined();         // display key = StandardName
    expect(f.legacyODataValues['Water Heater']).toBeUndefined();  // not display-keyed
    expect(f.lookupValues.WaterHeater).toBeUndefined();           // not wire-keyed
  });

  it('string enum: lookupValues keyed by the raw value + standardLookupValue annotation, no legacyODataValues', () => {
    const { metadataMap } = buildMetadataMap({
      fields: [{ resourceName: 'Property', fieldName: 'StrField', type: STR_ENUM, annotations: [] }],
      lookups: [{ lookupName: STR_ENUM, lookupValue: 'Activ', type: 'Edm.String', annotations: [{ term: SN, value: 'Active' }] }],
    });
    const f = metadataMap.Property.StrField;
    expect(f.lookupValues.Activ).toBeDefined();
    expect(f.lookupValues.Activ.standardLookupValue).toBe('Active');
    expect(Object.keys(f.legacyODataValues ?? {})).toHaveLength(0); // string enums carry no wire map
  });

  it('excludes Sample…EnumValue placeholder lookups from both maps', () => {
    const { metadataMap } = buildMetadataMap({
      fields: [{ resourceName: 'Property', fieldName: 'Appliances', type: ENUM, annotations: [] }],
      lookups: [{ lookupName: ENUM, lookupValue: 'SampleAppliancesEnumValue', type: 'Edm.Int64', annotations: [] }],
    });
    const f = metadataMap.Property.Appliances;
    expect(Object.keys(f.legacyODataValues ?? {})).toHaveLength(0);
    expect(Object.keys(f.lookupValues ?? {})).toHaveLength(0);
  });
});
