import { describe, expect, it } from 'vitest';
import { isFieldEnum } from '../src/components/cert/server-explorer';

describe('isFieldEnum', () => {
  it('returns true for RESO standard enum types', () => {
    expect(isFieldEnum({ type: 'org.reso.metadata.enums.StandardStatus' })).toBe(true);
    expect(isFieldEnum({ type: 'org.reso.metadata.enums.Appliances' })).toBe(true);
  });

  it('returns true for vendor-namespaced enum types', () => {
    expect(isFieldEnum({ type: 'PropertyEnums.AccessibilityFeatures' })).toBe(true);
    expect(isFieldEnum({ type: 'CoreLogic.DataStandardsName' })).toBe(true);
  });

  it('returns true for non-namespaced non-Edm types', () => {
    expect(isFieldEnum({ type: 'StandardStatus' })).toBe(true);
    expect(isFieldEnum({ type: 'Appliances' })).toBe(true);
    expect(isFieldEnum({ type: 'PostalCode' })).toBe(true);
  });

  it('returns false for Edm primitive types', () => {
    expect(isFieldEnum({ type: 'Edm.String' })).toBe(false);
    expect(isFieldEnum({ type: 'Edm.Boolean' })).toBe(false);
    expect(isFieldEnum({ type: 'Edm.Int32' })).toBe(false);
    expect(isFieldEnum({ type: 'Edm.Decimal' })).toBe(false);
    expect(isFieldEnum({ type: 'Edm.DateTimeOffset' })).toBe(false);
    expect(isFieldEnum({ type: 'Edm.Date' })).toBe(false);
  });

  it('returns false for expansion fields', () => {
    expect(isFieldEnum({ type: 'ODataService.Media', isExpansion: true })).toBe(false);
    expect(isFieldEnum({ type: 'ODataService.OpenHouse', isExpansion: true })).toBe(false);
    expect(isFieldEnum({ type: 'Media', isExpansion: true })).toBe(false);
  });

  it('returns false for complex type fields', () => {
    expect(isFieldEnum({ type: 'SomeVendor.AddressType', isComplexType: true })).toBe(false);
    expect(isFieldEnum({ type: 'CustomComplex', isComplexType: true })).toBe(false);
  });

  it('returns false when both isExpansion and isComplexType are true', () => {
    expect(isFieldEnum({ type: 'SomeType', isExpansion: true, isComplexType: true })).toBe(false);
  });

  it('returns true when isExpansion and isComplexType are explicitly false', () => {
    expect(isFieldEnum({ type: 'StandardStatus', isExpansion: false, isComplexType: false })).toBe(true);
  });

  it('returns true when isExpansion and isComplexType are undefined', () => {
    expect(isFieldEnum({ type: 'StandardStatus' })).toBe(true);
  });

  it('does not match types starting with Edm but without the dot', () => {
    // "EdmEdmEdm" is not an Edm primitive — it is a valid non-Edm type
    expect(isFieldEnum({ type: 'EdmEdmEdm' })).toBe(true);
  });

  it('matches Edm. with the dot correctly', () => {
    expect(isFieldEnum({ type: 'Edm.String' })).toBe(false);
    expect(isFieldEnum({ type: 'Edm.' })).toBe(false);
  });
});
