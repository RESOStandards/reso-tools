import { describe, it, expect } from 'vitest';
import { KEY_FIELD_MAP, type ResoMetadata } from '../src/index.js';

describe('reso-common metadata model', () => {
  it('exposes the DD key-field map', () => {
    expect(KEY_FIELD_MAP.Property).toBe('ListingKey');
    expect(KEY_FIELD_MAP.Member).toBe('MemberKey');
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
