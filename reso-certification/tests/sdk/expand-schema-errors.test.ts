import { describe, expect, it } from 'vitest';
import { errorMessagesFromCache } from '../../src/sdk/expand-schema.js';

// The $expand schema-invalid report previously surfaced only the generic rule ("MUST be advertised in the
// metadata") — not WHICH field. The legacy validator's errorCache already nests the offending field under
// resources → fields; errorMessagesFromCache lifts it into the message so the failure is self-diagnosing.
describe('errorMessagesFromCache — field-qualified expand errors', () => {
  it('names the offending field(s) for each message', () => {
    const errorCache = {
      'MUST be advertised in the metadata': {
        resources: { Media: { fields: { PhotoUrl: { count: 1 }, ImageOf: { count: 2 } }, count: 3 } },
      },
    };
    const msgs = errorMessagesFromCache(errorCache);
    expect(msgs).toContain('PhotoUrl: MUST be advertised in the metadata');
    expect(msgs).toContain('ImageOf: MUST be advertised in the metadata');
  });

  it('falls back to the bare message when no field is attributed', () => {
    expect(errorMessagesFromCache({ 'Some structural error': {} })).toEqual(['Some structural error']);
  });

  it('returns [] for an empty or undefined cache', () => {
    expect(errorMessagesFromCache({})).toEqual([]);
    expect(errorMessagesFromCache(undefined)).toEqual([]);
  });

  it('dedups a field repeated across resources', () => {
    const errorCache = {
      'MUST be integer or null but found decimal': {
        resources: {
          Property: { fields: { MobileWidth: { count: 1 } } },
          Unit: { fields: { MobileWidth: { count: 1 } } },
        },
      },
    };
    const msgs = errorMessagesFromCache(errorCache);
    expect(msgs.filter((m) => m.startsWith('MobileWidth:'))).toHaveLength(1);
  });
});
