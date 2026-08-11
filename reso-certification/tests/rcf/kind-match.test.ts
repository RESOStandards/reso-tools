import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { buildKindMatcher, DEFAULT_KIND_MATCH_OPTIONS, type KindMatchOptions } from '../../src/rcf/kind-match.js';
import type { ReferenceMap } from '../../src/rcf/assemble-report.js';

// A small synthetic reference with controlled field distribution, so idf and every gate are exact.
// ModificationTimestamp is in ALL four resources → idf 0 (noise). Resource-specific fields are df=1.
// SharedA/B/C are in exactly two resources (Property + Media) → identical, ambiguous evidence.
const lookup = (name: string, values: ReadonlyArray<string>) => ({
  type: 'org.reso.metadata.enums.X',
  isLookupField: true,
  lookupValues: Object.fromEntries(values.map(v => [v, { type: 'x', lookupName: name, lookupValue: v }])),
});

const REF: ReferenceMap = {
  Property: {
    PropertyKey: { type: 'Edm.String' },
    ListPrice: { type: 'Edm.Decimal' },
    City: { type: 'Edm.String' },
    StandardStatus: lookup('StandardStatus', ['Active', 'Closed', 'Pending']),
    SharedA: { type: 'Edm.String' },
    SharedB: { type: 'Edm.String' },
    SharedC: { type: 'Edm.String' },
    ModificationTimestamp: { type: 'Edm.DateTimeOffset' },
  },
  Media: {
    MediaKey: { type: 'Edm.String' },
    MediaURL: { type: 'Edm.String' },
    Order: { type: 'Edm.Int32' },
    MediaCategory: lookup('MediaCategory', ['Photo', 'Video', 'Document']),
    SharedA: { type: 'Edm.String' },
    SharedB: { type: 'Edm.String' },
    SharedC: { type: 'Edm.String' },
    ModificationTimestamp: { type: 'Edm.DateTimeOffset' },
  },
  Member: {
    MemberKey: { type: 'Edm.String' },
    MemberEmail: { type: 'Edm.String' },
    MemberType: { type: 'Edm.String' },
    ModificationTimestamp: { type: 'Edm.DateTimeOffset' },
  },
  OpenHouse: {
    OpenHouseKey: { type: 'Edm.String' },
    OpenHouseStartTime: { type: 'Edm.DateTimeOffset' },
    ModificationTimestamp: { type: 'Edm.DateTimeOffset' },
  },
};

// Explicit low floor so a 2-unique-field shape clears in this 4-resource fixture (unique idf ≈ ln 4 ≈ 1.39).
const OPTS: KindMatchOptions = { minMatchIdf: 2.0, minContainment: 0.4, marginRatio: 1.5, keyBonus: 2.0, enumBonus: 1.5 };

describe('buildKindMatcher (synthetic reference)', () => {
  const matcher = buildKindMatcher(REF, OPTS);

  it('matches a shape of resource-specific fields to that resource', () => {
    const m = matcher.match({ fields: ['MediaURL', 'Order'] });
    expect(m?.resource).toBe('Media');
    expect(m?.containment).toBeCloseTo(1, 5); // both known fields belong to Media
  });

  it('applies the key-field boost for {Resource}Key', () => {
    const m = matcher.match({ fields: ['MediaKey', 'MediaURL'] });
    expect(m?.resource).toBe('Media');
    expect(m?.signals.keyField).toBe(true);
  });

  it('uses enum-value overlap as corroboration', () => {
    const withValues = matcher.match({ fields: ['MediaCategory', 'MediaURL'], enumValuesByField: { MediaCategory: ['Photo', 'Video'] } });
    const withoutValues = matcher.match({ fields: ['MediaCategory', 'MediaURL'] });
    expect(withValues?.resource).toBe('Media');
    expect(withValues?.signals.enumOverlap).toBeCloseTo(1, 5); // both observed values are valid MediaCategory values
    expect((withValues?.score ?? 0)).toBeGreaterThan(withoutValues?.score ?? 0); // values add evidence
  });

  it('ignores enum values that are not valid for the candidate lookup', () => {
    const m = matcher.match({ fields: ['MediaCategory', 'MediaURL'], enumValuesByField: { MediaCategory: ['NotAValue', 'AlsoNot'] } });
    expect(m?.signals.enumOverlap).toBe(0); // no overlap → no corroboration
  });

  it('declines below the match floor (a single low-idf field is too thin)', () => {
    expect(matcher.match({ fields: ['City'] })).toBeNull();
  });

  it('declines an ambiguous shape (no margin over the runner-up)', () => {
    // SharedA/B/C are in Property AND Media in equal measure → tie → margin 1.0 < 1.5.
    expect(matcher.match({ fields: ['SharedA', 'SharedB', 'SharedC'] })).toBeNull();
  });

  it('declines a shape of only ubiquitous fields (zero known-idf mass)', () => {
    expect(matcher.match({ fields: ['ModificationTimestamp'] })).toBeNull();
  });

  it('declines a shape of only unknown fields', () => {
    expect(matcher.match({ fields: ['totally_unknown', 'also_unknown'] })).toBeNull();
  });

  it('declines an empty shape', () => {
    expect(matcher.match({ fields: [] })).toBeNull();
  });

  it('excludes the parent resource — a shape of parent-only fields does not self-match', () => {
    // The `Structure`-flattening case: fields that belong only to Media, with Media excluded → no other match.
    expect(matcher.match({ fields: ['MediaURL', 'Order'], exclude: ['Media'] })).toBeNull();
  });
});

// Grounded against the real DD 1.7 reference with the shipped DEFAULT options — locks in the calibration.
describe('buildKindMatcher (real DD 1.7 reference)', () => {
  const require = createRequire(import.meta.url);
  const { getReferenceMetadata } = require('../../src/etl/index.cjs') as { getReferenceMetadata: (v: string) => unknown };
  const { buildMetadataMap } = require('../../src/legacy/common.js') as { buildMetadataMap: (r: unknown) => { metadataMap: ReferenceMap } };
  const referenceMap = buildMetadataMap(getReferenceMetadata('1.7')).metadataMap;
  const matcher = buildKindMatcher(referenceMap, DEFAULT_KIND_MATCH_OPTIONS);

  it('recovers a resource from its own field shape (e.g. PropertyPowerProduction), excluding the parent', () => {
    const fields = Object.keys(referenceMap.PropertyPowerProduction ?? {});
    expect(fields.length).toBeGreaterThan(0);
    const m = matcher.match({ fields, exclude: ['Property'] });
    expect(m?.resource).toBe('PropertyPowerProduction');
  });

  it('declines a shape of Property-only fields with Property excluded (the Structure flattening artifact)', () => {
    const df = new Map<string, number>();
    for (const r of Object.keys(referenceMap)) for (const f of Object.keys(referenceMap[r])) df.set(f, (df.get(f) ?? 0) + 1);
    const propertyUnique = Object.keys(referenceMap.Property ?? {})
      .filter(f => df.get(f) === 1)
      .slice(0, 10);
    expect(propertyUnique.length).toBeGreaterThan(2);
    expect(matcher.match({ fields: propertyUnique, exclude: ['Property'] })).toBeNull();
  });
});
