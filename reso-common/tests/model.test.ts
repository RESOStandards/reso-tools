import { describe, it, expect } from 'vitest';
import { KEY_FIELD_MAP, getKeyFieldForResource, type ResoMetadata } from '../src/index.js';

describe('reso-common metadata model', () => {
  it('stores only the key-field exceptions, resolving the convention via the helper', () => {
    // Exceptions are stored verbatim...
    expect(KEY_FIELD_MAP.Property).toBe('ListingKey');
    expect(KEY_FIELD_MAP.InternetTrackingSummary).toBe('ListingId'); // a non-*Key exception
    // ...convention resources are NOT stored — the helper applies {ResourceName}Key.
    expect(KEY_FIELD_MAP.Member).toBeUndefined();
    expect(getKeyFieldForResource('Member')).toBe('MemberKey');     // convention via fallback
    expect(getKeyFieldForResource('Property')).toBe('ListingKey');  // exception via helper
    expect(getKeyFieldForResource('Anything')).toBe('AnythingKey'); // unknown → convention
  });

  it('constructs a ResoMetadata value', () => {
    const m: ResoMetadata = {
      description: 'test',
      version: '2.1',
      generatedOn: '2026-06-19T00:00:00.000Z',
      resources: [],
      fields: [],
      lookups: [],
    };
    expect(m.version).toBe('2.1');
  });
});
