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

  // Two different rules share the text "MUST be advertised in the metadata": utils.js raises it for an
  // unadvertised enum VALUE, validate.js raises "Fields MUST be advertised..." for an unadvertised FIELD. The
  // first reads as a statement about the field it names, so a report said the field MUST be advertised for a
  // field that WAS advertised. Live Core run 2026-10-04; cost four wrong explanations. The value was in the
  // cache the whole time, under fields[name].lookups.
  it('names the failing VALUES when the rule failed on a value, not on the field', () => {
    const errorCache = {
      'MUST be advertised in the metadata': {
        resources: {
          Property: { fields: { ConstructionMaterials: { lookups: { Frame: { count: 2 }, Brick: { count: 1 } } } } },
        },
      },
    };
    // Sorted, so the message does not change between runs on map order alone.
    expect(errorMessagesFromCache(errorCache)).toEqual([
      'MUST be advertised in the metadata (field: ConstructionMaterials [Brick, Frame])',
    ]);
  });

  it('caps the values listed and counts the remainder', () => {
    const lookups = Object.fromEntries(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'].map((v) => [v, { count: 1 }]));
    const errorCache = {
      'MUST be advertised in the metadata': { resources: { Property: { fields: { Appliances: { lookups } } } } },
    };
    expect(errorMessagesFromCache(errorCache)).toEqual([
      'MUST be advertised in the metadata (field: Appliances [v1, v2, v3, v4, v5, +2 more])',
    ]);
  });

  it('renders a value-bearing field and a field-level field side by side', () => {
    const errorCache = {
      'MUST be advertised in the metadata': {
        resources: {
          Property: { fields: { ConstructionMaterials: { lookups: { Brick: { count: 1 } } }, PhotoUrl: { count: 1 } } },
        },
      },
    };
    expect(errorMessagesFromCache(errorCache)).toEqual([
      'MUST be advertised in the metadata (fields: ConstructionMaterials [Brick], PhotoUrl)',
    ]);
  });

  it('dedups the same value seen under two resources', () => {
    const errorCache = {
      'MUST be advertised in the metadata': {
        resources: {
          Property: { fields: { View: { lookups: { Ocean: { count: 1 } } } } },
          Unit: { fields: { View: { lookups: { Ocean: { count: 3 }, Mountain: { count: 1 } } } } },
        },
      },
    };
    expect(errorMessagesFromCache(errorCache)).toEqual([
      'MUST be advertised in the metadata (field: View [Mountain, Ocean])',
    ]);
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
