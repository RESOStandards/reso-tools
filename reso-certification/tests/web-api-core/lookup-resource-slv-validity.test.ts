import { describe, expect, it } from 'vitest';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import { buildStandardMapFrom } from '../../src/web-api-core/standard-map.js';
import { lookupResourceSlvValidity } from '../../src/web-api-core/test-runner.js';

// Two DISTINCT DD enums — proving the SLV join is per-FIELD, not "standard in any enum". StandardStatus owns
// {Active, Pending}; AccessibilityFeatures owns {AccessibleApproachWithRamp}. A StandardStatus row declaring an
// AccessibilityFeatures value must still fail.
const ref: DdReference = {
  fields: [
    { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus' },
  ],
  lookups: [
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Active', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Active' }] },
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Pending', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Pending' }] },
    { lookupName: 'org.reso.metadata.enums.AccessibilityFeatures', lookupValue: 'AccessibleApproachWithRamp' },
  ],
};
const standardMap = buildStandardMapFrom(ref);
const never = (): boolean => false;
const always = (): boolean => true;

const row = (slv: string): Record<string, unknown> => ({ LookupName: 'StandardStatus', StandardLookupValue: slv });

describe('lookupResourceSlvValidity', () => {
  it('passes when every declared StandardLookupValue is DD-standard for the field enum', () => {
    const res = lookupResourceSlvValidity([row('Active'), row('Pending')], 'Property', 'StandardStatus', 'StandardStatus', standardMap, never);
    expect(res.passed).toBe(true);
  });

  it('fails (gating) on a bogus StandardLookupValue — a bad remap', () => {
    const res = lookupResourceSlvValidity([row('Active'), row('CompletelyMadeUp')], 'Property', 'StandardStatus', 'StandardStatus', standardMap, never);
    expect(res.passed).toBe(false);
    expect(res.message).toContain('CompletelyMadeUp');
  });

  it('joins on the FIELD\'s enum — a value standard in ANOTHER enum still fails', () => {
    // AccessibleApproachWithRamp is a real DD value, but not for StandardStatus → fail under the precise per-field set.
    const res = lookupResourceSlvValidity([row('AccessibleApproachWithRamp')], 'Property', 'StandardStatus', 'StandardStatus', standardMap, never);
    expect(res.passed).toBe(false);
    expect(res.message).toContain('AccessibleApproachWithRamp');
  });

  it('an ignoreEnumerations field is exempt from SLV-validity too', () => {
    const res = lookupResourceSlvValidity([row('CompletelyMadeUp')], 'Property', 'StandardStatus', 'StandardStatus', standardMap, always);
    expect(res.passed).toBe(true);
    expect(res.message).toContain('ignore-enumerations');
  });

  it('falls back to "standard in ANY DD enum" when the field cannot be resolved to a DD enum', () => {
    // 'UnknownField' has no DD field record → standardValuesForField is undefined → isStandardValue fallback.
    const good = lookupResourceSlvValidity([row('Active')], 'Property', 'UnknownField', 'UnknownField', standardMap, never);
    expect(good.passed).toBe(true); // 'Active' is standard in some enum
    const bad = lookupResourceSlvValidity([row('CompletelyMadeUp')], 'Property', 'UnknownField', 'UnknownField', standardMap, never);
    expect(bad.passed).toBe(false);
  });
});
