import { describe, expect, it } from 'vitest';
import type { DdReference } from '../src/metadata/dd-metadata-checks.js';
import { buildStandardMap, buildStandardMapFrom } from '../src/web-api-core/standard-map.js';

const mockRef: DdReference = {
  fields: [
    { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus' },
    { resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal' },
    { resourceName: 'Member', fieldName: 'MemberKey', type: 'Edm.String' },
  ],
  lookups: [
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Active' },
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Pending' },
    { lookupName: 'org.reso.metadata.enums.AccessibilityFeatures', lookupValue: 'AccessibleApproachWithRamp' },
  ],
};

describe('buildStandardMapFrom — membership tests', () => {
  const map = buildStandardMapFrom(mockRef);

  it('isStandardField: standard field true, local false, resource-scoped', () => {
    expect(map.isStandardField('Property', 'StandardStatus')).toBe(true);
    expect(map.isStandardField('Property', 'ListPrice')).toBe(true);
    expect(map.isStandardField('Property', 'X_LocalField')).toBe(false);
    expect(map.isStandardField('Member', 'StandardStatus')).toBe(false); // right name, wrong resource
  });

  it('isStandardValue: true if the value is in ANY DD enum', () => {
    expect(map.isStandardValue('Active')).toBe(true);
    expect(map.isStandardValue('AccessibleApproachWithRamp')).toBe(true); // a different enum
    expect(map.isStandardValue('NotAStandardValue')).toBe(false);
  });

  it('standardValues: the precise per-lookup set', () => {
    expect([...map.standardValues('org.reso.metadata.enums.StandardStatus')].sort()).toEqual(['Active', 'Pending']);
    expect(map.standardValues('org.reso.metadata.enums.DoesNotExist').size).toBe(0);
  });
});

describe('buildStandardMap — loads the real dd-2.1 reference', () => {
  const map = buildStandardMap('2.1');

  it('resolves rock-solid standard fields + values, rejects an obvious local', () => {
    expect(map.isStandardField('Property', 'ListPrice')).toBe(true);
    expect(map.isStandardField('Property', 'StandardStatus')).toBe(true);
    expect(map.isStandardField('Property', 'ZZZDefinitelyLocalXYZ')).toBe(false);
    expect(map.isStandardValue('Active')).toBe(true);
  });

  it('REGRESSION — normalizes the 3-part Core spec version to the 2-part DD file (2.1.0 → dd-2.1)', () => {
    // The Core runner passes the spec version '2.1.0'; the reference files are dd-2.0/dd-2.1. Before the fix
    // this loaded null and crashed the whole scenario step on `null.fields`. It must load the real reference.
    const core21 = buildStandardMap('2.1.0');
    expect(core21.isStandardField('Property', 'ListPrice')).toBe(true);
    const core20 = buildStandardMap('2.0.0');
    expect(core20.isStandardField('Property', 'ListPrice')).toBe(true);
  });

  it('falls back to the latest published DD when the requested version is unavailable (never throws)', () => {
    // No dd-9.9.json → the requested load returns null → fall back to the latest DD (still populated), per the
    // "latest major.minor" rule, rather than degrading to all-local. A crash here is what the old code did.
    const future = buildStandardMap('9.9.9');
    expect(future.isStandardField('Property', 'ListPrice')).toBe(true); // resolved against the latest DD
    expect(future.isStandardValue('Active')).toBe(true);
  });
});
