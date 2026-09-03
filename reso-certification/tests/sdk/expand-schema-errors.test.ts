import { describe, expect, it } from 'vitest';
import { errorMessagesFromCache } from '../../src/sdk/expand-schema.js';

// The $expand schema-invalid report previously surfaced only the generic rule ("MUST be advertised in the
// metadata") — not WHICH field. The legacy validator's errorCache already nests the offending field under
// resources → fields; errorMessagesFromCache lifts it into the message so the failure is self-diagnosing.
describe('errorMessagesFromCache — field-qualified expand errors', () => {
  it('names the offending field(s) in ONE entry per rule', () => {
    const errorCache = {
      'MUST be advertised in the metadata': {
        resources: { Media: { fields: { PhotoUrl: { count: 1 }, ImageOf: { count: 2 } }, count: 3 } },
      },
    };
    const msgs = errorMessagesFromCache(errorCache);
    expect(msgs).toEqual(['MUST be advertised in the metadata (fields: PhotoUrl, ImageOf)']);
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
    expect(msgs).toEqual(['MUST be integer or null but found decimal (field: MobileWidth)']);
  });

  // Adversarial-review regression: fanning out per FIELD let one message's fields crowd distinct RULES out
  // of validateExpandedItems' first.errors.slice(0,3) preview. One entry per message keeps both rules.
  it('keeps distinct rules as separate entries so a truncated preview never drops a second rule', () => {
    const errorCache = {
      'Fields MUST be advertised in the metadata': { resources: { Media: { fields: { A: {}, B: {}, C: {}, D: {} } } } },
      'MUST have a maximum advertised length': { resources: { Media: { fields: { LongText: {} } } } },
    };
    const msgs = errorMessagesFromCache(errorCache);
    expect(msgs).toHaveLength(2);
    expect(msgs.some((m) => m.startsWith('MUST have a maximum advertised length'))).toBe(true);
  });
});
