/**
 * Parity: reso-common's variations matching helpers must be behavior-for-behavior equivalent to
 * the legacy originals they were lifted from (src/legacy/lib/variations/index.js). The matcher
 * port (to the backend) relies on these reproducing the legacy leaf behavior exactly; this test
 * pins them so the lift can't drift. The legacy copies ride along untouched until the legacy
 * matcher is deleted wholesale (cert-utils archives it).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  DEFAULT_FUZZINESS,
  MIN_MATCHING_LENGTH,
  CLOSE_MATCH_DISTANCE,
  MATCHING_STRATEGIES,
  normalizeDataElementName,
  classifySuggestionStrategy,
  getDDWikiUrl,
  prepareResults,
} from '@reso-standards/reso-common';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacy = require(resolve(import.meta.dirname, '../../src/legacy/lib/variations/index.js'));

describe('matching helpers parity — reso-common === legacy', () => {
  it('constants + strategies match', () => {
    expect(DEFAULT_FUZZINESS).toBe(legacy.DEFAULT_FUZZINESS);
    expect(MIN_MATCHING_LENGTH).toBe(legacy.MIN_MATCHING_LENGTH);
    expect(CLOSE_MATCH_DISTANCE).toBe(legacy.CLOSE_MATCH_DISTANCE);
    expect(MATCHING_STRATEGIES).toEqual(legacy.MATCHING_STRATEGIES);
  });

  it('normalizeDataElementName matches', () => {
    for (const name of ['List Price', 'list_price', 'ListPrice', 'Public Sewer', 'A-B_C', '123', '', 'X', '   '])
      expect(normalizeDataElementName(name)).toBe(legacy.normalizeDataElementName(name));
  });

  it('classifySuggestionStrategy matches', () => {
    for (const flags of [undefined, {}, { isAdminReview: true }, { isFastTrack: true }, { isAdminReview: true, isFastTrack: true }])
      expect(classifySuggestionStrategy(flags)).toBe(legacy.classifySuggestionStrategy(flags));
  });

  it('getDDWikiUrl matches across param shapes', () => {
    const smm = { Property: { ExteriorFeatures: { legacyODataValues: { GasGrill: { lookupValue: 'Gas Grill' } } } } };
    const same = (c: Parameters<typeof getDDWikiUrl>[0]) => expect(getDDWikiUrl(c)).toBe(legacy.getDDWikiUrl(c));
    same({});
    same({ version: '2.1', resourceName: 'Property' });
    same({ version: '2.1', resourceName: 'Property', fieldName: 'ListPrice' });
    same({ version: '1.7', resourceName: 'Property', fieldName: 'ExteriorFeatures', lookupValue: 'Public Sewer' });
    same({ version: '1.7', standardMetadataMap: smm, resourceName: 'Property', fieldName: 'ExteriorFeatures', legacyODataValue: 'GasGrill' });
  });

  it('prepareResults groups + dedupes identically', () => {
    const input = {
      resources: [{ resourceName: 'Prop', suggestedResourceName: 'Property', strategy: 'Substring' }],
      fields: [
        { resourceName: 'Property', fieldName: 'ListPrce', suggestedFieldName: 'ListPrice', strategy: 'Edit Distance' },
        { resourceName: 'Property', fieldName: 'ListPrce', suggestedFieldName: 'ListPrices', strategy: 'Edit Distance' },
      ],
      lookupValues: [{ resourceName: 'Property', fieldName: 'StandardStatus', lookupValue: 'Active UC', suggestedLookupValue: 'Active Under Contract' }],
      legacyODataValues: [
        { resourceName: 'Property', fieldName: 'ExteriorFeatures', legacyODataValue: 'Grill', suggestedLegacyODataValue: 'GasGrill' },
        { resourceName: 'Property', fieldName: 'ExteriorFeatures', legacyODataValue: 'Grill', suggestedLegacyODataValue: 'GasGrill' },
      ],
      expansions: [{ resourceName: 'Property', fieldName: 'Media' }],
      complexTypes: [],
    };
    expect(prepareResults(input)).toEqual(legacy.prepareResults(input));
  });
});
