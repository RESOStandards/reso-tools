import { describe, expect, it } from 'vitest';
import {
  NO_FIELD_PREFERENCES,
  applyFieldPreferences,
  matchedPreferences,
  parseFieldPreferences,
  preferenceFor,
  summarizeFieldPreferences
} from '../../src/web-api-core/field-preference.js';

/** A stand-in for either candidate shape — both expose `field` and a distinct-value count. */
interface Cand {
  readonly field: string;
  readonly distinct: number;
}
/** Discriminating candidates: two or more distinct values, so they can exercise ne/gt/lt. */
const cands = (...names: ReadonlyArray<string>): ReadonlyArray<Cand> => names.map(field => ({ field, distinct: 2 }));
/** A candidate holding ONE value across the resource — it cannot discriminate. */
const singleValued = (field: string): Cand => ({ field, distinct: 1 });
const fieldOf = (c: Cand): string => c.field;
const discriminates = (c: Cand): boolean => c.distinct >= 2;

describe('parseFieldPreferences', () => {
  it('reads a comma-separated string and an array the same way', () => {
    expect(parseFieldPreferences('Office.FeedTypes, SyndicateTo').entries.map(e => e.spec)).toEqual(['Office.FeedTypes', 'SyndicateTo']);
    expect(parseFieldPreferences(['Office.FeedTypes', 'SyndicateTo']).entries.map(e => e.spec)).toEqual([
      'Office.FeedTypes',
      'SyndicateTo'
    ]);
  });

  it('splits a qualified entry into resource and field, and leaves a bare entry unscoped', () => {
    const [qualified, bare] = parseFieldPreferences(['Office.FeedTypes', 'SyndicateTo']).entries;
    expect(qualified).toMatchObject({ resource: 'Office', field: 'FeedTypes' });
    expect(bare.resource).toBeUndefined();
    expect(bare.field).toBe('SyndicateTo');
  });

  it('drops blanks instead of producing empty preferences', () => {
    expect(parseFieldPreferences(' , ,').entries).toEqual([]);
    expect(parseFieldPreferences(undefined)).toBe(NO_FIELD_PREFERENCES);
  });

  it('treats a leading or trailing dot as a malformed entry and reads it as a bare field', () => {
    // Inventing an empty resource would make the preference match nothing and look applied.
    const leading = parseFieldPreferences(['.FeedTypes']).entries[0];
    expect(leading.resource).toBeUndefined();
    expect(leading.field).toBe('FeedTypes');
    const trailing = parseFieldPreferences(['FeedTypes.']).entries[0];
    expect(trailing.resource).toBeUndefined();
    expect(trailing.field).toBe('FeedTypes');
  });
});

describe('preferenceFor', () => {
  it('matches case-insensitively, because providers spell fields as their metadata does', () => {
    const p = parseFieldPreferences(['office.feedtypes']);
    expect(preferenceFor(p, 'Office', 'FeedTypes')?.spec).toBe('office.feedtypes');
  });

  it('prefers a qualified entry over a bare one for the same field', () => {
    const p = parseFieldPreferences(['FeedTypes', 'Office.FeedTypes']);
    expect(preferenceFor(p, 'Office', 'FeedTypes')?.spec).toBe('Office.FeedTypes');
    expect(preferenceFor(p, 'Member', 'FeedTypes')?.spec).toBe('FeedTypes');
  });

  it('does not apply a resource-scoped entry to another resource', () => {
    const p = parseFieldPreferences(['Office.FeedTypes']);
    expect(preferenceFor(p, 'Member', 'FeedTypes')).toBeUndefined();
  });
});

describe('applyFieldPreferences', () => {
  it('moves a preferred candidate to the front and leaves the rest in ranked order', () => {
    const ranked = cands('SyndicateTo', 'FeedTypes', 'OfficeStatus');
    const out = applyFieldPreferences(ranked, parseFieldPreferences(['Office.FeedTypes']), 'Office', fieldOf, discriminates);
    expect(out.map(fieldOf)).toEqual(['FeedTypes', 'SyndicateTo', 'OfficeStatus']);
  });

  it('orders multiple preferred candidates by the order they were written, not by rank', () => {
    const ranked = cands('A', 'B', 'C');
    const out = applyFieldPreferences(ranked, parseFieldPreferences(['C', 'B']), 'Office', fieldOf, discriminates);
    expect(out.map(fieldOf)).toEqual(['C', 'B', 'A']);
  });

  it('never adds or removes a candidate — a preference only re-orders', () => {
    const ranked = cands('SyndicateTo', 'FeedTypes');
    // NotAField does not exist on the resource; Member.FeedTypes is scoped elsewhere.
    const out = applyFieldPreferences(ranked, parseFieldPreferences(['NotAField', 'Member.FeedTypes']), 'Office', fieldOf, discriminates);
    expect(out.map(fieldOf)).toEqual(['SyndicateTo', 'FeedTypes']);
    expect(out).toHaveLength(ranked.length);
  });

  it('is a no-op with no preferences, and returns the same array identity', () => {
    const ranked = cands('SyndicateTo', 'FeedTypes');
    expect(applyFieldPreferences(ranked, NO_FIELD_PREFERENCES, 'Office', fieldOf, discriminates)).toBe(ranked);
  });

  it('is a no-op on an empty candidate list', () => {
    const empty = cands();
    expect(applyFieldPreferences(empty, parseFieldPreferences(['FeedTypes']), 'Office', fieldOf, discriminates)).toBe(empty);
  });
});

describe('matchedPreferences', () => {
  it('reports only the preferences that matched a real candidate', () => {
    const ranked = cands('SyndicateTo', 'FeedTypes');
    const p = parseFieldPreferences(['Office.FeedTypes', 'NotAField']);
    // A preference naming a field the resource does not carry had no effect, so it must not be
    // reported as though the run honored it.
    expect(matchedPreferences(ranked, p, 'Office', fieldOf, discriminates)).toEqual(['Office.FeedTypes']);
  });

  it('deduplicates and reports the spec exactly as written', () => {
    const ranked = cands('FeedTypes', 'FeedTypes');
    expect(matchedPreferences(ranked, parseFieldPreferences(['feedtypes']), 'Office', fieldOf, discriminates)).toEqual(['feedtypes']);
  });

  it('is empty when nothing was requested', () => {
    expect(matchedPreferences(cands('FeedTypes'), NO_FIELD_PREFERENCES, 'Office', fieldOf, discriminates)).toEqual([]);
  });
});

describe('summarizeFieldPreferences', () => {
  it('separates what was requested from what took effect', () => {
    const p = parseFieldPreferences(['Office.FeedTypes', 'SyndicateTo']);
    const summary = summarizeFieldPreferences(p, [['SyndicateTo'], []]);
    expect(summary.requested).toEqual(['Office.FeedTypes', 'SyndicateTo']);
    expect(summary.applied).toEqual(['SyndicateTo']);
    expect(summary.unmatched).toEqual(['Office.FeedTypes']);
  });

  it('reports a preference that matched nothing as unmatched, never as applied', () => {
    // The real case, 2026-10-03: `Office.FeedTypes` is a Collection(enum) field that carried no sampled
    // value, so it never became a candidate and the run was NOT steered. A report that echoed the request
    // would have been indistinguishable from a steered one — which is what this asserts against.
    const p = parseFieldPreferences(['Office.FeedTypes']);
    const summary = summarizeFieldPreferences(p, [[], [], [], []]);
    expect(summary.applied).toEqual([]);
    expect(summary.unmatched).toEqual(['Office.FeedTypes']);
  });

  it('omits unmatched entirely when every preference landed', () => {
    const p = parseFieldPreferences(['SyndicateTo']);
    const summary = summarizeFieldPreferences(p, [['SyndicateTo']]);
    expect(summary.applied).toEqual(['SyndicateTo']);
    expect(summary).not.toHaveProperty('unmatched');
  });

  it('deduplicates across resources, because a bare preference can land on several', () => {
    const p = parseFieldPreferences(['SyndicateTo']);
    const summary = summarizeFieldPreferences(p, [['SyndicateTo'], ['SyndicateTo'], []]);
    expect(summary.applied).toEqual(['SyndicateTo']);
  });
});

describe('a preference cannot promote a field that cannot discriminate', () => {
  // The false-pass direction, found by adversarial review 2026-10-03 and the reason `canDiscriminate` is a
  // REQUIRED parameter. `ne`/`gt`/`lt` over a field holding one value across a complete resource return
  // nothing, and an empty result there is scored a determinate PASS that is NOT retryable — so promoting such
  // a field ends the candidate ladder before the field that would have exercised the operator is queried.
  // Because `coreOptions.preferFields` comes from the provider-authored config, that would let the certified
  // party convert a genuine failure into a pass.
  const ranked: ReadonlyArray<Cand> = [{ field: 'OfficeStatus', distinct: 3 }, singleValued('LocalStatus')];

  it('leaves a single-valued preferred field where the ranking put it', () => {
    const out = applyFieldPreferences(ranked, parseFieldPreferences(['Office.LocalStatus']), 'Office', fieldOf, discriminates);
    expect(out.map(fieldOf)).toEqual(['OfficeStatus', 'LocalStatus']);
  });

  it('does not report a refused preference as applied', () => {
    // Reporting it would claim the run was steered in a way it was not, and would hide the refusal from the
    // operator who asked for it.
    expect(matchedPreferences(ranked, parseFieldPreferences(['Office.LocalStatus']), 'Office', fieldOf, discriminates)).toEqual([]);
  });

  it('still honors a preference for a field that CAN discriminate', () => {
    const out = applyFieldPreferences(ranked, parseFieldPreferences(['Office.OfficeStatus']), 'Office', fieldOf, discriminates);
    expect(out.map(fieldOf)).toEqual(['OfficeStatus', 'LocalStatus']);
    expect(matchedPreferences(ranked, parseFieldPreferences(['Office.OfficeStatus']), 'Office', fieldOf, discriminates)).toEqual([
      'Office.OfficeStatus'
    ]);
  });

  it('promotes only the discriminating one when several are preferred', () => {
    const mixed: ReadonlyArray<Cand> = [{ field: 'A', distinct: 4 }, singleValued('B'), { field: 'C', distinct: 2 }];
    const out = applyFieldPreferences(mixed, parseFieldPreferences(['B', 'C']), 'Office', fieldOf, discriminates);
    expect(out.map(fieldOf)).toEqual(['C', 'A', 'B']);
  });
});
