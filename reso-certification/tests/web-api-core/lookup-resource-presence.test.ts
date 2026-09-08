import { describe, expect, it } from 'vitest';
import { createLookupCache } from '../../src/web-api-core/lookup-cache.js';
import { lookupResourcePresence } from '../../src/web-api-core/test-runner.js';

// A cache wired to resolve the two test fields to their LookupNames, matching the SDK's per-resource registry.
const makeCache = (rows: ReadonlyArray<Record<string, unknown>>, lookupName: string, field: string) => {
  const cache = createLookupCache({ lookupNameFor: (_res, f) => (f === field ? lookupName : undefined) });
  cache.put(lookupName, rows);
  return cache;
};

// A row whose data value distinguishes ONLY on LegacyODataValue — the form the old presence union missed.
const rows: ReadonlyArray<Record<string, unknown>> = [
  { LookupName: 'PropertyType', LookupValue: 'CommercialSale', StandardLookupValue: 'Commercial Sale', LegacyODataValue: 'CommercialSale' },
  { LookupName: 'PropertyType', LookupValue: 'Residential', StandardLookupValue: 'Residential', LegacyODataValue: 'LEGACY_ONLY' },
];

const never = (): boolean => false;
const always = (): boolean => true;

describe('lookupResourcePresence', () => {
  it('passes a value present ONLY as LegacyODataValue (the closed false-fail hole)', () => {
    const cache = makeCache(rows, 'PropertyType', 'PropertyType');
    const res = lookupResourcePresence(rows, 'Property', 'PropertyType', 'PropertyType', ['LEGACY_ONLY'], cache, never);
    expect(res.passed).toBe(true);
  });

  it('a genuinely-missing value on a NON-exempt field fails', () => {
    const cache = makeCache(rows, 'PropertyType', 'PropertyType');
    const res = lookupResourcePresence(rows, 'Property', 'PropertyType', 'PropertyType', ['NotPublished'], cache, never);
    expect(res.passed).toBe(false);
    expect(res.message).toContain('NotPublished');
  });

  it('an ignoreEnumerations field with an unadvertised value passes (exempt)', () => {
    const cache = makeCache(rows, 'PropertyType', 'PropertyType');
    // The value is NOT in the rows, but the field is exempt → pass.
    const res = lookupResourcePresence(rows, 'Property', 'PropertyType', 'PropertyType', ['SomeLocalValue'], cache, always);
    expect(res.passed).toBe(true);
    expect(res.message).toContain('ignore-enumerations');
  });

  it('0 rows and a wrong LookupName are still determinate fails (independent of the ignore list)', () => {
    const emptyCache = createLookupCache({ lookupNameFor: () => 'PropertyType' });
    const zero = lookupResourcePresence([], 'Property', 'PropertyType', 'PropertyType', ['x'], emptyCache, always);
    expect(zero.passed).toBe(false);
    expect(zero.message).toContain('no rows');

    const wrongRows = [{ LookupName: 'SomethingElse', LookupValue: 'x', StandardLookupValue: 'x', LegacyODataValue: 'x' }];
    const wrongCache = makeCache(wrongRows, 'PropertyType', 'PropertyType');
    const wrong = lookupResourcePresence(wrongRows, 'Property', 'PropertyType', 'PropertyType', ['x'], wrongCache, always);
    expect(wrong.passed).toBe(false);
    expect(wrong.message).toContain('expected');
  });
});
