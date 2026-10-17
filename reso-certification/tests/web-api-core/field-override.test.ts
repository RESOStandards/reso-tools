import { describe, expect, it } from 'vitest';
import {
  NO_FIELD_OVERRIDES,
  applyFieldOverrides,
  matchedOverrides,
  overrideFor,
  parseFieldOverrides,
  summarizeFieldOverrides
} from '../../src/web-api-core/field-override.js';

/** A stand-in for either candidate shape — both expose `field` and a distinct-value count. */
interface Cand {
  readonly field: string;
  readonly distinct: number;
}
/** Eligible candidates: two or more distinct values, so they can exercise ne/gt/lt. */
const cands = (...names: ReadonlyArray<string>): ReadonlyArray<Cand> => names.map(field => ({ field, distinct: 2 }));
/** A candidate holding ONE value across the resource — it cannot discriminate, so it is not eligible. */
const singleValued = (field: string): Cand => ({ field, distinct: 1 });
const fieldOf = (c: Cand): string => c.field;
const eligible = (c: Cand): boolean => c.distinct >= 2;

describe('parseFieldOverrides', () => {
  it('reads a comma-separated string and an array the same way', () => {
    expect(parseFieldOverrides('Office.FeedTypes, Member.MemberStatus').entries.map(e => e.spec)).toEqual([
      'Office.FeedTypes',
      'Member.MemberStatus'
    ]);
    expect(parseFieldOverrides(['Office.FeedTypes', 'Member.MemberStatus']).entries.map(e => e.spec)).toEqual([
      'Office.FeedTypes',
      'Member.MemberStatus'
    ]);
  });

  it('splits an entry into resource and field', () => {
    const [entry] = parseFieldOverrides(['Office.FeedTypes']).entries;
    expect(entry).toMatchObject({ resource: 'Office', field: 'FeedTypes', spec: 'Office.FeedTypes' });
  });

  it('drops blanks instead of producing empty overrides', () => {
    expect(parseFieldOverrides(' , ,').entries).toEqual([]);
    expect(parseFieldOverrides(undefined)).toBe(NO_FIELD_OVERRIDES);
  });

  describe('the resource is required, because an override is binding', () => {
    // A bare field name applies to every resource carrying that field. Under the old re-ordering semantics
    // that was harmless. Now that an override REPLACES selection, one bare entry would pin several resources
    // at once and a failure on any of them would trace back to an entry meant for one. So it is rejected
    // rather than guessed at — and collected, so the run can say what it ignored.
    it('rejects a bare field name and reports it as malformed', () => {
      const parsed = parseFieldOverrides(['Office.FeedTypes', 'SyndicateTo']);
      expect(parsed.entries.map(e => e.spec)).toEqual(['Office.FeedTypes']);
      expect(parsed.malformed).toEqual(['SyndicateTo']);
    });

    it('rejects a leading or trailing dot rather than reading it as a bare field', () => {
      // Inventing an empty resource would make the override match nothing while looking applied.
      expect(parseFieldOverrides(['.FeedTypes']).entries).toEqual([]);
      expect(parseFieldOverrides(['.FeedTypes']).malformed).toEqual(['.FeedTypes']);
      expect(parseFieldOverrides(['FeedTypes.']).entries).toEqual([]);
      expect(parseFieldOverrides(['FeedTypes.']).malformed).toEqual(['FeedTypes.']);
    });

    it('rejects more than one dot, which names no single resource and field', () => {
      expect(parseFieldOverrides(['A.B.C']).entries).toEqual([]);
      expect(parseFieldOverrides(['A.B.C']).malformed).toEqual(['A.B.C']);
    });

    it('collapses a case-variant duplicate to the first spelling, since it is one request', () => {
      // Found by adversarial review 2026-10-16. Matching is case-insensitive, so `overrideFor` resolved both
      // spellings to the same candidate and only the first could ever be reported as applied - leaving the
      // second permanently "unmatched", which told the operator their entry landed nowhere when it in fact
      // described the pin that happened.
      const parsed = parseFieldOverrides(['Office.FeedTypes', 'office.feedtypes']);
      expect(parsed.entries.map(e => e.spec)).toEqual(['Office.FeedTypes']);
      expect(parsed.malformed).toEqual([]);
      const summary = summarizeFieldOverrides(parsed, [['Office.FeedTypes']]);
      expect(summary.applied).toEqual(['Office.FeedTypes']);
      expect(summary).not.toHaveProperty('unmatched');
    });

    it('keeps two genuinely different fields that merely share a resource', () => {
      const parsed = parseFieldOverrides(['Office.FeedTypes', 'Office.SyndicateTo']);
      expect(parsed.entries.map(e => e.spec)).toEqual(['Office.FeedTypes', 'Office.SyndicateTo']);
    });

    it('keeps the same field name on two different resources', () => {
      const parsed = parseFieldOverrides(['Office.FeedTypes', 'Member.FeedTypes']);
      expect(parsed.entries.map(e => e.spec)).toEqual(['Office.FeedTypes', 'Member.FeedTypes']);
    });

    it('never throws on a malformed entry — a bad override degrades to automatic selection', () => {
      // Failing the run would punish a typo with a lost certification attempt. The entry is ignored and named.
      expect(() => parseFieldOverrides(['!!!', 'Office.FeedTypes'])).not.toThrow();
      expect(parseFieldOverrides(['!!!', 'Office.FeedTypes']).entries.map(e => e.spec)).toEqual(['Office.FeedTypes']);
    });
  });
});

describe('overrideFor', () => {
  it('matches case-insensitively, because providers spell fields as their metadata does', () => {
    const o = parseFieldOverrides(['office.feedtypes']);
    expect(overrideFor(o, 'Office', 'FeedTypes')?.spec).toBe('office.feedtypes');
  });

  it('does not apply a resource-scoped entry to another resource', () => {
    const o = parseFieldOverrides(['Office.FeedTypes']);
    expect(overrideFor(o, 'Member', 'FeedTypes')).toBeUndefined();
  });
});

describe('applyFieldOverrides replaces a slot rather than re-ordering it', () => {
  it('pins the named candidate and drops the rest, so the ladder has nothing to fall through to', () => {
    // This is the whole behavior change. Under 0.11.0 this returned all three with FeedTypes first, and a
    // server that would not filter on FeedTypes quietly certified on SyndicateTo instead.
    const ranked = cands('SyndicateTo', 'FeedTypes', 'OfficeStatus');
    const out = applyFieldOverrides(ranked, parseFieldOverrides(['Office.FeedTypes']), 'Office', fieldOf, eligible);
    expect(out.map(fieldOf)).toEqual(['FeedTypes']);
  });

  it('keeps every named candidate, in the order they were written rather than by rank', () => {
    const ranked = cands('A', 'B', 'C');
    const out = applyFieldOverrides(ranked, parseFieldOverrides(['Office.C', 'Office.B']), 'Office', fieldOf, eligible);
    expect(out.map(fieldOf)).toEqual(['C', 'B']);
  });

  describe('an override that matched nothing leaves its slot automatic', () => {
    // The "a typo costs you that one override and nothing else" promise. Pinning to an empty set would fail
    // a test the server would have passed, which is a worse outcome than ignoring the entry.
    it('returns the full ranked list when the named field is absent from the resource', () => {
      const ranked = cands('SyndicateTo', 'FeedTypes');
      const out = applyFieldOverrides(ranked, parseFieldOverrides(['Office.NotAField']), 'Office', fieldOf, eligible);
      expect(out.map(fieldOf)).toEqual(['SyndicateTo', 'FeedTypes']);
    });

    it('returns the full ranked list when the named field belongs to another resource', () => {
      const ranked = cands('SyndicateTo', 'FeedTypes');
      const out = applyFieldOverrides(ranked, parseFieldOverrides(['Member.FeedTypes']), 'Office', fieldOf, eligible);
      expect(out.map(fieldOf)).toEqual(['SyndicateTo', 'FeedTypes']);
      expect(out).toHaveLength(ranked.length);
    });
  });

  it('is a no-op with no overrides, and returns the same array identity', () => {
    const ranked = cands('SyndicateTo', 'FeedTypes');
    expect(applyFieldOverrides(ranked, NO_FIELD_OVERRIDES, 'Office', fieldOf, eligible)).toBe(ranked);
  });

  it('is a no-op on an empty candidate list', () => {
    const empty = cands();
    expect(applyFieldOverrides(empty, parseFieldOverrides(['Office.FeedTypes']), 'Office', fieldOf, eligible)).toBe(empty);
  });

  it('is a no-op when every entry was malformed, since none of them became an override', () => {
    const ranked = cands('SyndicateTo', 'FeedTypes');
    expect(applyFieldOverrides(ranked, parseFieldOverrides(['SyndicateTo']), 'Office', fieldOf, eligible)).toBe(ranked);
  });
});

describe('matchedOverrides', () => {
  it('reports only the overrides that matched a real candidate', () => {
    const ranked = cands('SyndicateTo', 'FeedTypes');
    const o = parseFieldOverrides(['Office.FeedTypes', 'Office.NotAField']);
    // An override naming a field the resource does not carry had no effect, so it must not be
    // reported as though the run honored it.
    expect(matchedOverrides(ranked, o, 'Office', fieldOf, eligible)).toEqual(['Office.FeedTypes']);
  });

  it('deduplicates and reports the spec exactly as written', () => {
    const ranked = cands('FeedTypes', 'FeedTypes');
    expect(matchedOverrides(ranked, parseFieldOverrides(['office.feedtypes']), 'Office', fieldOf, eligible)).toEqual(['office.feedtypes']);
  });

  it('is empty when nothing was requested', () => {
    expect(matchedOverrides(cands('FeedTypes'), NO_FIELD_OVERRIDES, 'Office', fieldOf, eligible)).toEqual([]);
  });
});

describe('summarizeFieldOverrides', () => {
  it('separates what was requested from what took effect', () => {
    const o = parseFieldOverrides(['Office.FeedTypes', 'Member.MemberStatus']);
    const summary = summarizeFieldOverrides(o, [['Member.MemberStatus'], []]);
    expect(summary.requested).toEqual(['Office.FeedTypes', 'Member.MemberStatus']);
    expect(summary.applied).toEqual(['Member.MemberStatus']);
    expect(summary.unmatched).toEqual(['Office.FeedTypes']);
  });

  it('reports an override that matched nothing as unmatched, never as applied', () => {
    // The real case, 2026-10-03: `Office.FeedTypes` is a Collection(enum) field that carried no sampled
    // value, so it never became a candidate and the run was NOT overridden. A report that echoed the request
    // would have been indistinguishable from an overridden one — which is what this asserts against.
    const o = parseFieldOverrides(['Office.FeedTypes']);
    const summary = summarizeFieldOverrides(o, [[], [], [], []]);
    expect(summary.applied).toEqual([]);
    expect(summary.unmatched).toEqual(['Office.FeedTypes']);
  });

  it('omits unmatched entirely when every override landed', () => {
    const o = parseFieldOverrides(['Office.SyndicateTo']);
    const summary = summarizeFieldOverrides(o, [['Office.SyndicateTo']]);
    expect(summary.applied).toEqual(['Office.SyndicateTo']);
    expect(summary).not.toHaveProperty('unmatched');
  });

  it('deduplicates the applied set rather than trusting its input', () => {
    const o = parseFieldOverrides(['Office.SyndicateTo']);
    const summary = summarizeFieldOverrides(o, [['Office.SyndicateTo'], ['Office.SyndicateTo'], []]);
    expect(summary.applied).toEqual(['Office.SyndicateTo']);
  });

  describe('malformed is reported separately from unmatched', () => {
    // Two different operator mistakes wanting two different corrections: "you wrote this wrong" versus
    // "this resolved to nothing on your server". Collapsing them into one list hides which one happened.
    it('names entries that were never well-formed, and keeps the three outcome lists disjoint', () => {
      const o = parseFieldOverrides(['Office.FeedTypes', 'SyndicateTo', 'A.B.C']);
      const summary = summarizeFieldOverrides(o, [['Office.FeedTypes']]);
      expect(summary.applied).toEqual(['Office.FeedTypes']);
      expect(summary.malformed).toEqual(['SyndicateTo', 'A.B.C']);
      // A malformed entry is NOT also unmatched. Counting it twice would overstate how much the run
      // was asked to do and understate why it was not done.
      expect(summary).not.toHaveProperty('unmatched');
    });

    it('omits malformed entirely when every entry was well-formed', () => {
      const summary = summarizeFieldOverrides(parseFieldOverrides(['Office.FeedTypes']), [['Office.FeedTypes']]);
      expect(summary).not.toHaveProperty('malformed');
    });

    it('counts a malformed entry as REQUESTED, so a bare-only list is not mistaken for no overrides', () => {
      // The regression this guards, found by adversarial review 2026-10-16. `reports.ts` emits the
      // fieldOverrides key only when `requested` is non-empty, so excluding malformed entries from
      // `requested` made a run whose every entry was a bare field name byte-indistinguishable from a run
      // with no overrides at all. The typo vanished instead of being reported, and a bare name is the
      // single most likely migration mistake from 0.11.0.
      const summary = summarizeFieldOverrides(parseFieldOverrides(['SyndicateTo']), [[]]);
      expect(summary.requested).toEqual(['SyndicateTo']);
      expect(summary.applied).toEqual([]);
      expect(summary.malformed).toEqual(['SyndicateTo']);
      expect(summary).not.toHaveProperty('unmatched');
    });

    it('puts every typed entry in requested, well-formed and malformed alike', () => {
      const summary = summarizeFieldOverrides(parseFieldOverrides(['Office.FeedTypes', 'SyndicateTo']), [[]]);
      expect(summary.requested).toEqual(['Office.FeedTypes', 'SyndicateTo']);
      expect(summary.unmatched).toEqual(['Office.FeedTypes']);
      expect(summary.malformed).toEqual(['SyndicateTo']);
    });

    it('still reports nothing requested when the input was only blanks', () => {
      const summary = summarizeFieldOverrides(parseFieldOverrides(' , ,'), [[]]);
      expect(summary.requested).toEqual([]);
      expect(summary).not.toHaveProperty('malformed');
    });
  });
});

describe('an override cannot pin a field that cannot discriminate', () => {
  // The false-pass direction, found by adversarial review 2026-10-03 and the reason the eligibility predicate
  // is a REQUIRED parameter. `ne`/`gt`/`lt` over a field holding one value across a complete resource return
  // nothing, and an empty result there is scored a determinate PASS that is NOT retryable — so pinning such a
  // field would certify the operator without ever exercising it. Because `coreOptions.fieldOverrides` comes
  // from the provider-authored config, that would let the certified party convert a failure into a pass.
  //
  // Scope: this is a SCALAR-operator guard. It is NOT about `all()` over an empty collection, which Core
  // 2.1.0 (:107) defines as vacuously true — that is conformant behavior, not a hole to close.
  const ranked: ReadonlyArray<Cand> = [{ field: 'OfficeStatus', distinct: 3 }, singleValued('LocalStatus')];

  it('leaves the slot automatic rather than pinning a single-valued field', () => {
    const out = applyFieldOverrides(ranked, parseFieldOverrides(['Office.LocalStatus']), 'Office', fieldOf, eligible);
    expect(out.map(fieldOf)).toEqual(['OfficeStatus', 'LocalStatus']);
  });

  it('does not report a refused override as applied', () => {
    // Reporting it would claim the run was overridden in a way it was not, and would hide the refusal from
    // the operator who asked for it.
    expect(matchedOverrides(ranked, parseFieldOverrides(['Office.LocalStatus']), 'Office', fieldOf, eligible)).toEqual([]);
  });

  it('still pins a named field that CAN discriminate', () => {
    const out = applyFieldOverrides(ranked, parseFieldOverrides(['Office.OfficeStatus']), 'Office', fieldOf, eligible);
    expect(out.map(fieldOf)).toEqual(['OfficeStatus']);
    expect(matchedOverrides(ranked, parseFieldOverrides(['Office.OfficeStatus']), 'Office', fieldOf, eligible)).toEqual([
      'Office.OfficeStatus'
    ]);
  });

  it('pins only the eligible one when several are named', () => {
    const mixed: ReadonlyArray<Cand> = [{ field: 'A', distinct: 4 }, singleValued('B'), { field: 'C', distinct: 2 }];
    const out = applyFieldOverrides(mixed, parseFieldOverrides(['Office.B', 'Office.C']), 'Office', fieldOf, eligible);
    expect(out.map(fieldOf)).toEqual(['C']);
  });
});

describe('replacement is scoped to the named field\u2019s GROUP, not the whole candidate list', () => {
  // The defect this guards, found by adversarial review 2026-10-16 and reproduced end to end. The enum
  // candidate lists are built once per CARDINALITY pool (single vs multi), but a scenario draws from one
  // REPRESENTATION - scenarioTargetsRep narrows the list afterwards, and the Lookup Resource scenario reads
  // it as a per-representation presence inventory. A representation-blind replacement therefore let an
  // override on a Collection(Edm.String) field DELETE the provider's Collection(Edm.EnumType) field, and the
  // enum-typed scenarios then found nothing to query and SKIPPED - reporting "no field of this scenario's
  // representation supports this operator on this server" with ZERO requests issued, on a provider that
  // carries such a field. A skip is neither a pass nor a fail, so a required FAILURE became a pass.
  //
  // selectEnumCandidates already refuses to CAP these lists for exactly this crowd-out reason. Replacement
  // had to learn the same rule.
  interface RepCand {
    readonly field: string;
    readonly distinct: number;
    readonly rep: string;
  }
  const repFieldOf = (c: RepCand): string => c.field;
  const repEligible = (c: RepCand): boolean => c.distinct >= 2;
  const repOf = (c: RepCand): string => c.rep;

  /** One multi-valued pool as sampling builds it: three representations in one list. */
  const multiPool: ReadonlyArray<RepCand> = [
    { field: 'Flooring', distinct: 4, rep: 'COLLECTION_ENUM' },
    { field: 'AssociationAmenities', distinct: 5, rep: 'COLLECTION_STRING' },
    { field: 'LocalFlags', distinct: 3, rep: 'FLAGS_ENUM' }
  ];

  const pin = (specs: ReadonlyArray<string>) =>
    applyFieldOverrides(multiPool, parseFieldOverrides(specs), 'Property', repFieldOf, repEligible, repOf);

  it('leaves the other representations in the pool, so their scenarios still have a field to query', () => {
    const out = pin(['Property.AssociationAmenities']);
    expect(out.map(repFieldOf)).toEqual(['Flooring', 'AssociationAmenities', 'LocalFlags']);
  });

  it('still replaces within the named representation, which is the pinning that was asked for', () => {
    const twoStrings: ReadonlyArray<RepCand> = [
      { field: 'AssociationAmenities', distinct: 5, rep: 'COLLECTION_STRING' },
      { field: 'OtherAmenities', distinct: 4, rep: 'COLLECTION_STRING' },
      { field: 'Flooring', distinct: 4, rep: 'COLLECTION_ENUM' }
    ];
    const out = applyFieldOverrides(
      twoStrings,
      parseFieldOverrides(['Property.OtherAmenities']),
      'Property',
      repFieldOf,
      repEligible,
      repOf
    );
    // OtherAmenities displaces its same-representation sibling and nothing else.
    expect(out.map(repFieldOf)).toEqual(['OtherAmenities', 'Flooring']);
  });

  it('pins each representation independently when two are named', () => {
    const out = pin(['Property.AssociationAmenities', 'Property.Flooring']);
    expect(out.map(repFieldOf)).toEqual(['Flooring', 'AssociationAmenities', 'LocalFlags']);
  });

  it('keeps an untouched group where the ranking put it rather than reshuffling the pool', () => {
    const out = pin(['Property.LocalFlags']);
    expect(out.map(repFieldOf)).toEqual(['Flooring', 'AssociationAmenities', 'LocalFlags']);
  });

  it('leaves the whole pool alone when the named field is ineligible, not just its own group', () => {
    const sparse: ReadonlyArray<RepCand> = [
      { field: 'Flooring', distinct: 4, rep: 'COLLECTION_ENUM' },
      { field: 'AssociationAmenities', distinct: 1, rep: 'COLLECTION_STRING' }
    ];
    const out = applyFieldOverrides(
      sparse,
      parseFieldOverrides(['Property.AssociationAmenities']),
      'Property',
      repFieldOf,
      repEligible,
      repOf
    );
    expect(out.map(repFieldOf)).toEqual(['Flooring', 'AssociationAmenities']);
  });

  it('treats the list as ONE group when no grouping is given, which is the scalar case', () => {
    // selectScalarCandidates passes a list that is already one data type, so the whole list is the unit.
    const ranked = cands('SyndicateTo', 'FeedTypes', 'OfficeStatus');
    const out = applyFieldOverrides(ranked, parseFieldOverrides(['Office.FeedTypes']), 'Office', fieldOf, eligible);
    expect(out.map(fieldOf)).toEqual(['FeedTypes']);
  });

  it('orders several pinned candidates in one group by spec order, not pool order', () => {
    const threeStrings: ReadonlyArray<RepCand> = [
      { field: 'A', distinct: 2, rep: 'COLLECTION_STRING' },
      { field: 'B', distinct: 2, rep: 'COLLECTION_STRING' },
      { field: 'Flooring', distinct: 4, rep: 'COLLECTION_ENUM' }
    ];
    const out = applyFieldOverrides(
      threeStrings,
      parseFieldOverrides(['Property.B', 'Property.A']),
      'Property',
      repFieldOf,
      repEligible,
      repOf
    );
    expect(out.map(repFieldOf)).toEqual(['B', 'A', 'Flooring']);
  });
});
