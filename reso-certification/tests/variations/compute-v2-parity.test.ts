/**
 * /compute (v2) parity + Int* fix.
 *
 * Faithful mode (`applyIntEnumFix: false`) reproduces legacy `computeVariations` on every case
 * here. Three intentional divergences from legacy are deliberately NOT covered here — faithful
 * mode cannot reproduce legacy on inputs that hit them, so each has its own acceptance test:
 *   - the legacy OData edit-distance budget now uses Math.floor, uniform across levels, not
 *     legacy's Math.round — see compute-v2-legacy-odata-floor.test.ts;
 *   - an exact match now filters out the element's other (substring/edit-distance) suggestions
 *     rather than ordering the exact to the head — see compute-v2-exact-match-filters-fuzzy.test.ts
 *     (the former 'lowercase resource' and 'noisy field' cases moved there);
 *   - the ddWikiUrl for a curated legacy-form (suggestedLegacyODataValue) suggestion now resolves
 *     the display lookup value (URL-encoded) instead of legacy's wire form — the #212 fix — see
 *     compute-v2-legacy-form-ddwikiurl.test.ts (the former 'legacyOData suggestion (Edm.Int64)'
 *     case moved there).
 * Fixed mode (default) also applies the type-aware Int* gate: machine enums drop the
 * StandardName-derived forms (5 → 3 on the machine-enum subset).
 *
 * All inputs are anonymized synthetic — no vendor reports or identifiers.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations } = require(resolve(legacyRoot, 'lib/variations/index.js'));
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const FUZZINESS = 0.25;
const SN = 'RESO.OData.Metadata.StandardName';
const HEAT = 'PropertyHeatingMachineEnum';

const heatingReport = {
  fields: [{ resourceName: 'Property', fieldName: 'Heating', type: HEAT }],
  lookups: [
    { lookupName: HEAT, lookupValue: 'Wall', type: 'Edm.Int64' },
    { lookupName: HEAT, lookupValue: 'HotWaterRecircPump', type: 'Edm.Int64', annotations: [{ term: SN, value: 'Hot Water Recirc Pump' }] },
    { lookupName: HEAT, lookupValue: 'OtherSeeRemarks', type: 'Edm.Int64', annotations: [{ term: SN, value: 'Other – See Remarks' }] },
    { lookupName: HEAT, lookupValue: 'Baseboard', type: 'Edm.Int64' },
  ],
};

const cases = [
  // 'lowercase resource' (property) and 'noisy field' (list_price) moved to
  // compute-v2-exact-match-filters-fuzzy.test.ts — they hit the exact-match-wins divergence.
  { name: 'field machine match (substring)', version: '1.7', report: { fields: [{ resourceName: 'Property', fieldName: 'APIModificationTimestamp' }] } },
  { name: 'close-match misspelling', version: '1.7', report: { fields: [{ resourceName: 'Property', fieldName: 'ListPrce' }] } },
  {
    name: 'lookup suggestion (Edm.String)', version: '1.7',
    report: { fields: [{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'StandardStatusLookups' }], lookups: [{ lookupName: 'StandardStatusLookups', type: 'Edm.String', lookupValue: 'Active UC' }] },
    suggestionsMap: { Property: { StandardStatus: { 'Active UC': { suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'StandardStatus', suggestedLookupValue: 'Active Under Contract' }] } } } },
  },
  { name: 'resource ignore', version: '1.7', report: { fields: [{ resourceName: 'property', fieldName: 'ListPrice' }] }, suggestionsMap: { property: { ignored: true } } },
  { name: 'field ignore (hierarchical)', version: '1.7', report: { fields: [{ resourceName: 'Property', fieldName: 'list_price' }] }, suggestionsMap: { Property: { ignored: true } } },
  { name: 'reference self-check (empty expected)', version: '2.0', report: () => getReferenceMetadata('2.0') },
  { name: 'machine-enum subset (Int*/StandardName)', version: '2.0', report: heatingReport },
];

describe('computeVariationsV2: faithful mode reproduces legacy exactly', () => {
  it.each(cases)('$name', async ({ report, suggestionsMap, version }) => {
    const metadataReportJson = typeof report === 'function' ? report() : report;
    const legacy = await computeVariations({ metadataReportJson, suggestionsMap: suggestionsMap ?? {}, version, fuzziness: FUZZINESS });
    const v2 = computeVariationsV2({ metadataReportJson, referenceMetadata: getReferenceMetadata(version), suggestionsMap: suggestionsMap ?? {}, version, fuzziness: FUZZINESS, applyIntEnumFix: false, applyVersionBucketing: false });
    expect(v2.variations).toEqual(legacy.variations);
  });
});

describe('computeVariationsV2: Int* fix mode', () => {
  it('drops StandardName-derived forms for machine enums (5 → 3)', () => {
    const v2 = computeVariationsV2({ metadataReportJson: heatingReport, referenceMetadata: getReferenceMetadata('2.0'), version: '2.0', fuzziness: FUZZINESS, applyIntEnumFix: true });
    const lookups = v2.variations.lookups as Array<{ lookupValue?: string; legacyODataValue?: string }>;
    // only the 3 machine-value forms remain
    expect(lookups).toHaveLength(3);
    const keys = lookups.map((l) => l.legacyODataValue ?? l.lookupValue).sort();
    expect(keys).toEqual(['HotWaterRecircPump', 'OtherSeeRemarks', 'Wall']);
    // no StandardName-derived human-friendly forms
    expect(lookups.some((l) => l.lookupValue === 'Hot Water Recirc Pump')).toBe(false);
  });
});
