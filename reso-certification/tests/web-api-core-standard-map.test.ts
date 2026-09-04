import { describe, expect, it } from 'vitest';
import type { DdReference } from '../src/metadata/dd-metadata-checks.js';
import { buildStandardMap, buildStandardMapFrom } from '../src/web-api-core/standard-map.js';

const mockRef: DdReference = {
  fields: [
    { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus', lookupStatus: 'Locked with Enumerations' },
    { resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal' },
    { resourceName: 'Member', fieldName: 'MemberKey', type: 'Edm.String' },
    // City: a nominal enum the DD defines with ZERO standard values (no City lookups below); lookupStatus "Open".
    { resourceName: 'Property', fieldName: 'City', type: 'org.reso.metadata.enums.City', lookupStatus: 'Open' },
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

  it('standardValuesForField: joins a field to its DD enum via the field type', () => {
    // The enum field resolves to its own enum's values (via its `type`, not a wire LookupName).
    expect([...(map.standardValuesForField('Property', 'StandardStatus') ?? [])].sort()).toEqual(['Active', 'Pending']);
    // A non-enum field's type (Edm.Decimal) is not a lookup name → undefined → caller falls back to isStandardValue.
    expect(map.standardValuesForField('Property', 'ListPrice')).toBeUndefined();
    // An unknown field → undefined.
    expect(map.standardValuesForField('Property', 'ZZZLocalField')).toBeUndefined();
    // A resolvable but memberless (purely-open) enum (City) → an EMPTY set, NOT undefined — so its values
    // classify LOCAL rather than borrowing a colliding standard value from another enum.
    expect(map.standardValuesForField('Property', 'City')).toBeDefined();
    expect(map.standardValuesForField('Property', 'City')?.size).toBe(0);
  });

  it('isClosedEnumField: a "Locked" enum → true; open / primitive / unknown → false', () => {
    expect(map.isClosedEnumField('Property', 'StandardStatus')).toBe(true); // lookupStatus "Locked with Enumerations"
    expect(map.isClosedEnumField('Property', 'City')).toBe(false); // lookupStatus "Open"
    expect(map.isClosedEnumField('Property', 'ListPrice')).toBe(false); // primitive, no lookupStatus
    expect(map.isClosedEnumField('Member', 'MemberKey')).toBe(false); // primitive, no lookupStatus
    expect(map.isClosedEnumField('Property', 'ZZZUnknown')).toBe(false); // unknown field
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

  it('isClosedEnumField against the real DD: StandardStatus is Locked (closed); City and OpenHouseStatus are not', () => {
    // Only "Locked with Enumerations" enums are closed. StandardStatus is locked; City is "Open" and
    // OpenHouseStatus is "Open with Enumerations" — both permit local extension.
    expect(map.isClosedEnumField('Property', 'StandardStatus')).toBe(true);
    expect(map.isClosedEnumField('Property', 'City')).toBe(false);
    expect(map.isClosedEnumField('OpenHouse', 'OpenHouseStatus')).toBe(false);
  });
});
