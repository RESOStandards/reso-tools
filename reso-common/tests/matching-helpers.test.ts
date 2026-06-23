import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FUZZINESS,
  MIN_MATCHING_LENGTH,
  CLOSE_MATCH_DISTANCE,
  MATCHING_STRATEGIES,
  normalizeDataElementName,
  classifySuggestionStrategy,
  getDDWikiUrl,
  prepareResults,
} from '../src/variations/matching-helpers.js';

describe('matching helpers', () => {
  it('constants + strategy labels', () => {
    expect(DEFAULT_FUZZINESS).toBe(0.25);
    expect(MIN_MATCHING_LENGTH).toBe(3);
    expect(CLOSE_MATCH_DISTANCE).toBe(1);
    expect(MATCHING_STRATEGIES.SUBSTRING).toBe('Substring');
    expect(MATCHING_STRATEGIES.EXTERNAL_SUGGESTION).toBe('Suggestion');
  });

  it('normalizeDataElementName lowercases + strips non-alphanumerics', () => {
    expect(normalizeDataElementName('List Price')).toBe('listprice');
    expect(normalizeDataElementName('Public_Sewer-2')).toBe('publicsewer2');
    expect(normalizeDataElementName('')).toBe('');
  });

  it('classifySuggestionStrategy maps provenance flags', () => {
    expect(classifySuggestionStrategy({ isAdminReview: true })).toBe('Admin Review');
    expect(classifySuggestionStrategy({ isFastTrack: true })).toBe('Fast Track');
    expect(classifySuggestionStrategy()).toBe('Suggestion');
  });

  it('getDDWikiUrl builds the dd.reso.org shapes (display value, URL-encoded)', () => {
    expect(getDDWikiUrl({ version: '2.1', resourceName: 'Property' })).toBe('https://dd.reso.org/DD2.1/Property/');
    expect(getDDWikiUrl({ version: '2.1', resourceName: 'Property', fieldName: 'ListPrice' })).toBe(
      'https://dd.reso.org/DD2.1/Property/ListPrice/',
    );
    expect(getDDWikiUrl({ version: '1.7', resourceName: 'Property', fieldName: 'ExteriorFeatures', lookupValue: 'Public Sewer' })).toBe(
      'https://dd.reso.org/DD1.7/lookups/ExteriorFeatures/Public%20Sewer/',
    );
    expect(getDDWikiUrl({})).toBeNull();

    // legacyODataValue resolves to the display lookup value via the standard map
    const smm = { Property: { ExteriorFeatures: { legacyODataValues: { GasGrill: { lookupValue: 'Gas Grill' } } } } };
    expect(
      getDDWikiUrl({ version: '1.7', standardMetadataMap: smm, resourceName: 'Property', fieldName: 'ExteriorFeatures', legacyODataValue: 'GasGrill' }),
    ).toBe('https://dd.reso.org/DD1.7/lookups/ExteriorFeatures/Gas%20Grill/');
  });

  it('prepareResults groups by level + collapses duplicate lookup suggestions', () => {
    const out = prepareResults({
      resources: [{ resourceName: 'Prop', suggestedResourceName: 'Property' }],
      fields: [{ resourceName: 'Property', fieldName: 'ListPrce', suggestedFieldName: 'ListPrice' }],
      legacyODataValues: [
        { resourceName: 'Property', fieldName: 'ExteriorFeatures', legacyODataValue: 'Grill', suggestedLegacyODataValue: 'GasGrill' },
        { resourceName: 'Property', fieldName: 'ExteriorFeatures', legacyODataValue: 'Grill', suggestedLegacyODataValue: 'GasGrill' },
      ],
    });
    expect(out.resources).toHaveLength(1);
    expect(out.fields).toHaveLength(1);
    expect(out.lookups).toHaveLength(1); // two identical legacyOData entries → one grouped lookup
  });
});
