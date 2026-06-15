/**
 * Golden-master coverage — legacyODataValue suggestions + machine-match bounds.
 *
 * Ported from cert-utils `test/variations.js` (de-randomized, mocha→vitest):
 *   - legacyODataValue (Edm.Int64 wire form) suggestion flagging
 *   - not-flag when a sibling standard lookup value is already present (any-one)
 *   - machine matching respects the minimum matching length (no spurious flags)
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

const run = (metadataReportJson: unknown, suggestionsMap?: unknown) =>
  computeVariations({ metadataReportJson, fuzziness: FUZZINESS, version: DD_1_7, suggestionsMap }) as Promise<{
    variations: { resources: unknown[]; fields: unknown[]; lookups: Array<Record<string, unknown> & { suggestions: Array<Record<string, unknown>> }> };
  }>;

describe('computeVariations: legacyODataValue suggestions + match bounds', () => {
  it('flags a legacyODataValue suggestion (Edm.Int64 wire form)', async () => {
    const suggestionsMap = {
      Property: { ExteriorFeatures: { Grill: { suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ExteriorFeatures', suggestedLegacyODataValue: 'GasGrill' }] } } },
    };
    const metadataReportJson = {
      fields: [{ resourceName: 'Property', fieldName: 'ExteriorFeatures', type: 'ExteriorFeaturesLookups.ExteriorFeatures' }],
      lookups: [{ lookupName: 'ExteriorFeaturesLookups.ExteriorFeatures', type: 'Edm.Int64', lookupValue: 'Grill' }],
    };

    const { variations: { resources, fields, lookups } } = await run(metadataReportJson, suggestionsMap);
    expect(resources).toHaveLength(0);
    expect(fields).toHaveLength(0);
    expect(lookups).toHaveLength(1);

    const [v] = lookups;
    expect(v.resourceName).toBe('Property');
    expect(v.fieldName).toBe('ExteriorFeatures');
    expect(v.legacyODataValue).toBe('Grill');
    expect(v.lookupValue).toBeFalsy();

    const [s] = v.suggestions;
    expect(s.suggestedLegacyODataValue).toBe('GasGrill');
    expect(s.suggestedLookupValue).toBeFalsy();
    expect(s.strategy).toBe(MATCHING_STRATEGIES.EXTERNAL_SUGGESTION);
  });

  it('does not flag when a sibling standard lookup value is already present (any-one)', async () => {
    const suggestionsMap = {
      Property: { ExteriorFeatures: { Grill: { suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ExteriorFeatures', suggestedLookupValue: 'Gas Grill' }] } } },
    };
    const metadataReportJson = {
      fields: [{ resourceName: 'Property', fieldName: 'ExteriorFeatures', type: 'ExteriorFeatures' }],
      lookups: [
        { lookupName: 'ExteriorFeatures', type: 'Edm.String', lookupValue: 'Gas Grill' },
        { lookupName: 'ExteriorFeatures', type: 'Edm.String', lookupValue: 'Grill' },
      ],
    };
    const { variations: { lookups } } = await run(metadataReportJson, suggestionsMap);
    expect(lookups).toHaveLength(0);
  });

  it('does not machine-match below the minimum matching length', async () => {
    const metadataReportJson = {
      fields: [{ resourceName: 'Property', fieldName: 'StateOrProvince', type: 'StateOrProvince' }],
      lookups: [{ lookupName: 'StateOrProvince', type: 'Edm.String', lookupValue: 'California' }],
    };
    const { variations: { resources, fields, lookups } } = await run(metadataReportJson);
    expect(resources).toHaveLength(0);
    expect(fields).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });
});
