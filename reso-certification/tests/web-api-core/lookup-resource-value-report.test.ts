import { describe, expect, it } from 'vitest';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import { buildStandardMapFrom } from '../../src/web-api-core/standard-map.js';
import { lookupResourceValueReport } from '../../src/web-api-core/test-runner.js';

// Three enums exercising the open/closed axis the report reads:
//  - StandardStatus  → "Locked with Enumerations"  (CLOSED; a local value warns "would not pass DD")
//  - OpenHouseStatus → "Open with Enumerations"    (OPEN; a local value is a permitted extension)
//  - City            → "Open" with ZERO DD members (purely open; every value is local)
// AccessibilityFeatures owns a value in NO test field, proving the classification joins per-FIELD.
const ref: DdReference = {
  fields: [
    { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus', lookupStatus: 'Locked with Enumerations' },
    { resourceName: 'OpenHouse', fieldName: 'OpenHouseStatus', type: 'org.reso.metadata.enums.OpenHouseStatus', lookupStatus: 'Open with Enumerations' },
    { resourceName: 'Property', fieldName: 'City', type: 'org.reso.metadata.enums.City', lookupStatus: 'Open' },
  ],
  lookups: [
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Active', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Active' }] },
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Pending', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Pending' }] },
    { lookupName: 'org.reso.metadata.enums.OpenHouseStatus', lookupValue: 'Active', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Active' }] },
    { lookupName: 'org.reso.metadata.enums.OpenHouseStatus', lookupValue: 'Ended', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Ended' }] },
    { lookupName: 'org.reso.metadata.enums.AccessibilityFeatures', lookupValue: 'AccessibleApproachWithRamp' },
  ],
};
const standardMap = buildStandardMapFrom(ref);
const never = (): boolean => false;
const always = (): boolean => true;
const row = (slv: string): Record<string, unknown> => ({ StandardLookupValue: slv });

describe('lookupResourceValueReport — report-only classification, NEVER gates', () => {
  it('all DD-standard values → PASS, reports them as standard', () => {
    const res = lookupResourceValueReport([row('Active'), row('Pending')], 'Property', 'StandardStatus', 'StandardStatus', standardMap, never);
    expect(res.passed).toBe(true);
    expect(res.message).toContain('all 2 value(s) are DD-standard');
  });

  it('OPEN enum + a local value → PASS, classified local, no closed-enum warning (OpenHouseStatus \'Deleted\' regression)', () => {
    const res = lookupResourceValueReport([row('Active'), row('Deleted')], 'OpenHouse', 'OpenHouseStatus', 'OpenHouseStatus', standardMap, never);
    expect(res.passed).toBe(true); // a local value on an open enum is a permitted extension — never a failure
    expect(res.message).toContain("'Deleted'");
    expect(res.message).toContain('local value');
    expect(res.message).toContain('permitted for open enumerations');
    expect(res.message).not.toContain('closed enumeration');
    expect(res.message).not.toContain('would not pass');
  });

  it('CLOSED enum + a local value → PASS (report only) but WARNS it would not pass DD', () => {
    const res = lookupResourceValueReport([row('Active'), row('CompletelyMadeUp')], 'Property', 'StandardStatus', 'StandardStatus', standardMap, never);
    expect(res.passed).toBe(true); // Core NEVER fails — even extending a closed enum is caught in DD, not Core
    expect(res.message).toContain("'CompletelyMadeUp'");
    expect(res.message).toContain('closed enumeration');
    expect(res.message).toContain('would not pass Data Dictionary testing');
  });

  it('NEVER fails Core — a closed enum full of bogus values still passes (report only)', () => {
    const res = lookupResourceValueReport([row('Nope'), row('AlsoNope')], 'Property', 'StandardStatus', 'StandardStatus', standardMap, never);
    expect(res.passed).toBe(true);
  });

  it('a purely-open enum (City, zero DD members) → PASS, values classified local, not closed', () => {
    const res = lookupResourceValueReport([row('Spanish Fork'), row('Simsboro')], 'Property', 'City', 'City', standardMap, never);
    expect(res.passed).toBe(true);
    expect(res.message).toContain('2 local value(s)');
    expect(res.message).not.toContain('closed enumeration');
  });

  it('a purely-open field value colliding with a standard value in ANOTHER enum classifies LOCAL (adversarial-review regression)', () => {
    // City is purely-open (zero DD members). 'Active' is a standard value in StandardStatus/OpenHouseStatus, but
    // NOT for City — it must classify as a LOCAL city value, never borrowed as DD-standard from another enum.
    // The bug (before restoring the resolvable-but-empty distinction): standardValuesForField returned undefined
    // for City → isStandardValue fallback → 'Active' mislabeled DD-standard on exactly the field where listing
    // locals is the point.
    const res = lookupResourceValueReport([row('Active')], 'Property', 'City', 'City', standardMap, never);
    expect(res.passed).toBe(true);
    expect(res.message).toContain("'Active'");
    expect(res.message).toContain('0 DD-standard, 1 local value(s)'); // classified local, not borrowed from another enum
  });

  it('an ignoreEnumerations field → PASS, not classified', () => {
    const res = lookupResourceValueReport([row('CompletelyMadeUp')], 'Property', 'StandardStatus', 'StandardStatus', standardMap, always);
    expect(res.passed).toBe(true);
    expect(res.message).toContain('ignore-enumerations');
  });

  it('no StandardLookupValue rows → PASS, nothing to classify', () => {
    const res = lookupResourceValueReport([{ LookupName: 'StandardStatus' }], 'Property', 'StandardStatus', 'StandardStatus', standardMap, never);
    expect(res.passed).toBe(true);
    expect(res.message).toContain('no StandardLookupValue values to classify');
  });

  it('classification joins on the FIELD enum — a value standard in ANOTHER enum is local here', () => {
    // AccessibleApproachWithRamp is a real DD value, but not for OpenHouseStatus → local under the per-field set.
    const res = lookupResourceValueReport([row('AccessibleApproachWithRamp')], 'OpenHouse', 'OpenHouseStatus', 'OpenHouseStatus', standardMap, never);
    expect(res.passed).toBe(true);
    expect(res.message).toContain("'AccessibleApproachWithRamp'");
    expect(res.message).toContain('local value');
  });

  it('an unresolvable field falls back to "standard in ANY DD enum" — still never fails', () => {
    // 'UnknownField' has no DD record → standardValuesForField undefined → isStandardValue fallback; not closed.
    const std = lookupResourceValueReport([row('Active')], 'Property', 'UnknownField', 'UnknownField', standardMap, never);
    expect(std.passed).toBe(true);
    expect(std.message).toContain('all 1 value(s) are DD-standard'); // 'Active' is standard in some enum
    const loc = lookupResourceValueReport([row('CompletelyMadeUp')], 'Property', 'UnknownField', 'UnknownField', standardMap, never);
    expect(loc.passed).toBe(true);
    expect(loc.message).toContain('local value');
  });
});
