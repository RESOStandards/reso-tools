import { describe, expect, it } from 'vitest';
import { createLookupCache } from '../../src/web-api-core/lookup-cache.js';

// Two fields share the LookupName 'PropertyType'; 'StandardStatus' maps to its own; 'Unmapped' has no name.
const lookupNameFor = (resource: string, field: string): string | undefined =>
  ({
    'Property/PropertyType': 'PropertyType',
    'Property/PropertySubType': 'PropertyType', // shares the LookupName with PropertyType — the dedup case
    'Property/StandardStatus': 'StandardStatus',
  })[`${resource}/${field}`];

// PropertyType rows. The last row's data value distinguishes ONLY on LegacyODataValue (the form the old
// presence union missed): LookupValue/StandardLookupValue are 'Residential' but LegacyODataValue is 'LEGACY_ONLY'.
const propertyTypeRows: ReadonlyArray<Record<string, unknown>> = [
  { LookupName: 'PropertyType', LookupValue: 'ResidentialLease', StandardLookupValue: 'Residential Lease', LegacyODataValue: 'ResidentialLease' },
  { LookupName: 'PropertyType', LookupValue: 'CommercialSale', StandardLookupValue: 'Commercial Sale', LegacyODataValue: 'CommercialSale' },
  { LookupName: 'PropertyType', LookupValue: 'Residential', StandardLookupValue: 'Residential', LegacyODataValue: 'LEGACY_ONLY' },
];

describe('createLookupCache', () => {
  it('has(): membership unions all three wire forms, including LegacyODataValue', () => {
    const cache = createLookupCache({ lookupNameFor });
    cache.put('PropertyType', propertyTypeRows);

    expect(cache.has('Property', 'PropertyType', 'CommercialSale')).toBe(true); // LookupValue form
    expect(cache.has('Property', 'PropertyType', 'Residential Lease')).toBe(true); // StandardLookupValue form
    expect(cache.has('Property', 'PropertyType', 'LEGACY_ONLY')).toBe(true); // LegacyODataValue-only form
    expect(cache.has('Property', 'PropertyType', 'NotPresent')).toBe(false); // genuine miss
  });

  it('toStandard(): any wire form resolves to that row\'s StandardLookupValue', () => {
    const cache = createLookupCache({ lookupNameFor });
    cache.put('PropertyType', propertyTypeRows);

    expect(cache.toStandard('Property', 'PropertyType', 'CommercialSale')).toBe('Commercial Sale'); // via LookupValue
    expect(cache.toStandard('Property', 'PropertyType', 'Commercial Sale')).toBe('Commercial Sale'); // via SLV itself
    expect(cache.toStandard('Property', 'PropertyType', 'LEGACY_ONLY')).toBe('Residential'); // via LegacyODataValue
    expect(cache.toStandard('Property', 'PropertyType', 'NotPresent')).toBeUndefined(); // no matching row
  });

  it('dedup: two fields sharing a LookupName resolve from ONE put (one entry)', () => {
    const cache = createLookupCache({ lookupNameFor });
    cache.put('PropertyType', propertyTypeRows); // filled once by PropertyType

    // PropertySubType shares the LookupName — it resolves against the SAME rows without its own put.
    expect(cache.has('Property', 'PropertySubType', 'CommercialSale')).toBe(true);
    expect(cache.rowsFor('Property', 'PropertySubType')).toBe(cache.rowsFor('Property', 'PropertyType'));
    expect(cache.rowsFor('Property', 'PropertySubType')).toHaveLength(3);

    // put is idempotent: a second put for the same LookupName is a no-op (first fill wins).
    cache.put('PropertyType', [{ LookupName: 'PropertyType', LookupValue: 'Replaced', StandardLookupValue: 'Replaced', LegacyODataValue: 'Replaced' }]);
    expect(cache.rowsFor('Property', 'PropertyType')).toHaveLength(3);
    expect(cache.has('Property', 'PropertyType', 'Replaced')).toBe(false);
  });

  it('miss: an unfilled LookupName returns false / undefined', () => {
    const cache = createLookupCache({ lookupNameFor });
    cache.put('PropertyType', propertyTypeRows);

    // StandardStatus was never put.
    expect(cache.has('Property', 'StandardStatus', 'Active')).toBe(false);
    expect(cache.toStandard('Property', 'StandardStatus', 'Active')).toBeUndefined();
    expect(cache.rowsFor('Property', 'StandardStatus')).toBeUndefined();
  });

  it('falls back to the field name as the key when no LookupName resolves', () => {
    // lookupNameFor returns undefined for 'Unmapped' → the cache keys on the field name, so a put under the
    // field name is found by has()/rowsFor() (mirrors the Lookup Resource assertion's `?? field`).
    const cache = createLookupCache({ lookupNameFor });
    cache.put('Unmapped', [{ LookupName: 'Unmapped', LookupValue: 'X', StandardLookupValue: 'X', LegacyODataValue: 'X' }]);
    expect(cache.has('Property', 'Unmapped', 'X')).toBe(true);
    expect(cache.rowsFor('Property', 'Unmapped')).toHaveLength(1);
  });
});
