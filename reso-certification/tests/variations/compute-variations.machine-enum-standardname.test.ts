/**
 * Golden-master coverage — machine-based enum + RESO.OData.Metadata.StandardName annotation.
 *
 * Anonymized subset (generic enum type + a handful of Heating values) reproducing the
 * machine-enum / StandardName edge case seen on a real machine-based provider. No code fix
 * landed historically — it was resolved operationally by advising such providers to change
 * the annotation or move to the Lookup Resource — so this pins CURRENT legacy behavior.
 *
 * Legacy behavior (the bug): for an Edm.Int* enum carrying StandardName annotations, the
 * check evaluates BOTH the machine value (legacyODataValue) AND a human-friendly lookupValue
 * derived from the annotation → both substring-match → duplicate false negatives.
 *
 * The /compute fix (type-aware annotation handling) drops the annotation-derived forms
 * for Int* types → only the machine forms remain (5 → 3). Its counterpart test will assert
 * the fixed outcome once /compute exists.
 *
 * Oracle: legacy `computeVariations` (src/legacy).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations, MATCHING_STRATEGIES } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const SN = 'RESO.OData.Metadata.StandardName';
const TYPE = 'PropertyHeatingMachineEnum';
const FIELD = { resourceName: 'Property', fieldName: 'Heating', type: TYPE };
const LOOKUPS = [
  { lookupName: TYPE, lookupValue: 'Wall', type: 'Edm.Int64' }, // machine-only false negative (no annotation)
  { lookupName: TYPE, lookupValue: 'HotWaterRecircPump', type: 'Edm.Int64', annotations: [{ term: SN, value: 'Hot Water Recirc Pump' }] }, // double-flag
  { lookupName: TYPE, lookupValue: 'OtherSeeRemarks', type: 'Edm.Int64', annotations: [{ term: SN, value: 'Other – See Remarks' }] }, // double-flag, multi-suggestion
  { lookupName: TYPE, lookupValue: 'Baseboard', type: 'Edm.Int64' }, // control: clean machine value
];

type Lookup = { lookupValue?: string; legacyODataValue?: string; suggestions: Array<{ suggestedLookupValue?: string; suggestedLegacyODataValue?: string; strategy: string }> };

describe('computeVariations: machine-based enum + StandardName annotation (legacy double-flag)', () => {
  it('flags BOTH the machine value AND the StandardName-derived form — the bug /compute will fix', async () => {
    const { variations } = (await computeVariations({
      metadataReportJson: { fields: [FIELD], lookups: LOOKUPS },
      version: '2.0',
      fuzziness: 0.25,
    })) as { variations: { lookups: Lookup[] } };

    const byValue = Object.fromEntries(variations.lookups.map((l) => [l.legacyODataValue ?? l.lookupValue, l] as const));
    const targets = (l: Lookup) => l.suggestions.map((s) => s.suggestedLegacyODataValue ?? s.suggestedLookupValue);

    expect(variations.lookups).toHaveLength(5);

    // machine-value forms (kept under the /compute fix)
    expect(targets(byValue['Wall'])).toContain('WallFurnace');
    expect(targets(byValue['HotWaterRecircPump'])).toContain('HotWater');
    expect(targets(byValue['OtherSeeRemarks'])).toEqual(expect.arrayContaining(['Other', 'SeeRemarks']));

    // StandardName-derived forms (DROPPED under the /compute fix)
    expect(targets(byValue['Hot Water Recirc Pump'])).toContain('Hot Water');
    expect(targets(byValue['Other – See Remarks'])).toEqual(expect.arrayContaining(['Other', 'See Remarks']));

    // control: clean machine value not flagged
    expect(byValue['Baseboard']).toBeUndefined();

    // every flag is a machine Substring match (no store, no human strategies)
    for (const l of variations.lookups) {
      for (const s of l.suggestions) expect(s.strategy).toBe(MATCHING_STRATEGIES.SUBSTRING);
    }
  });
});
