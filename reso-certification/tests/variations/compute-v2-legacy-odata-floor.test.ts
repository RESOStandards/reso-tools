/**
 * computeVariationsV2 — the legacy OData edit-distance budget must use Math.floor, uniform
 * with the resource/field/lookup levels — not Math.round.
 *
 * The current port carries the old Math.round at the legacy OData level (a preserved legacy
 * quirk): round(0.25 * 6) = 2 admits a d=2 near-match at raw length 6, where floor(1.5) = 1
 * rejects it. The rounding case below asserts the corrected floor behavior and is RED against
 * the current port; it flips green once the round→floor change lands. The distance basis is
 * already normalized in the port, so the padded control passes today.
 *
 * Real DD 1.7 values (Property.ExteriorFeatures, target "Balcony").
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const FUZZINESS = 0.25;
const VERSION = '1.7';

// Feed one provider legacyODataValue P for Property.ExteriorFeatures (Edm.Int64) and report
// whether the matcher suggests `target` at the legacy OData level. Tolerant of both observed
// v2 output shapes (flat suggestion objects vs. nested `.suggestions`).
const suggestsLegacyOData = (P: string, target: string): boolean => {
  const metadataReportJson = {
    fields: [{ resourceName: 'Property', fieldName: 'ExteriorFeatures', type: 'EF' }],
    lookups: [{ lookupName: 'EF', type: 'Edm.Int64', lookupValue: P }],
  };
  const { variations } = computeVariationsV2({
    metadataReportJson,
    referenceMetadata: getReferenceMetadata(VERSION),
    version: VERSION,
    fuzziness: FUZZINESS,
    applyVersionBucketing: false,
  }) as { variations: { lookups?: Array<Record<string, unknown>> } };
  const lookups = variations.lookups ?? [];
  return lookups.some(
    (l) =>
      l.suggestedLegacyODataValue === target ||
      ((l.suggestions as Array<Record<string, unknown>>) ?? []).some((s) => s.suggestedLegacyODataValue === target),
  );
};

describe('computeVariationsV2: legacy OData edit-distance uses Math.floor', () => {
  // RED against the current port (Math.round): round(0.25*6)=2 admits d=2; floor(1.5)=1 rejects it.
  it('"Balcoz" (d=2, raw length 6) does NOT suggest "Balcony"', () => {
    expect(suggestsLegacyOData('Balcoz', 'Balcony')).toBe(false);
  });

  // controls — green now and after the fix:
  it('"Balcuny" (d=1) suggests "Balcony"', () => {
    expect(suggestsLegacyOData('Balcuny', 'Balcony')).toBe(true);
  });
  it('"Balzzz" (d=4, beyond budget) suggests nothing', () => {
    expect(suggestsLegacyOData('Balzzz', 'Balcony')).toBe(false);
  });
  // basis already normalized in the port — confirms the normalized-input half is in place:
  it('padded "Bal-cor-y" suggests "Balcony" (normalized distance d=1)', () => {
    expect(suggestsLegacyOData('Bal-cor-y', 'Balcony')).toBe(true);
  });
});
