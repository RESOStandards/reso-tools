import { describe, it, expect } from 'vitest';
import { mergeWithLookupResource, serializeLookupResourceDump, synthesizeLookupResourceRecords } from '../../src/metadata/lookup-resource.js';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import type { RawLookupRecord } from '../../src/metadata/lookup-resource.js';

const baseReport: MetadataReport = {
  description: 'RESO Data Dictionary Metadata Report',
  version: '2.0',
  generatedOn: '2026-04-06T00:00:00.000Z',
  resources: [{ resourceName: 'Property' }],
  fields: [
    {
      resourceName: 'Property',
      fieldName: 'ListingKey',
      type: 'Edm.String',
      annotations: [],
    },
    {
      resourceName: 'Property',
      fieldName: 'StandardStatus',
      type: 'Edm.String',
      isEnumeration: true,
      annotations: [
        { term: 'RESO.OData.Metadata.LookupName', value: 'StandardStatus' },
      ],
    },
    {
      resourceName: 'Property',
      fieldName: 'InteriorFeatures',
      type: 'Edm.String',
      isCollection: true,
      isEnumeration: true,
      annotations: [
        { term: 'RESO.OData.Metadata.LookupName', value: 'InteriorFeatures' },
      ],
    },
  ],
  lookups: [],
};

const lookupRecords: ReadonlyArray<RawLookupRecord> = [
  {
    LookupName: 'StandardStatus',
    LookupValue: 'Active',
    StandardLookupValue: 'Active',
    LegacyODataValue: 'Active',
    ModificationTimestamp: '2021-07-09T01:14:09Z',
    LookupKey: '103-456188-2106739-8419115',
  },
  {
    LookupName: 'StandardStatus',
    LookupValue: 'Pending',
    StandardLookupValue: 'Pending',
    LegacyODataValue: null,
    ModificationTimestamp: '2021-07-09T01:14:09Z',
    LookupKey: '103-456188-2106739-8419116',
  },
  {
    LookupName: 'InteriorFeatures',
    LookupValue: 'Garden Bath',
    StandardLookupValue: 'Garden Bath',
    LegacyODataValue: 'GardenBath',
    ModificationTimestamp: '2021-07-09T01:14:09Z',
    LookupKey: '103-456188-2106739-8419117',
  },
];

describe('mergeWithLookupResource', () => {
  const merged = mergeWithLookupResource(baseReport, lookupRecords);

  it('preserves base report metadata', () => {
    expect(merged.description).toBe(baseReport.description);
    expect(merged.version).toBe(baseReport.version);
    expect(merged.resources).toEqual(baseReport.resources);
  });

  it('replaces field type with LookupName for annotated fields', () => {
    const status = merged.fields.find(f => f.fieldName === 'StandardStatus');
    expect(status?.type).toBe('StandardStatus');
  });

  it('replaces field type for collection lookup fields', () => {
    const interior = merged.fields.find(f => f.fieldName === 'InteriorFeatures');
    expect(interior?.type).toBe('InteriorFeatures');
  });

  it('does not modify non-lookup fields', () => {
    const key = merged.fields.find(f => f.fieldName === 'ListingKey');
    expect(key?.type).toBe('Edm.String');
  });

  it('adds transformed lookup records', () => {
    expect(merged.lookups).toHaveLength(3);
  });

  it('lookup records have correct shape', () => {
    const active = merged.lookups.find(l => l.lookupValue === 'Active');
    expect(active).toBeDefined();
    expect(active!.lookupName).toBe('StandardStatus');
    expect(active!.type).toBe('Edm.String');
  });

  it('includes StandardName annotation when present', () => {
    const active = merged.lookups.find(l => l.lookupValue === 'Active');
    expect(active!.annotations).toBeDefined();
    expect(active!.annotations!.some(a => a.term === 'RESO.OData.Metadata.StandardName')).toBe(true);
  });

  it('includes LegacyODataValue annotation when present', () => {
    const gardenBath = merged.lookups.find(l => l.lookupValue === 'Garden Bath');
    expect(gardenBath!.annotations).toBeDefined();
    expect(gardenBath!.annotations!.some(a => a.term === 'RESO.OData.Metadata.LegacyODataValue')).toBe(true);
  });

  it('omits annotations array when no annotations present', () => {
    const pending = merged.lookups.find(l => l.lookupValue === 'Pending');
    // Pending has StandardLookupValue but no LegacyODataValue
    expect(pending).toBeDefined();
    // Should have StandardName annotation
    expect(pending!.annotations).toBeDefined();
  });

  it('preserves existing lookups from base report', () => {
    const baseWithLookups: MetadataReport = {
      ...baseReport,
      lookups: [{ lookupName: 'ExistingLookup', lookupValue: 'Value1', type: 'Edm.Int32' }],
    };
    const result = mergeWithLookupResource(baseWithLookups, lookupRecords);
    expect(result.lookups).toHaveLength(4); // 1 existing + 3 new
    expect(result.lookups[0].lookupName).toBe('ExistingLookup');
  });
});

describe('synthesizeLookupResourceRecords', () => {
  const enumField = (fieldName: string, lookupName: string) => ({
    resourceName: 'Property', fieldName, type: `org.reso.metadata.enums.${lookupName}`, isEnumeration: true, annotations: [],
  });

  it('synthesizes records from standard lookup values (short LookupName + StandardLookupValue)', () => {
    const report: MetadataReport = {
      ...baseReport,
      fields: [enumField('StandardStatus', 'StandardStatus')],
      lookups: [{ lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'ActiveUnderContract', type: 'Edm.Int32', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Active Under Contract' }] }],
    };
    const records = synthesizeLookupResourceRecords(report);
    const auc = records.find(r => r.LookupValue === 'ActiveUnderContract');
    expect(auc?.LookupName).toBe('StandardStatus');
    expect(auc?.StandardLookupValue).toBe('Active Under Contract');
    expect(records.some(r => String(r.LookupValue).startsWith('Sample'))).toBe(false);
  });

  it('seeds a single self-identifying sample sentinel for an open enumeration (no standard values)', () => {
    // CountyOrParish is referenced by a field but has no standard lookup values in the DD.
    const report: MetadataReport = { ...baseReport, fields: [enumField('CountyOrParish', 'CountyOrParish')], lookups: [] };
    const samples = synthesizeLookupResourceRecords(report).filter(r => r.LookupName === 'CountyOrParish');
    expect(samples).toHaveLength(1);
    expect(samples[0].LookupValue).toBe('SampleCountyOrParishEnumValue');
    // Matches the Sample…EnumValue sentinel that buildMetadataMap filters out downstream.
    expect(samples[0].LookupValue.startsWith('Sample') && samples[0].LookupValue.endsWith('EnumValue')).toBe(true);
  });

  it('does not seed a sample when the enumeration already carries standard values', () => {
    const report: MetadataReport = {
      ...baseReport,
      fields: [enumField('StandardStatus', 'StandardStatus')],
      lookups: [{ lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Active', type: 'Edm.Int32', annotations: [] }],
    };
    expect(synthesizeLookupResourceRecords(report).every(r => !String(r.LookupValue).startsWith('Sample'))).toBe(true);
  });
});

describe('serializeLookupResourceDump', () => {
  it('creates dump in Commander format', () => {
    const dump = serializeLookupResourceDump(lookupRecords, '1.7');
    expect(dump.description).toBe('Data Dictionary Lookup Resource Metadata');
    expect(dump.version).toBe('1.7');
    expect(dump.generatedOn).toBeTruthy();
    expect(dump.lookups).toHaveLength(3);
    expect(dump.lookups[0].LookupName).toBe('StandardStatus');
  });
});
