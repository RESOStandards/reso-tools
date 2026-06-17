/**
 * Legacy OData edit-distance — basis + rounding divergence (predict-then-verify for the backend
 * matcher rebuild).
 *
 * In computeVariations the edit-distance arm runs at four levels (resource, field, lookup value,
 * legacy OData value). Three of them measure distance on NORMALIZED names with a Math.floor budget;
 * the legacy OData level alone (src/legacy/lib/variations/index.js) measures on RAW names with a
 * Math.round budget. The reimplemented matcher conforms the legacy OData level to the other three:
 * normalized inputs + Math.floor.
 *
 * The two `it.fails` cases assert the CORRECTED behavior and therefore fail against the current
 * source by design — each failure IS the divergence, verified empirically against real DD 1.7 values
 * (Property.ExteriorFeatures, target "Balcony"):
 *   - BASIS:    raw distance lets a separator-padded value slip the matcher (anti-evasion gap).
 *   - ROUNDING: Math.round over-admits a d=2 near-match that Math.floor rejects.
 * When the reimplemented matcher lands, re-point the import at it and drop `.fails` — both must pass.
 *
 * The two controls confirm the divergence is localized to the edit-distance arm (a clean near-match
 * still matches; a beyond-budget value still doesn't).
 *
 * Oracle: legacy computeVariations (src/legacy @ abf74c1).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const FUZZINESS = 0.25;
const DD_1_7 = '1.7';

// Feed one provider legacyODataValue P for Property.ExteriorFeatures (Edm.Int64 → machine cascade,
// no suggestionsMap), and report whether the matcher suggests `target` at the legacy OData level.
const suggestsLegacyOData = async (P: string, target: string): Promise<boolean> => {
  const metadataReportJson = {
    fields: [{ resourceName: 'Property', fieldName: 'ExteriorFeatures', type: 'EF' }],
    lookups: [{ lookupName: 'EF', type: 'Edm.Int64', lookupValue: P }],
  };
  const { variations } = (await computeVariations({ metadataReportJson, fuzziness: FUZZINESS, version: DD_1_7 })) as {
    variations: { lookups: Array<{ suggestions: Array<{ suggestedLegacyODataValue?: string }> }> };
  };
  return (variations.lookups ?? []).some((l) => (l.suggestions ?? []).some((s) => s.suggestedLegacyODataValue === target));
};

describe('legacy OData edit-distance — assert corrected behavior (it.fails vs current source; drop .fails once the matcher is reimplemented)', () => {
  // "Bal-cor-y" = "Balcony" with two separators + one substitution.
  // raw d=3 > budget 2 (current source misses); normalized d=1 ≤ 2 (fix catches). rawLen 9 → floor=round=2 isolates the basis.
  it.fails('basis: padded "Bal-cor-y" should suggest "Balcony" — the current source misses it via raw distance', async () => {
    expect(await suggestsLegacyOData('Bal-cor-y', 'Balcony')).toBe(true);
  });

  // "Balcoz" alphanumeric (raw==normalized) at d=2, rawLen 6 → floor(1.5)=1 vs round(1.5)=2.
  // current source over-admits (d=2 ≤ round 2); fix rejects (d=2 > floor 1).
  it.fails('rounding: "Balcoz" (d=2, rawLen 6) should NOT suggest "Balcony" — the current source over-admits via round', async () => {
    expect(await suggestsLegacyOData('Balcoz', 'Balcony')).toBe(false);
  });
});

describe('legacy OData edit-distance — controls (pass vs current source; divergence localized to the edit-distance arm)', () => {
  it('clean alphanumeric near-match "Balcuny" (d=1) suggests "Balcony"', async () => {
    expect(await suggestsLegacyOData('Balcuny', 'Balcony')).toBe(true);
  });

  it('"Balzzz" (d=4, beyond both budgets) suggests nothing', async () => {
    expect(await suggestsLegacyOData('Balzzz', 'Balcony')).toBe(false);
  });
});
