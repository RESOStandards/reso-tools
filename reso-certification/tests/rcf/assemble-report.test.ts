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
