/**
 * Substring arm — needle-guard (acceptance / regression net for the backend matcher rebuild).
 *
 * The substring arm of the matching cascade is bidirectional — it fires when either name contains
 * the other — but each direction's inner length guard tests the NEEDLE (the value passed to
 * `.includes()`, i.e. the CONTAINED name after normalization), NOT the haystack. Threshold:
 * normalized length > 3.
 *
 * The highest-risk reimplementation mistake is guarding on the haystack (the containing name)
 * instead of the needle: that would let a long provider value spuriously match a tiny standard token
 * it happens to contain. These tests pin the correct semantics against the current source
 * (src/legacy @ abf74c1) so the rebuild can't drift — re-point the import at the reimplemented
 * matcher and they must still pass.
 *
 * All cases are behaviors the current source already satisfies (green here, green after the rebuild)
 * — nothing here is an `it.fails`.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const FUZZINESS = 0.25;
const DD_1_7 = '1.7';

type Suggestion = { to?: string; strat?: string };

// Feed one provider legacyODataValue P for Property.<fieldName> (Edm.Int64 → machine cascade) and
// return the flattened {to, strat} suggestions at the legacy OData level.
const suggestionsFor = async (fieldName: string, P: string): Promise<ReadonlyArray<Suggestion>> => {
  const metadataReportJson = {
    fields: [{ resourceName: 'Property', fieldName, type: 'L' }],
    lookups: [{ lookupName: 'L', type: 'Edm.Int64', lookupValue: P }],
  };
  const { variations } = (await computeVariations({ metadataReportJson, fuzziness: FUZZINESS, version: DD_1_7 })) as {
    variations: { lookups: Array<{ suggestions: Array<{ suggestedLegacyODataValue?: string; strategy?: string }> }> };
  };
  return (variations.lookups ?? []).flatMap((l) =>
    (l.suggestions ?? []).map((s) => ({ to: s.suggestedLegacyODataValue, strat: s.strategy })),
  );
};

describe('substring arm — needle-guard (the guard tests the needle, not the haystack)', () => {
  // Provider CONTAINS the standard token; needle "Balcony" (normLen 7 > 3) passes the guard.
  // Edit distance(normalized) = 6 ≫ budget floor(0.25·13)=3, so the substring arm is the ONLY catch:
  // proves the substring arm fires independently of the edit-distance arm and reports the Substring strategy.
  it('substring-only match fires and reports "Substring" (edit distance would miss): "BalconyAccess" → "Balcony"', async () => {
    const s = await suggestionsFor('ExteriorFeatures', 'BalconyAccess');
    expect(s).toContainEqual({ to: 'Balcony', strat: 'Substring' });
  });

  // Discriminator pair, same lookup (ConstructionMaterials), same "<candidate>Home" shape — the only
  // variable is the candidate (needle) length crossing the >3 boundary. Both providers are length ≥7,
  // so a (wrong) haystack-length guard would match BOTH; the correct needle guard splits them.

  // needle "Log" (normLen 3) is NOT > 3 → blocked; nothing else catches it either → no suggestion.
  it('haystack-vs-needle: "LogHome" does NOT match "Log" (needle normLen 3 ≤ 3 → guard blocks)', async () => {
    const s = await suggestionsFor('ConstructionMaterials', 'LogHome');
    expect(s.find((x) => x.to === 'Log')).toBeUndefined();
    expect(s).toEqual([]); // and the short needle isn't rescued by any other arm
  });

  // needle "Stone" (normLen 5) IS > 3 → substring fires.
  it('haystack-vs-needle: "StoneHome" matches "Stone" via Substring (needle normLen 5 > 3 → guard fires)', async () => {
    const s = await suggestionsFor('ConstructionMaterials', 'StoneHome');
    expect(s).toContainEqual({ to: 'Stone', strat: 'Substring' });
  });
});
