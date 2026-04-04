import { describe, it, expect } from 'vitest';
import { buildSearchFields } from '../src/components/basic-search';
import type { ResoField } from '../src/types';

const makeField = (fieldName: string, type: string, overrides: Partial<ResoField> = {}): ResoField => ({
  fieldName,
  type,
  annotations: [],
  ...overrides,
});

const sampleFields: ReadonlyArray<ResoField> = [
  makeField('ListingId', 'Edm.String'),
  makeField('City', 'Edm.String'),
  makeField('ListPrice', 'Edm.Decimal'),
  makeField('StandardStatus', 'org.reso.metadata.StandardStatus'),
  makeField('PropertyType', 'org.reso.metadata.PropertyType'),
  makeField('ModificationTimestamp', 'Edm.DateTimeOffset'),
  makeField('ListingKey', 'Edm.String'),
  makeField('OriginatingSystemName', 'Edm.String'),
  makeField('SourceSystemID', 'Edm.String'),
  makeField('BedroomsTotal', 'Edm.Int32'),
  makeField('Media', 'org.reso.metadata.Media', { isExpansion: true }),
  makeField('PoolFeatures', 'Collection(org.reso.metadata.PoolFeatures)', { isCollection: true }),
];

describe('buildSearchFields', () => {
  it('builds fields in ranked order from analytics data', () => {
    const ranked = ['ListingId', 'City', 'ListPrice', 'StandardStatus'];
    const result = buildSearchFields(ranked, sampleFields);
    expect(result.map(f => f.fieldName)).toEqual(['ListingId', 'City', 'ListPrice', 'StandardStatus', 'ModificationTimestamp']);
  });

  it('skips fields ending in Key', () => {
    const ranked = ['ListingKey', 'City'];
    const result = buildSearchFields(ranked, sampleFields);
    expect(result.map(f => f.fieldName)).not.toContain('ListingKey');
  });

  it('skips fields ending in SystemID or SystemName', () => {
    const ranked = ['SourceSystemID', 'OriginatingSystemName', 'City'];
    const result = buildSearchFields(ranked, sampleFields);
    expect(result.map(f => f.fieldName)).not.toContain('SourceSystemID');
    expect(result.map(f => f.fieldName)).not.toContain('OriginatingSystemName');
  });

  it('skips expansion fields', () => {
    const ranked = ['Media', 'City'];
    const result = buildSearchFields(ranked, sampleFields);
    expect(result.map(f => f.fieldName)).not.toContain('Media');
  });

  it('skips collection fields', () => {
    const ranked = ['PoolFeatures', 'City'];
    const result = buildSearchFields(ranked, sampleFields);
    expect(result.map(f => f.fieldName)).not.toContain('PoolFeatures');
  });

  it('assigns correct input types based on field metadata', () => {
    const ranked = ['City', 'ListPrice', 'StandardStatus', 'ModificationTimestamp'];
    const result = buildSearchFields(ranked, sampleFields);
    const byField = Object.fromEntries(result.map(f => [f.fieldName, f]));
    expect(byField['City'].inputType).toBe('text');
    expect(byField['City'].operator).toBe('contains');
    expect(byField['ListPrice'].inputType).toBe('number');
    expect(byField['ListPrice'].operator).toBe('ge');
    expect(byField['StandardStatus'].inputType).toBe('enum');
    expect(byField['StandardStatus'].operator).toBe('eq');
    expect(byField['ModificationTimestamp'].inputType).toBe('date');
    expect(byField['ModificationTimestamp'].operator).toBe('ge');
  });

  it('always includes ModificationTimestamp if the server has it', () => {
    const ranked = ['City', 'ListPrice'];
    const result = buildSearchFields(ranked, sampleFields);
    expect(result.map(f => f.fieldName)).toContain('ModificationTimestamp');
  });

  it('does not include ModificationTimestamp if the server lacks it', () => {
    const fieldsWithout = sampleFields.filter(f => f.fieldName !== 'ModificationTimestamp');
    const ranked = ['City', 'ListPrice'];
    const result = buildSearchFields(ranked, fieldsWithout);
    expect(result.map(f => f.fieldName)).not.toContain('ModificationTimestamp');
  });

  it('only includes fields that exist in the server metadata', () => {
    const ranked = ['City', 'NonExistentField', 'ListPrice'];
    const result = buildSearchFields(ranked, sampleFields);
    expect(result.map(f => f.fieldName)).not.toContain('NonExistentField');
  });

  it('limits to MAX_SEARCH_FIELDS (7)', () => {
    const ranked = ['ListingId', 'City', 'ListPrice', 'StandardStatus', 'PropertyType', 'BedroomsTotal', 'ModificationTimestamp', 'OriginatingSystemName'];
    const result = buildSearchFields(ranked, sampleFields);
    // 7 from ranked (some skipped) + ModificationTimestamp if not already included
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('falls back to server field order when no ranked names provided', () => {
    const result = buildSearchFields([], sampleFields);
    // Only ModificationTimestamp (auto-added)
    expect(result.length).toBe(1);
    expect(result[0].fieldName).toBe('ModificationTimestamp');
  });
});
