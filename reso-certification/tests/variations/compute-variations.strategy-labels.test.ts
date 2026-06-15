/**
 * Golden-master coverage — Fast Track / Admin strategy labels.
 *
 * Ported from cert-utils `test/variations.js` (de-randomized, mocha→vitest).
 * Exercises classifySuggestionStrategy: isFastTrack → FAST_TRACK, isAdminReview
 * → ADMIN_REVIEW, applied at resource / field / lookup levels, and that exactly
 * one collection is flagged per case.
 *
 * Oracle: legacy `computeVariations` (src/legacy).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations, MATCHING_STRATEGIES } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const FUZZINESS = 0.25;
const DD_1_7 = '1.7';

type Flag = Record<string, boolean>;
const FT: Flag = { isFastTrack: true };
const ADMIN: Flag = { isAdminReview: true };

// Resource-level: local "Offices" → canonical "Office".
const officesReport = { fields: [{ resourceName: 'Offices', fieldName: 'ModificationTimestamp', type: 'Edm.DateTimeOffset' }], lookups: [] };
const officesSugg = (flag: Flag) => ({ Offices: { suggestions: [{ suggestedResourceName: 'Office', ...flag }] } });

// Field-level: local "ListPrices" → canonical "ListPrice".
const listPricesReport = { fields: [{ resourceName: 'Property', fieldName: 'ListPrices', type: 'Edm.Decimal' }], lookups: [] };
const listPricesSugg = (flag: Flag) => ({ Property: { ListPrices: { suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ListPrice', ...flag }] } } });

// Lookup-level: local "Ranch/1 Story" → canonical "Ranch".
const archReport = {
  fields: [{ resourceName: 'Property', fieldName: 'ArchitecturalStyle', type: 'ArchitecturalStyles' }],
  lookups: [{ lookupName: 'ArchitecturalStyles', lookupValue: 'Ranch/1 Story', type: 'Edm.String' }],
};
const archSugg = (flag: Flag) => ({
  Property: { ArchitecturalStyle: { 'Ranch/1 Story': { suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ArchitecturalStyle', suggestedLookupValue: 'Ranch', ...flag }] } } },
});

const cases = [
  { name: 'Fast Track resource', report: officesReport, sugg: officesSugg(FT), col: 'resources', strategy: MATCHING_STRATEGIES.FAST_TRACK },
  { name: 'Fast Track field', report: listPricesReport, sugg: listPricesSugg(FT), col: 'fields', strategy: MATCHING_STRATEGIES.FAST_TRACK },
  { name: 'Fast Track lookup', report: archReport, sugg: archSugg(FT), col: 'lookups', strategy: MATCHING_STRATEGIES.FAST_TRACK },
  { name: 'Admin resource', report: officesReport, sugg: officesSugg(ADMIN), col: 'resources', strategy: MATCHING_STRATEGIES.ADMIN_REVIEW },
  { name: 'Admin field', report: listPricesReport, sugg: listPricesSugg(ADMIN), col: 'fields', strategy: MATCHING_STRATEGIES.ADMIN_REVIEW },
  { name: 'Admin lookup', report: archReport, sugg: archSugg(ADMIN), col: 'lookups', strategy: MATCHING_STRATEGIES.ADMIN_REVIEW },
];

describe('computeVariations: FT/Admin strategy labels', () => {
  it.each(cases)('flags $name with the right strategy and nothing else', async ({ report, sugg, col, strategy }) => {
    const { variations } = (await computeVariations({
      metadataReportJson: report,
      fuzziness: FUZZINESS,
      version: DD_1_7,
      suggestionsMap: sugg,
    })) as { variations: Record<string, Array<{ suggestions: Array<{ strategy: string }> }>> };

    for (const c of ['resources', 'fields', 'lookups']) {
      if (c === col) {
        expect(variations[c]).toHaveLength(1);
        expect(variations[c][0].suggestions[0].strategy).toBe(strategy);
      } else {
        expect(variations[c]).toHaveLength(0);
      }
    }
  });
});
