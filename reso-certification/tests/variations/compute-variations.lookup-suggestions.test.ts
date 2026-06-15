/**
 * Golden-master coverage — lookup-value suggestion blend + StandardName-annotation suppression.
 *
 * Ported faithfully from cert-utils `test/variations.js` (the 43-test mocha oracle),
 * de-randomized and converted mocha→vitest. Exercises:
 *   - CMP-3: a store suggestion surfaces when the value is present and not yet canonical
 *   - the "already present" suppression via a valid StandardName annotation
 *     (hasStandardLookupMapping / isSuggestedLookupTargetPresent)
 *   - an invalid (typo'd) annotation does NOT suppress
 *
 * Oracle: legacy `computeVariations` (src/legacy). A failure here = either a real
 * bug or a drift between cert-utils and the reso-tools legacy copy.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations, MATCHING_STRATEGIES } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const FUZZINESS = 0.25;
const DD_1_7 = '1.7';
const SN = 'RESO.OData.Metadata.StandardName';

// Human suggestion: local "Active UC" → canonical "Active Under Contract".
const SUGGESTION = {
  Property: {
    StandardStatus: {
      'Active UC': {
        suggestions: [
          { suggestedResourceName: 'Property', suggestedFieldName: 'StandardStatus', suggestedLookupValue: 'Active Under Contract' },
        ],
      },
    },
  },
};

const reportWith = (annotations?: ReadonlyArray<{ term: string; value: string }>) => ({
  fields: [{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'StandardStatusLookups' }],
  lookups: [
    {
      lookupName: 'StandardStatusLookups',
      type: 'Edm.String',
      lookupValue: 'Active UC',
      ...(annotations ? { annotations } : {}),
    },
  ],
});

const run = (metadataReportJson: unknown) =>
  computeVariations({ metadataReportJson, fuzziness: FUZZINESS, version: DD_1_7, suggestionsMap: SUGGESTION });

describe('computeVariations: lookup-value suggestion + annotation suppression', () => {
  it('flags the lookup-value suggestion when the value is present and not yet canonical', async () => {
    const { variations: { resources = [], fields = [], lookups = [] } } = await run(reportWith());
    expect(resources).toHaveLength(0);
    expect(fields).toHaveLength(0);
    expect(lookups).toHaveLength(1);

    const [v] = lookups;
    expect(v.resourceName).toBe('Property');
    expect(v.fieldName).toBe('StandardStatus');
    expect(v.lookupValue).toBe('Active UC');
    expect(v.legacyODataValue).toBeFalsy();

    const [s] = v.suggestions;
    expect(s.suggestedResourceName).toBe('Property');
    expect(s.suggestedFieldName).toBe('StandardStatus');
    expect(s.suggestedLookupValue).toBe('Active Under Contract');
    expect(s.suggestedLegacyODataValue).toBeFalsy();
    expect(s.strategy).toBe(MATCHING_STRATEGIES.EXTERNAL_SUGGESTION);
  });

  it('suppresses when the provider declares the canonical via a valid StandardName annotation', async () => {
    const { variations: { lookups = [] } } = await run(reportWith([{ term: SN, value: 'Active Under Contract' }]));
    expect(lookups).toHaveLength(0);
  });

  it('still flags when the StandardName annotation is a typo (invalid mapping)', async () => {
    const { variations: { lookups = [] } } = await run(reportWith([{ term: SN, value: 'Active Under Contrct' }]));
    expect(lookups).toHaveLength(1);
    expect(lookups[0].lookupValue).toBe('Active UC');
  });
});
