import { describe, it, expect } from 'vitest';
import { buildMetadataMap } from '../src/metadata/metadata-map.js';

const SN = 'RESO.OData.Metadata.StandardName';
const WIKI = 'RESO.DDWikiUrl';

describe('buildMetadataMap', () => {
  it('string-enum field: display-keyed lookupValues carry standardLookupValue; sentinels skipped', () => {
    const { metadataMap, stats } = buildMetadataMap({
      fields: [{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'enums.StandardStatus', isEnumeration: true, annotations: [] }],
      lookups: [
        { lookupName: 'enums.StandardStatus', lookupValue: 'Active', type: 'Edm.String', annotations: [{ term: SN, value: 'Active' }, { term: WIKI, value: 'u/Active' }] },
        // open-enum sentinel — must be skipped
        { lookupName: 'enums.StandardStatus', lookupValue: 'SampleStandardStatusEnumValue', type: 'Edm.String', annotations: [] },
      ],
    });
    const entry = metadataMap.Property?.StandardStatus;
    expect(entry?.isLookupField).toBe(true);
    expect(entry?.lookupValues?.Active).toMatchObject({ lookupValue: 'Active', standardLookupValue: 'Active', isStringEnumeration: true, ddWikiUrl: 'u/Active' });
    expect(Object.keys(entry?.lookupValues ?? {})).toEqual(['Active']); // sentinel dropped
    expect(entry?.legacyODataValues).toEqual({}); // string enums skip the legacy form
    expect(stats.numLookups).toBe(1); // sentinel not counted
  });

  it('non-string enum: legacyODataValues keyed by wire value, lookupValues by display value', () => {
    const { metadataMap } = buildMetadataMap({
      fields: [{ resourceName: 'Property', fieldName: 'Foo', type: 'enums.Foo', isEnumeration: true, annotations: [] }],
      lookups: [
        { lookupName: 'enums.Foo', lookupValue: 'BarBaz', type: 'Edm.Int64', annotations: [{ term: SN, value: 'Bar Baz' }] },
      ],
    });
    const entry = metadataMap.Property?.Foo;
    expect(entry?.legacyODataValues?.BarBaz).toMatchObject({ legacyODataValue: 'BarBaz', lookupValue: 'Bar Baz' });
    expect(entry?.lookupValues?.['Bar Baz']).toMatchObject({ lookupValue: 'Bar Baz', legacyODataValue: 'BarBaz' });
  });

  it('expansion + primitive flags and stats', () => {
    const { metadataMap, stats } = buildMetadataMap({
      fields: [
        { resourceName: 'Property', fieldName: 'Media', type: 'Collection(Media)', isExpansion: true, annotations: [] },
        { resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal', annotations: [] },
      ],
      lookups: [],
    });
    expect(metadataMap.Property?.Media?.isExpansion).toBe(true);
    expect(metadataMap.Property?.Media?.isLookupField).toBe(false);
    expect(metadataMap.Property?.ListPrice?.isComplexType).toBe(false); // Edm.* primitive
    expect(stats).toMatchObject({ numResources: 1, numFields: 2, numExpansions: 1, numComplexTypes: 0 });
  });
});
