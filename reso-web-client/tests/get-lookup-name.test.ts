import { describe, it, expect } from 'vitest';
import { getLookupName } from '../src/hooks/use-lookups';
import type { ResoField } from '../src/types';

const makeField = (overrides: Partial<ResoField> = {}): ResoField => ({
  fieldName: 'TestField',
  type: 'Edm.String',
  annotations: [],
  ...overrides,
});

describe('getLookupName', () => {
  it('returns lookupName annotation when present', () => {
    const field = makeField({ lookupName: 'StandardStatus' });
    expect(getLookupName(field)).toBe('StandardStatus');
  });

  it('returns undefined for Edm primitive types', () => {
    expect(getLookupName(makeField({ type: 'Edm.String' }))).toBeUndefined();
    expect(getLookupName(makeField({ type: 'Edm.Int32' }))).toBeUndefined();
    expect(getLookupName(makeField({ type: 'Edm.Boolean' }))).toBeUndefined();
    expect(getLookupName(makeField({ type: 'Edm.DateTimeOffset' }))).toBeUndefined();
  });

  it('extracts enum type name from qualified type', () => {
    const field = makeField({ type: 'org.reso.metadata.StandardStatus' });
    expect(getLookupName(field)).toBe('StandardStatus');
  });

  it('extracts enum type name from unqualified type', () => {
    const field = makeField({ type: 'StandardStatus' });
    expect(getLookupName(field)).toBe('StandardStatus');
  });

  it('unwraps Collection() for multi-value enum types', () => {
    const field = makeField({ type: 'Collection(org.reso.metadata.PoolFeatures)' });
    expect(getLookupName(field)).toBe('PoolFeatures');
  });

  it('returns undefined for Collection of Edm primitives', () => {
    const field = makeField({ type: 'Collection(Edm.String)' });
    expect(getLookupName(field)).toBeUndefined();
  });

  it('returns undefined for expansion fields', () => {
    const field = makeField({ type: 'org.reso.metadata.Office', isExpansion: true });
    expect(getLookupName(field)).toBeUndefined();
  });

  it('prefers lookupName annotation over type-based inference', () => {
    const field = makeField({
      type: 'org.reso.metadata.OtherEnum',
      lookupName: 'PreferredName',
    });
    expect(getLookupName(field)).toBe('PreferredName');
  });
});
