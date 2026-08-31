import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inferMetadataReport, buildPayloadCache, type ReferenceMap } from '../../src/rcf/assemble-report.js';
import type { MetadataReportField, MetadataReportLookup } from '@reso-standards/reso-metadata-utils';

// The variations service re-reads a report via the legacy buildMetadataMap; use it to prove the
// inferred report's field↔lookup serialization round-trips (isLookupField recovered off field.type).
const requireLegacy = createRequire(import.meta.url);
const { buildMetadataMap } = requireLegacy(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/legacy/common.js'),
) as {
  buildMetadataMap: (report: unknown) => {
    metadataMap: Record<string, Record<string, { isLookupField?: boolean; lookupValues?: Record<string, unknown> }>>;
  };
};

const referenceMap: ReferenceMap = {
  Property: {
    ListPrice: { type: 'Edm.Decimal', nullable: true, ddWikiUrl: 'https://ddwiki.reso.org/ListPrice' },
    PropertyType: {
      type: 'org.reso.metadata.enums.PropertyType',
      isLookupField: true,
      ddWikiUrl: 'https://ddwiki.reso.org/PropertyType',
      lookupValues: {
        Residential: {
          type: 'org.reso.metadata.enums.PropertyType',
          lookupName: 'PropertyType',
          lookupValue: 'Residential',
          ddWikiUrl: 'https://ddwiki.reso.org/PropertyType/Residential',
        },
      },
      legacyODataValues: {},
    },
    Media: { type: 'Collection(org.reso.metadata.Media)', isExpansion: true, isCollection: true, typeName: 'Media' },
  },
  Media: {
    MediaKey: { type: 'Edm.String', nullable: false, ddWikiUrl: 'https://ddwiki.reso.org/MediaKey' },
  },
};

// 40 records — above the enum min-sample. PropertyType is a DD lookup with a
// matched value + a variation; LocalStatus is a repeating local enum;
// LocalRemarks is unique-per-record free text; Media is a DD expansion.
const records = Array.from({ length: 40 }, (_, i) => ({
  '@reso.context': 'urn:reso:metadata:2.0:resource:property',
  ListPrice: i === 0 ? 100000 : 250000.5,
  PropertyType: i % 5 === 0 ? 'Residentail' : 'Residential',
  LocalStatus: ['Active', 'Pending', 'Closed'][i % 3],
  LocalRemarks: `Unique remark number ${i}`,
  Media: [{ MediaKey: `m${i}` }],
}));

const field = (fields: ReadonlyArray<MetadataReportField>, resource: string, name: string): MetadataReportField | undefined =>
  fields.find(f => f.resourceName === resource && f.fieldName === name);
const lookupsFor = (lookups: ReadonlyArray<MetadataReportLookup>, name: string): ReadonlyArray<MetadataReportLookup> =>
  lookups.filter(l => l.lookupName === name);

describe('inferMetadataReport', () => {
  const report = inferMetadataReport({
    recordsByResource: { Property: records },
    referenceMap,
    version: '2.0',
    generatedOn: '2026-01-01T00:00:00.000Z',
  });

  it('stamps version + generatedOn and lists the root + expanded resources', () => {
    expect(report.version).toBe('2.0');
    expect(report.generatedOn).toBe('2026-01-01T00:00:00.000Z');
    expect(report.resources.map(r => r.resourceName).sort()).toEqual(['Media', 'Property']);
  });

  it('skips @-prefixed OData/RESO annotation keys', () => {
    expect(field(report.fields, 'Property', '@reso.context')).toBeUndefined();
  });

  it('carries a DD field type from reference ground truth, not from the values', () => {
    // ListPrice is observed as an integer (100000) in one record, but the reference says Decimal.
    const listPrice = field(report.fields, 'Property', 'ListPrice');
    expect(listPrice?.type).toBe('Edm.Decimal');
    expect(listPrice?.annotations).toContainEqual({ term: 'RESO.DDWikiUrl', value: 'https://ddwiki.reso.org/ListPrice' });
  });

  it('serializes a DD lookup field on the enum FQDN (= field.type) and marks it isEnumeration', () => {
    const propTypeField = field(report.fields, 'Property', 'PropertyType');
    expect(propTypeField?.type).toBe('org.reso.metadata.enums.PropertyType');
    expect(propTypeField?.isEnumeration).toBe(true);

    // lookupName === field.type (the FQDN) so a re-read reconstructs the field↔lookup link.
    const propTypeLookups = lookupsFor(report.lookups, 'org.reso.metadata.enums.PropertyType');
    const residential = propTypeLookups.find(l => l.lookupValue === 'Residential');
    const variation = propTypeLookups.find(l => l.lookupValue === 'Residentail');

    // lookup.type is the underlying Edm type (a string enumeration for observed values), not the FQDN.
    expect(propTypeLookups.every(l => l.type === 'Edm.String')).toBe(true);
    expect(residential?.annotations).toContainEqual({
      term: 'RESO.DDWikiUrl',
      value: 'https://ddwiki.reso.org/PropertyType/Residential',
    });
    // The variation is still emitted (so the variations service can flag it) but carries no DD annotation.
    expect(variation).toBeDefined();
    expect(variation?.annotations).toBeUndefined();
  });

  it('round-trips: buildMetadataMap recovers the DD lookup field from the serialized report', () => {
    const { metadataMap } = buildMetadataMap(report);
    const pt = metadataMap.Property?.PropertyType;
    expect(pt?.isLookupField).toBe(true);
    expect(Object.keys(pt?.lookupValues ?? {})).toContain('Residential');
  });

  it('detects a repeating local string field as a local enumeration', () => {
    const status = field(report.fields, 'Property', 'LocalStatus');
    expect(status?.type).toBe('Property.LocalStatus');
    const statusLookups = lookupsFor(report.lookups, 'Property.LocalStatus');
    expect(statusLookups.map(l => l.lookupValue).sort()).toEqual(['Active', 'Closed', 'Pending']);
    expect(statusLookups.every(l => l.type === 'Edm.String')).toBe(true);
  });

  it('leaves a unique-per-record local string field as free text (no lookups)', () => {
    const remarks = field(report.fields, 'Property', 'LocalRemarks');
    expect(remarks?.type).toBe('Edm.String');
    expect(lookupsFor(report.lookups, 'Property.LocalRemarks')).toHaveLength(0);
  });

  it('recurses expansions into their reference target resource', () => {
    const mediaKey = field(report.fields, 'Media', 'MediaKey');
    expect(mediaKey?.type).toBe('Edm.String');
  });
});

describe('buildPayloadCache', () => {
  it('accumulates values per field and recurses nested objects', () => {
    const cache = buildPayloadCache(
      [{ '@odata.id': 'x', A: 1, Nested: { B: 'y' } }],
      'Root',
      { Root: { Nested: { type: 'Edm.ComplexType', isExpansion: true, typeName: 'NestedType' } } },
    );
    expect(cache.Root.A).toEqual([1]);
    expect(cache.Root['@odata.id']).toBeUndefined(); // annotation skipped
    expect(cache.NestedType.B).toEqual(['y']); // recursed under the reference typeName
  });
});

describe('inferMetadataReport — DD collection (multi-value) lookup fields', () => {
  const refMap: ReferenceMap = {
    Property: {
      Appliances: {
        type: 'org.reso.metadata.enums.Appliances',
        isLookupField: true,
        isCollection: true,
        ddWikiUrl: 'https://ddwiki.reso.org/Appliances',
        lookupValues: {
          Dishwasher: {
            type: 'org.reso.metadata.enums.Appliances',
            lookupName: 'Appliances',
            lookupValue: 'Dishwasher',
            ddWikiUrl: 'https://ddwiki.reso.org/Appliances/Dishwasher',
          },
          Dryer: { type: 'org.reso.metadata.enums.Appliances', lookupName: 'Appliances', lookupValue: 'Dryer' },
        },
        legacyODataValues: {},
      },
    },
  };

  it('flattens array observations and emits each distinct element (match annotated, variation bare)', () => {
    const report = inferMetadataReport({
      recordsByResource: {
        Property: [{ Appliances: ['Dishwasher', 'Dryer'] }, { Appliances: ['Dishwasher', 'MicrowaveXYZ'] }],
      },
      referenceMap: refMap,
      version: '2.0',
      generatedOn: '2026-01-01T00:00:00.000Z',
    });
    const lookups = report.lookups.filter(l => l.lookupName === 'org.reso.metadata.enums.Appliances');
    expect(lookups.map(l => l.lookupValue).sort()).toEqual(['Dishwasher', 'Dryer', 'MicrowaveXYZ']);
    expect(lookups.find(l => l.lookupValue === 'Dishwasher')?.annotations).toBeDefined(); // matched → annotated
    expect(lookups.find(l => l.lookupValue === 'MicrowaveXYZ')?.annotations).toBeUndefined(); // variation → bare
  });
});

describe('inferMetadataReport — DD enum field with no observed values', () => {
  it('does not mark isEnumeration or emit lookups when all values are null/blank', () => {
    const refMap: ReferenceMap = {
      Property: {
        StandardStatus: {
          type: 'org.reso.metadata.enums.StandardStatus',
          isLookupField: true,
          nullable: true,
          ddWikiUrl: 'https://ddwiki.reso.org/StandardStatus',
          lookupValues: {
            Active: { type: 'org.reso.metadata.enums.StandardStatus', lookupName: 'StandardStatus', lookupValue: 'Active' },
          },
          legacyODataValues: {},
        },
      },
    };
    const report = inferMetadataReport({
      recordsByResource: { Property: [{ StandardStatus: null }, { StandardStatus: '' }, { StandardStatus: null }] },
      referenceMap: refMap,
      version: '2.0',
      generatedOn: '2026-01-01T00:00:00.000Z',
    });
    const f = report.fields.find(x => x.fieldName === 'StandardStatus');
    expect(f?.type).toBe('org.reso.metadata.enums.StandardStatus'); // still the DD field
    expect(f?.isEnumeration).toBeUndefined(); // but not an enumeration — no observed values
    expect(report.lookups.filter(l => l.lookupName === 'org.reso.metadata.enums.StandardStatus')).toHaveLength(0);
  });
});

describe('inferMetadataReport — local nested-object field', () => {
  it('emits a local expansion with typeName = field name so its schema $ref resolves', () => {
    const report = inferMetadataReport({
      recordsByResource: { Property: [{ LocalDetails: { Foo: 'a', Num: 1 } }, { LocalDetails: { Foo: 'b', Num: 2 } }] },
      referenceMap: {},
      version: '2.0',
      generatedOn: '2026-01-01T00:00:00.000Z',
    });
    const local = report.fields.find(f => f.resourceName === 'Property' && f.fieldName === 'LocalDetails');
    expect(local?.isExpansion).toBe(true);
    expect(local?.typeName).toBe('LocalDetails'); // matches the buildPayloadCache recursion target
    expect(report.resources.map(r => r.resourceName)).toContain('LocalDetails');
    expect(report.fields.some(f => f.resourceName === 'LocalDetails' && f.fieldName === 'Foo')).toBe(true);
  });
});

describe('inferMetadataReport — presence → nullable (jagged data)', () => {
  it('marks a field nullable when it is absent from some records, not when present in all', () => {
    const report = inferMetadataReport({
      recordsByResource: {
        Property: [
          { AlwaysHere: 'a', SometimesHere: 'x' },
          { AlwaysHere: 'b' }, // SometimesHere absent
          { AlwaysHere: 'c' },
        ],
      },
      referenceMap: {},
      version: '2.0',
      generatedOn: '2026-01-01T00:00:00.000Z',
    });
    expect(report.fields.find(f => f.fieldName === 'AlwaysHere')?.nullable).toBeUndefined(); // present in all 3
    expect(report.fields.find(f => f.fieldName === 'SometimesHere')?.nullable).toBe(true); // absent from 2 of 3
  });
});

describe('inferMetadataReport — kind matching (mis-named expansions)', () => {
  const lookupField = (name: string, values: ReadonlyArray<string>) => ({
    type: `org.reso.metadata.enums.${name}`,
    isLookupField: true,
    lookupValues: Object.fromEntries(values.map(v => [v, { type: 'x', lookupName: name, lookupValue: v }])),
  });
  // Six resources so a resource-unique field carries idf ≈ ln(6) ≈ 1.79 — five of them clear the shipped floor.
  const kmReference: ReferenceMap = {
    Property: { ListPrice: { type: 'Edm.Decimal' }, City: { type: 'Edm.String' }, ModificationTimestamp: { type: 'Edm.DateTimeOffset' } },
    Energy: {
      EnergyRating: { type: 'Edm.String' },
      EnergyScore: { type: 'Edm.Int32' },
      EnergyProvider: { type: 'Edm.String' },
      EnergyYear: { type: 'Edm.Int32' },
      EnergyType: lookupField('EnergyType', ['Solar', 'Wind']),
      ModificationTimestamp: { type: 'Edm.DateTimeOffset' },
    },
    Media: { MediaKey: { type: 'Edm.String' }, MediaURL: { type: 'Edm.String' }, ModificationTimestamp: { type: 'Edm.DateTimeOffset' } },
    Member: { MemberKey: { type: 'Edm.String' }, MemberEmail: { type: 'Edm.String' }, ModificationTimestamp: { type: 'Edm.DateTimeOffset' } },
    Office: { OfficeKey: { type: 'Edm.String' }, OfficeName: { type: 'Edm.String' }, ModificationTimestamp: { type: 'Edm.DateTimeOffset' } },
    OpenHouse: { OpenHouseKey: { type: 'Edm.String' }, OpenHouseStartTime: { type: 'Edm.DateTimeOffset' }, ModificationTimestamp: { type: 'Edm.DateTimeOffset' } },
  };
  const kmRecords = Array.from({ length: 5 }, (_, i) => ({
    ListPrice: 100000 + i,
    City: 'Springfield',
    energy_data: [{ EnergyRating: 'A', EnergyScore: 90 + i, EnergyProvider: 'Acme', EnergyYear: 2020 + i, EnergyType: i % 2 ? 'Solar' : 'Wind' }], // mis-named → Energy
    address: { street: `${i} Main St`, zip: '00000' }, // provider complex type → no DD resource
    listing_details: { ListPrice: 100000 + i, City: 'Springfield' }, // parent's own fields → self-flatten
  }));
  const report = inferMetadataReport({ recordsByResource: { Property: kmRecords }, referenceMap: kmReference, version: '2.0', generatedOn: '2026-01-01T00:00:00.000Z' });

  it('reverses a mis-named expansion to the matched DD resource (fieldName ≠ typeName)', () => {
    const f = field(report.fields, 'Property', 'energy_data');
    expect(f?.isExpansion).toBe(true);
    expect(f?.typeName).toBe('Energy');
    expect(report.resources.map(r => r.resourceName)).toContain('Energy');
  });

  it('types the matched expansion’s nested fields against the DD reference', () => {
    expect(field(report.fields, 'Energy', 'EnergyScore')?.type).toBe('Edm.Int32'); // recursed under Energy → DD-typed
  });

  it('keeps a provider complex type local (no DD match → object under its own name)', () => {
    expect(field(report.fields, 'Property', 'address')?.typeName).toBe('address');
  });

  it('does not self-match a flattening of the parent’s own fields', () => {
    expect(field(report.fields, 'Property', 'listing_details')?.typeName).toBe('listing_details');
  });

  it('recovers a depth-2 mis-named expansion nested inside a resolved rename', () => {
    const ref: ReferenceMap = {
      Property: { ListPrice: { type: 'Edm.Decimal' }, City: { type: 'Edm.String' } },
      Energy: {
        EnergyRating: { type: 'Edm.String' }, EnergyScore: { type: 'Edm.Int32' }, EnergyProvider: { type: 'Edm.String' },
        EnergyYear: { type: 'Edm.Int32' }, EnergyType: { type: 'Edm.String' },
      },
      Solar: {
        SolarPanelKey: { type: 'Edm.String' }, SolarCapacity: { type: 'Edm.Decimal' }, SolarInverter: { type: 'Edm.String' },
        SolarOrientation: { type: 'Edm.String' }, SolarWattage: { type: 'Edm.Int32' },
      },
      Media: { MediaKey: { type: 'Edm.String' }, MediaURL: { type: 'Edm.String' } },
      Member: { MemberKey: { type: 'Edm.String' }, MemberEmail: { type: 'Edm.String' } },
      Office: { OfficeKey: { type: 'Edm.String' }, OfficeName: { type: 'Edm.String' } },
    };
    const records = Array.from({ length: 5 }, (_, i) => ({
      ListPrice: 100000 + i,
      City: 'Springfield',
      power_data: [
        {
          // mis-named → Energy (depth 1)
          EnergyRating: 'A', EnergyScore: 90 + i, EnergyProvider: 'Acme', EnergyYear: 2020 + i, EnergyType: 'Solar',
          // mis-named → Solar, nested inside the resolved Energy expansion (depth 2)
          panels: { SolarPanelKey: `p${i}`, SolarCapacity: 5.5, SolarInverter: 'Acme', SolarOrientation: 'South', SolarWattage: 400 },
        },
      ],
    }));
    const nested = inferMetadataReport({ recordsByResource: { Property: records }, referenceMap: ref, version: '2.0', generatedOn: '2026-01-01T00:00:00.000Z' });
    expect(field(nested.fields, 'Property', 'power_data')?.typeName).toBe('Energy'); // depth 1
    expect(field(nested.fields, 'Energy', 'panels')?.typeName).toBe('Solar'); // depth 2 — was silently unrecovered before the key-context fix
  });
});

describe('inferMetadataReport — LOCAL collection (multi-value) enum', () => {
  it('detects a local multi-value string field as an enumeration and emits its distinct values', () => {
    // A non-DD field whose observations are arrays. 30 observations of a bounded set → enum.
    const records = Array.from({ length: 20 }, (_, i) => ({
      ListingKey: `k${i}`,
      LocalFeatures: i % 2 === 0 ? ['Pool', 'Spa'] : ['Pool'],
    }));
    const report = inferMetadataReport({
      recordsByResource: { Property: records },
      referenceMap: { Property: {} }, // no DD reference → LocalFeatures is a local field
      version: '2.0.0',
      generatedOn: '2026-01-01T00:00:00.000Z',
    });
    const featLookups = report.lookups.filter(l => l.lookupName === 'Property.LocalFeatures');
    expect(featLookups.map(l => l.lookupValue).sort()).toEqual(['Pool', 'Spa']);
    const local = report.fields.find(f => f.fieldName === 'LocalFeatures');
    expect(local?.type).toBe('Property.LocalFeatures');
    expect(local?.isCollection).toBe(true);
  });
});
