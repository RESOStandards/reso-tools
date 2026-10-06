/**
 * computeVariationsV2 — `strategy` records where a mapping CAME FROM, and review state never rewrites it.
 *
 * The model (Josh, 2026-10-03):
 *   - `strategy` is "what the tool used to check their results, and it never changes". Its values are
 *     `Substring` and `Edit Distance` (the tool's own matching), `Admin Review` (an admin put the mapping in),
 *     and `Fast Track` (it came from Fast Track). All four are legitimate strategies: the enum is correct.
 *   - `isAdminReview` is "the output of the admin review process" — an admin AUTHORED this mapping. It does
 *     not mean a review is open, and it does not mean the entry was submitted for Fast Track.
 *   - An entry that merely has an admin review OPEN on it still has whatever strategy produced its mapping.
 *
 * The defect these tests pin: a stored entry that happens to be under admin review was being mixed back in
 * and superseding what the tool produced. Any suggestion present diverts the field down the store-suggestion
 * path and returns before the tool's matcher runs, so the match's real strategy is never computed and the
 * flag-derived label is all that survives. The same diversion drops the DD URL, because the matcher builds it
 * from the entry's own `resourceName` while the store path uses `suggestedResourceName`, which an in-review
 * payload does not carry.
 *
 * Synthetic inputs — no vendor reports or identifiers.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

type Json = Record<string, unknown>;

const DD = '2.1';

/** `Buyer` is a standard DD 2.1 Property field, so `BuyerAgentKeyNumeric` substring-matches it. The provider
 *  does NOT declare `Buyer` itself, which is what leaves the variation reportable. */
const report: Json = {
  fields: [{ resourceName: 'Property', fieldName: 'BuyerAgentKeyNumeric', type: 'Edm.Int64' }],
  lookups: []
};

const fieldSuggestions = (suggestions: ReadonlyArray<Json>): Json => ({
  Property: { BuyerAgentKeyNumeric: { suggestions } }
});

interface Emitted {
  readonly strategy?: string;
  readonly ddWikiUrl?: string | null;
  readonly suggestedFieldName?: string;
}

const run = (suggestionsMap: Json | undefined): ReadonlyArray<Emitted> => {
  const { variations } = computeVariationsV2({
    metadataReportJson: report,
    referenceMetadata: getReferenceMetadata(DD),
    ...(suggestionsMap ? { suggestionsMap } : {}),
    version: DD,
    fuzziness: 0.25,
    applyVersionBucketing: false
  }) as unknown as { variations: { fields?: Json[] } };

  return (variations.fields ?? []).flatMap(f =>
    ((f.suggestions as unknown as Json[]) ?? []).map(s => ({
      strategy: s.strategy as string | undefined,
      ddWikiUrl: s.ddWikiUrl as string | null | undefined,
      suggestedFieldName: s.suggestedFieldName as string | undefined
    }))
  );
};

const BUYER_URL = 'https://dd.reso.org/DD2.1/Property/Buyer/';

describe('the tool-derived strategy is what the tool computed', () => {
  it('matches BuyerAgentKeyNumeric to Buyer as a Substring match, with a DD URL', () => {
    // The baseline the other cases are measured against: no store suggestion at all.
    const hits = run(undefined).filter(h => h.suggestedFieldName === 'Buyer');
    expect(hits).toHaveLength(1);
    expect(hits[0].strategy).toBe('Substring');
    expect(hits[0].ddWikiUrl).toBe(BUYER_URL);
  });
});

describe('a strategy the producer already recorded is never overwritten', () => {
  // `strategy` records where a mapping came from and never changes once set. So when the store returns an
  // entry that carries its own strategy, that value wins — even when review flags are also present, and even
  // though a review being open is exactly the situation that used to relabel it.
  const withStrategy = fieldSuggestions([
    {
      suggestedResourceName: 'Property',
      suggestedFieldName: 'Buyer',
      strategy: 'Substring',
      isAdminReview: true,
      reviewStartedOn: '2026-09-28T17:28:32.383Z'
    }
  ]);

  it('keeps Substring rather than relabeling from the review flag', () => {
    const hit = run(withStrategy).find(h => h.suggestedFieldName === 'Buyer');
    expect(hit?.strategy).toBe('Substring');
  });

  it('keeps the DD URL', () => {
    const hit = run(withStrategy).find(h => h.suggestedFieldName === 'Buyer');
    expect(hit?.ddWikiUrl).toBe(BUYER_URL);
  });

  it('holds regardless of where `...rest` sits in the emitted literal', () => {
    // The precedence used to be an accident of object-literal ordering: `...rest` spread after `strategy:`,
    // so an incoming value survived only because of where that line sat. This pins the rule itself.
    const fastTrackFlagged = fieldSuggestions([
      { suggestedResourceName: 'Property', suggestedFieldName: 'Buyer', strategy: 'Edit Distance', isFastTrack: true }
    ]);
    const hit = run(fastTrackFlagged).find(h => h.suggestedFieldName === 'Buyer');
    expect(hit?.strategy).toBe('Edit Distance');
  });
});

describe('what the client cannot repair on its own', () => {
  // The reported defect needs a service-side fix, and this test marks the boundary so the gap is not mistaken
  // for a client bug. When the store returns an in-review entry it emits NO `strategy` key at all, so the
  // producer's record is already gone by the time the client sees it. The client then has only the flags, and
  // classifying from them is correct behavior for a genuinely admin-authored mapping. What is wrong is that
  // the service sets the authorship flag from review STATE, which no computed property here can undo.
  it('falls back to the flag when the store sent no strategy, which is why the service must send one', () => {
    const noStrategy = fieldSuggestions([
      { suggestedFieldName: 'Buyer', isAdminReview: true, reviewStartedOn: '2026-09-28T17:28:32.383Z' }
    ]);
    const hit = run(noStrategy).find(h => h.suggestedFieldName === 'Buyer');
    expect(hit?.strategy).toBe('Admin Review');
  });
});

describe('an admin-AUTHORED mapping keeps Admin Review as its strategy', () => {
  // The legacy golden-master semantics, which must not regress: when an admin put the mapping in, `Admin
  // Review` IS the correct strategy. Note there is no open review here — this is the review's OUTPUT.
  it('reports Admin Review for a mapping the tool could not have derived', () => {
    const authored = fieldSuggestions([{ suggestedResourceName: 'Property', suggestedFieldName: 'ListPrice', isAdminReview: true }]);
    const hit = run(authored).find(h => h.suggestedFieldName === 'ListPrice');
    expect(hit?.strategy).toBe('Admin Review');
  });

  it('reports Fast Track for a fast-tracked mapping', () => {
    const fastTracked = fieldSuggestions([{ suggestedResourceName: 'Property', suggestedFieldName: 'ListPrice', isFastTrack: true }]);
    const hit = run(fastTracked).find(h => h.suggestedFieldName === 'ListPrice');
    expect(hit?.strategy).toBe('Fast Track');
  });
});
