/**
 * `hasValidSearchInput` — guard for `fetchSuggestions`.
 *
 * The original guard required BOTH `fields` and `lookups` to be
 * non-empty. That assumption pre-dates Lookup Resource support.
 *
 * Servers using the Lookup Resource pattern produce metadata reports
 * with `lookups: []` (enumerated values live on the Lookup resource
 * and are queried at runtime, not declared as static Edm.EnumType in
 * $metadata). Under the old guard those servers would skip the
 * variations service call entirely, and `ignored` flags posted to
 * the service were never honored on the merge side.
 *
 * The guard now passes when EITHER array is non-empty. Carries over
 * from reso-certification-utils v3.0.0.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { hasValidSearchInput } = require(resolve(legacyRoot, 'lib/variations/index.js'));

describe('hasValidSearchInput', () => {
  it('rejects when both fields and lookups are empty', () => {
    expect(hasValidSearchInput({ fields: [], lookups: [] })).toBe(false);
  });

  it('rejects when fields is missing entirely (defaults to empty array)', () => {
    expect(hasValidSearchInput({})).toBe(false);
  });

  it('passes when fields is missing but lookups is populated', () => {
    expect(hasValidSearchInput({ lookups: [{ lookupName: 'X', lookupValue: 'Y' }] })).toBe(true);
  });

  it('rejects when either argument is not an array', () => {
    expect(hasValidSearchInput({ fields: 'oops', lookups: [] })).toBe(false);
    expect(hasValidSearchInput({ fields: [], lookups: null })).toBe(false);
    expect(hasValidSearchInput({ fields: {}, lookups: [{}] })).toBe(false);
  });

  it('accepts when only fields are present (Lookup Resource pattern)', () => {
    // Lookup Resource servers expose enums at runtime, not in $metadata,
    // so the metadata report's static `lookups[]` is legitimately empty.
    expect(hasValidSearchInput({ fields: [{ resourceName: 'Property', fieldName: 'Fee2' }], lookups: [] })).toBe(true);
  });

  it('accepts when only lookups are present', () => {
    expect(hasValidSearchInput({ fields: [], lookups: [{ lookupName: 'X', lookupValue: 'Y' }] })).toBe(true);
  });

  it('accepts when both are present', () => {
    expect(hasValidSearchInput({ fields: [{}], lookups: [{}] })).toBe(true);
  });
});
