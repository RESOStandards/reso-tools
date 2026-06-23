/**
 * computeVariationsV2 — #212: ddWikiUrl for a legacy-form (suggestedLegacyODataValue) store suggestion.
 *
 * A DD lookup-value URL uses the StandardLookupValue (display name), not the LegacyODataValue (wire
 * form). For a curated legacy-form suggestion the ddWikiUrl must resolve the display value via the
 * standard map — not emit the wire form verbatim. The machine legacy path already did this; the
 * store/sMap path passed the wire value as `lookupValue`, so the URL carried it raw. Regression for #212.
 *
 * Real DD 1.7 lookup (Property/ExteriorFeatures: GasGrill ⇄ "Gas Grill"); inputs synthetic.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

type Json = Record<string, unknown>;

const legacyFormSuggestions = (report: Json, suggestionsMap: Json, version = '1.7'): Json[] => {
  const { variations } = computeVariationsV2({
    metadataReportJson: report,
    referenceMetadata: getReferenceMetadata(version),
    suggestionsMap,
    version,
    fuzziness: 0.25,
    applyVersionBucketing: false,
  }) as { variations: { lookups?: Array<Json & { suggestions?: Json[] }> } };
  return (variations.lookups ?? []).flatMap((l) => (l.suggestions as Json[]) ?? []);
};

describe('computeVariationsV2: legacy-form store-suggestion ddWikiUrl (#212)', () => {
  it('resolves the ddWikiUrl to the display lookup value, not the wire (legacy OData) form', () => {
    const suggestions = legacyFormSuggestions(
      {
        fields: [{ resourceName: 'Property', fieldName: 'ExteriorFeatures', type: 'ExteriorFeaturesLookups.ExteriorFeatures' }],
        lookups: [{ lookupName: 'ExteriorFeaturesLookups.ExteriorFeatures', type: 'Edm.Int64', lookupValue: 'Grill' }],
      },
      {
        Property: {
          ExteriorFeatures: {
            Grill: { suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ExteriorFeatures', suggestedLegacyODataValue: 'GasGrill' }] },
          },
        },
      },
    );
    expect(suggestions).toHaveLength(1);
    const url = suggestions[0].ddWikiUrl as string;
    expect(url).toBeTruthy();
    // The URL must carry the display value "Gas Grill" (URL-encoded), never the wire form "GasGrill".
    expect(url).not.toContain('GasGrill');
    expect(url.includes('Gas%20Grill') || url.includes('Gas Grill')).toBe(true);
  });
});
