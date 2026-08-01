import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

// The legacy variations modules are CommonJS, so require them via createRequire
// (same pattern as tests/metadata/dd-metadata-checks.test.ts).
const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);

// PORT-NOTE: In cert-utils these came from three places — computeVariations from
// the repo root index.js, {MATCHING_STRATEGIES, hasValidSearchInput} from
// lib/variations/index.js, getReferenceMetadata from lib/misc/index.js, and
// ANNOTATION_TERM_STANDARD_NAME from @reso/reso-certification-etl/lib/process-metadata.js.
// In reso-tools computeVariations/hasValidSearchInput/MATCHING_STRATEGIES all live
// in src/legacy/lib/variations/index.js (the root src/legacy/index.js merely
// re-exports computeVariations from there), getReferenceMetadata is re-exported
// from src/legacy/lib/misc/index.js, and ANNOTATION_TERM_STANDARD_NAME lives in
// src/etl/process-metadata.cjs.
const { computeVariations, hasValidSearchInput, MATCHING_STRATEGIES } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/variations/index.js')
);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/legacy/lib/misc/index.js'));
const { ANNOTATION_TERM_STANDARD_NAME } = require(resolve(import.meta.dirname, '../../src/etl/process-metadata.cjs'));

const getRandomNonAlphaNumericCharacter = (): string => {
  const chars = ['_', '&', '-', ' ', ', '];

  return chars[Math.floor(Math.random() * chars.length)];
};

const isEven = (n = 0): boolean => (parseInt(String(n)) ? n % 2 === 0 : false);

const intersperseNonAlphaNumericNoise = (value = ''): string => {
  let newValue = '';

  for (let i = 0; i < value.length; i++) {
    if (isEven(Math.floor(Math.random() * 100))) {
      newValue += value[i] + getRandomNonAlphaNumericCharacter();
    } else {
      newValue += value[i];
    }
  }

  return newValue;
};

const TEST_FUZZINESS = 0.25;
const DD_1_7 = '1.7';
const DD_2_0 = '2.0';
const DEFAULT_VERSION = DD_1_7;

describe('hasValidSearchInput', () => {
  it('rejects when both fields and lookups are empty', () => {
    expect(hasValidSearchInput({ fields: [], lookups: [] })).toBe(false);
  });

  it('rejects when fields is missing', () => {
    expect(hasValidSearchInput({ lookups: [{}] })).toBe(true); // lookups carries the call
    expect(hasValidSearchInput({})).toBe(false);
  });

  it('rejects when either argument is not an array', () => {
    expect(hasValidSearchInput({ fields: 'oops', lookups: [] })).toBe(false);
    expect(hasValidSearchInput({ fields: [], lookups: null })).toBe(false);
    expect(hasValidSearchInput({ fields: {}, lookups: [{}] })).toBe(false);
  });

  it('accepts when only fields are present (Lookup Resource pattern)', () => {
    // Lookup Resource servers expose enums at runtime, not in $metadata,
    // so the metadata report's static `lookups[]` is legitimately empty.
    expect(hasValidSearchInput({ fields: [{ resourceName: 'Property', fieldName: 'Fee2' }], lookups: [] })).toBe(true);
  });

  it('accepts when only lookups are present', () => {
    expect(hasValidSearchInput({ fields: [], lookups: [{ lookupName: 'X', lookupValue: 'Y' }] })).toBe(true);
  });

  it('accepts when both are present', () => {
    expect(hasValidSearchInput({ fields: [{}], lookups: [{}] })).toBe(true);
  });
});

describe('Variations Service reference metadata tests', () => {
  it('Should have required properties when the metadata report is empty', async () => {
    const metadataReportJson = {};

    const { description, version, generatedOn, fuzziness, variations } = await computeVariations({
      metadataReportJson,
      fuzziness: TEST_FUZZINESS,
      version: DEFAULT_VERSION
    });

    expect(description.length).not.toBe(0);
    expect(version.length).not.toBe(0);
    expect(generatedOn.length).not.toBe(0);

    // check that the variations object is present and has values
    expect(!!Object.keys(variations).length).toBe(true);

    const { resources, fields, lookups, expansions, complexTypes } = variations;

    expect(resources).toStrictEqual([]);
    expect(fields).toStrictEqual([]);
    expect(lookups).toStrictEqual([]);
    expect(expansions).toStrictEqual([]);
    expect(complexTypes).toStrictEqual([]);

    // check version and fuzziness
    expect(version).toBe(DEFAULT_VERSION);
    expect(fuzziness).toBe(TEST_FUZZINESS);
  });

  it(`Should have no variations flagged when using version ${DD_1_7} metadata`, async () => {
    const metadataReportJson = await getReferenceMetadata(DD_1_7);

    const { description, version, generatedOn, fuzziness, variations } = await computeVariations({
      metadataReportJson,
      fuzziness: TEST_FUZZINESS,
      version: DD_1_7
    });

    expect(description.length).not.toBe(0);
    expect(version.length).not.toBe(0);
    expect(generatedOn.length).not.toBe(0);

    // check that the variations object is present and has values
    expect(!!Object.keys(variations).length).toBe(true);

    const { resources, fields, lookups, expansions, complexTypes } = variations;

    expect(resources).toStrictEqual([]);
    expect(fields).toStrictEqual([]);
    expect(lookups).toStrictEqual([]);
    expect(expansions).toStrictEqual([]);
    expect(complexTypes).toStrictEqual([]);

    // check version and fuzziness
    expect(version).toBe(DD_1_7);
    expect(fuzziness).toBe(TEST_FUZZINESS);
  });

  it(`Should have no variations flagged when using version ${DD_1_7} metadata with 100% fuzziness`, async () => {
    const MAX_FUZZINESS = 1.0;
    const metadataReportJson = await getReferenceMetadata(DD_1_7);

    const { description, version, generatedOn, fuzziness, variations } = await computeVariations({
      metadataReportJson,
      fuzziness: 1.0,
      version: DD_1_7
    });

    expect(description.length).not.toBe(0);
    expect(version.length).not.toBe(0);
    expect(generatedOn.length).not.toBe(0);

    // check that the variations object is present and has values
    expect(!!Object.keys(variations).length).toBe(true);

    const { resources, fields, lookups, expansions, complexTypes } = variations;

    expect(resources).toStrictEqual([]);
    expect(fields).toStrictEqual([]);
    expect(lookups).toStrictEqual([]);
    expect(expansions).toStrictEqual([]);
    expect(complexTypes).toStrictEqual([]);

    expect(fuzziness).toBe(MAX_FUZZINESS);
  });

  it(`Should identify known ${DD_1_7} resources with lowercase and non-alphanumeric noise`, async () => {
    const metadataReportJson = await getReferenceMetadata(DD_1_7);

    const processedResources = new Set();

    for await (const { resourceName, fieldName } of Object.values(metadataReportJson.fields)) {
      if (!processedResources.has(resourceName)) {
        const testMetadataReportJson = {
          fields: [
            {
              resourceName: intersperseNonAlphaNumericNoise(resourceName?.toLowerCase()),
              fieldName
            }
          ]
        };

        const { variations } = await computeVariations({ metadataReportJson: testMetadataReportJson, version: DD_1_7 });

        expect(variations.resources.length).toBe(1);
        expect(variations.resourceName).toBe((testMetadataReportJson as { resourceName?: unknown }).resourceName);

        // the suggestions should have the resource name in them
        expect(variations.resources[0].suggestions.some((x: { suggestedResourceName?: string }) => x?.suggestedResourceName === resourceName)).toBe(true);

        processedResources.add(resourceName);
      }
    }
  });

  it(`Should identify known ${DD_1_7} fields when the variation is lowercase with non-alphanumeric noise`, async () => {
    const metadataReportJson = await getReferenceMetadata(DD_1_7);

    const testMetadataReportJson = Object.values(metadataReportJson?.fields ?? []).reduce(
      (acc, { resourceName, fieldName, isExpansion }) => {
        if (isExpansion) return acc;
        acc.fields.push({ resourceName, fieldName: intersperseNonAlphaNumericNoise(fieldName?.toLowerCase()) });
        return acc;
      },
      { fields: [] as Array<{ resourceName: unknown; fieldName: string }> }
    );

    const { variations = [] } = await computeVariations({ metadataReportJson: testMetadataReportJson, version: DD_1_7 });

    const { fields: metadataReportFields = [] } = metadataReportJson;
    const { fields: fieldVariations = [] } = variations;

    // items are concatenated for comparisons
    const metadataReportFieldsSet = new Set(
      metadataReportFields.flatMap(({ resourceName, fieldName, isExpansion = false }) => {
        if (isExpansion) return [];
        return `${resourceName}${fieldName}`;
      })
    );

    const unmatchedItems = fieldVariations.flatMap(({ resourceName, fieldName, suggestions = [] }) => {
      if (suggestions.some(({ suggestedFieldName }) => metadataReportFieldsSet.has(`${resourceName}${suggestedFieldName}`))) {
        return [];
      } else {
        return {
          resourceName,
          fieldName
        };
      }
    });

    expect(unmatchedItems?.length).toBe(0);

    const noExactMatches = fieldVariations.flatMap(({ resourceName, fieldName, suggestions = [] }) => {
      if (suggestions.some((x) => x?.exactMatch)) {
        return [];
      } else {
        return {
          resourceName,
          fieldName
        };
      }
    });

    expect(noExactMatches.length).toBe(0);
  });

  it(`Should have no variations flagged when using version ${DD_2_0} metadata`, async () => {
    const metadataReportJson = await getReferenceMetadata(DD_2_0);

    const { description, version, generatedOn, fuzziness, variations } = await computeVariations({
      metadataReportJson,
      fuzziness: TEST_FUZZINESS,
      version: DD_2_0
    });

    expect(description.length).not.toBe(0);
    expect(version.length).not.toBe(0);
    expect(generatedOn.length).not.toBe(0);

    // check that the variations object is present and has values
    expect(!!Object.keys(variations).length).toBe(true);

    const { resources, fields, lookups, expansions, complexTypes } = variations;

    expect(resources).toStrictEqual([]);
    expect(fields).toStrictEqual([]);
    expect(lookups).toStrictEqual([]);
    expect(expansions).toStrictEqual([]);
    expect(complexTypes).toStrictEqual([]);

    // check version and fuzziness
    expect(version).toBe(DD_2_0);
    expect(fuzziness).toBe(TEST_FUZZINESS);
  });

  it(`Should have no variations flagged when using version ${DD_2_0} metadata with 100% fuzziness`, async () => {
    const MAX_FUZZINESS = 1.0;
    const metadataReportJson = await getReferenceMetadata(DD_2_0);

    const { description, version, generatedOn, fuzziness, variations } = await computeVariations({
      metadataReportJson,
      fuzziness: MAX_FUZZINESS,
      version: DD_2_0
    });

    expect(description.length).not.toBe(0);
    expect(version.length).not.toBe(0);
    expect(generatedOn.length).not.toBe(0);

    // check that the variations object is present and has values
    expect(!!Object.keys(variations).length).toBe(true);

    const { resources, fields, lookups, expansions, complexTypes } = variations;

    expect(resources).toStrictEqual([]);
    expect(fields).toStrictEqual([]);
    expect(lookups).toStrictEqual([]);
    expect(expansions).toStrictEqual([]);
    expect(complexTypes).toStrictEqual([]);

    expect(fuzziness).toBe(MAX_FUZZINESS);
  });

  it(`Should identify known ${DD_2_0} resources when the variation is lowercase with non-alphanumeric noise`, async () => {
    const metadataReportJson = await getReferenceMetadata(DD_2_0);

    const processedResources = new Set();

    for await (const { resourceName, fieldName } of Object.values(metadataReportJson.fields)) {
      if (!processedResources.has(resourceName)) {
        const testMetadataReportJson = {
          fields: [
            {
              resourceName: intersperseNonAlphaNumericNoise(resourceName?.toLowerCase()),
              fieldName
            }
          ]
        };

        const { variations } = await computeVariations({ metadataReportJson: testMetadataReportJson, version: DD_2_0 });

        expect(variations.resources.length).toBe(1);
        expect(variations.resourceName).toBe((testMetadataReportJson as { resourceName?: unknown }).resourceName);

        expect(variations.resources[0].suggestions.some((x: { suggestedResourceName?: string }) => x?.suggestedResourceName === resourceName)).toBe(true);

        processedResources.add(resourceName);
      }
    }
  });

  it(`Should identify known ${DD_2_0} fields when the variation is lowercase with non-alphanumeric noise`, async () => {
    const metadataReportJson = await getReferenceMetadata(DD_2_0);

    const testMetadataReportJson = Object.values(metadataReportJson?.fields ?? []).reduce(
      (acc, { resourceName, fieldName, isExpansion }) => {
        if (isExpansion) return acc;

        acc.fields.push({ resourceName, fieldName: intersperseNonAlphaNumericNoise(fieldName?.toLowerCase()) });
        return acc;
      },
      { fields: [] as Array<{ resourceName: unknown; fieldName: string }> }
    );

    const { variations = [] } = await computeVariations({ metadataReportJson: testMetadataReportJson, version: DD_2_0 });

    const { fields: metadataReportFields = [] } = metadataReportJson;
    const { fields: fieldVariations = [] } = variations;

    // items are concatenated for comparisons
    const metadataReportFieldsSet = new Set(
      metadataReportFields.flatMap(({ resourceName, fieldName, isExpansion = false }) => {
        if (isExpansion) return [];
        return `${resourceName}${fieldName}`;
      })
    );

    const unmatchedItems = fieldVariations.flatMap(({ resourceName, fieldName, suggestions = [] }) => {
      if (suggestions.some(({ suggestedFieldName }) => metadataReportFieldsSet.has(`${resourceName}${suggestedFieldName}`))) {
        return [];
      } else {
        return {
          resourceName,
          fieldName
        };
      }
    });

    expect(unmatchedItems?.length).toBe(0);

    const noExactMatches = fieldVariations.flatMap(({ resourceName, fieldName, suggestions = [] }) => {
      if (suggestions.some((x) => x?.exactMatch)) {
        return [];
      } else {
        return {
          resourceName,
          fieldName
        };
      }
    });

    expect(noExactMatches.length).toBe(0);
  });

  describe('Variations Service special test cases - fields', () => {
    it('Should identify known fields as a close match when an item is one character different', async () => {
      // close matches
      const metadataReportJson = {
        fields: [
          {
            resourceName: 'Property',
            fieldName: 'ListtPrice'
          },
          {
            resourceName: 'Property',
            fieldName: 'CancelationDate'
          },
          {
            resourceName: 'Office',
            fieldName: 'MoodificationTimestamp'
          },
          {
            resourceName: 'Member',
            fieldName: 'MemmberEmail'
          }
        ]
      };

      const { variations = [] } = await computeVariations({ metadataReportJson });

      const { fields: fieldVariations = [] } = variations;

      const noCloseMatches = fieldVariations.flatMap(({ resourceName, fieldName, suggestions = [] }) => {
        if (suggestions.some((x) => x?.closeMatch)) {
          return [];
        } else {
          return {
            resourceName,
            fieldName
          };
        }
      });

      expect(noCloseMatches.length).toBe(0);
      expect(fieldVariations?.length).toBe(metadataReportJson?.fields?.length);
    });

    it('Should suggest standard fields if not already present in the metadata', async () => {
      const localTestFieldName = 'APIModificationTimestamp';
      const standardTestFieldName = 'ModificationTimestamp';

      // close matches
      const metadataReportJson = {
        fields: [
          {
            resourceName: 'Property',
            fieldName: localTestFieldName
          }
        ]
      };

      const { variations = [] } = await computeVariations({ metadataReportJson });

      const { fields: fieldVariations = [] } = variations;

      const testItems = fieldVariations.filter((item) => item?.fieldName === localTestFieldName);

      // ensure there is exactly one match and no duplication of items
      expect(testItems?.length).toBe(1);

      // the suggestion should contain the standard field
      expect(testItems[0]?.suggestions?.some((suggestion) => suggestion?.suggestedFieldName === standardTestFieldName)).toBe(true);
    });

    it('Should not suggest standard fields if already present in the metadata', async () => {
      const localTestFieldName = 'APIModificationTimestamp';
      const standardTestFieldName = 'ModificationTimestamp';

      // close matches
      const metadataReportJson = {
        fields: [
          {
            resourceName: 'Property',
            fieldName: localTestFieldName
          },
          {
            resourceName: 'Property',
            fieldName: standardTestFieldName
          }
        ]
      };

      const { variations = [] } = await computeVariations({ metadataReportJson });

      const { fields: fieldVariations = [] } = variations;

      const testItems = fieldVariations.filter((item) => item?.fieldName === localTestFieldName);

      // ensure there is exactly one match and no duplication of items
      expect(testItems?.length).toBe(0);
    });

    it('Should not suggest standard fields if already present in the metadata - multiple suggestions', async () => {
      const localTestFieldName = 'Price';
      const standardTestFieldName = 'ListPrice';

      // close matches
      const metadataReportJson = {
        fields: [
          {
            resourceName: 'Property',
            fieldName: localTestFieldName
          },
          {
            resourceName: 'Property',
            fieldName: standardTestFieldName
          }
        ]
      };

      const { variations = [] } = await computeVariations({ metadataReportJson });

      const { fields: fieldVariations = [] } = variations;

      const testItems = fieldVariations.filter((item) => item?.fieldName === localTestFieldName);

      // ensure there is exactly one match and no duplication of items
      expect(testItems?.length).toBe(1);

      const [testItem] = testItems;

      // ensure that there was at least one suggestion
      expect(testItem.suggestions?.length > 0).toBe(true);

      // ensure that the existing standard field does not show up in the suggestions
      expect(testItem.suggestions.some((suggestion) => suggestion?.suggestedFieldName === standardTestFieldName)).toBe(false);
    });
  });
});

describe('Variations Service suggestion tests', () => {
  it('Should flag resource suggestions when they are found in the metadata', async () => {
    const suggestionsMap = {
      LocalProperty: {
        suggestions: [
          {
            suggestedResourceName: 'Property'
          }
        ]
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'LocalProperty',
          fieldName: 'ohai'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources.length).toBe(1);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);

    const [{ resourceName, suggestions }, ...rest] = resources;

    expect(rest?.length).toBe(0);
    expect(resourceName).toBe('LocalProperty');
    expect(suggestions?.length).toBe(1);

    const [{ suggestedResourceName, strategy }, ...remainingSuggestions] = suggestions;

    expect(suggestedResourceName).toBe('Property');
    expect(strategy).toBe('Suggestion');
    expect(remainingSuggestions?.length).toBe(0);
  });

  it('Should not flag resource suggestions when they are found in the metadata and the standard resource exists', async () => {
    const suggestionsMap = {
      LocalProperty: {
        suggestions: [
          {
            suggestedResourceName: 'Property'
          }
        ]
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ohai'
        },
        {
          resourceName: 'LocalProperty',
          fieldName: 'ohai'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag field suggestions when they are found in the metadata', async () => {
    const suggestionsMap = {
      Property: {
        Price: {
          suggestions: [
            {
              suggestedResourceName: 'Property',
              suggestedFieldName: 'ListPrice'
            }
          ]
        }
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'Price'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(1);
    expect(lookups?.length).toBe(0);

    const [{ resourceName, fieldName, suggestions }, ...rest] = fields;

    expect(resourceName).toBe('Property');
    expect(fieldName).toBe('Price');
    expect(rest?.length).toBe(0);

    const [{ suggestedResourceName, suggestedFieldName, strategy }, ...remainingSuggestions] = suggestions;

    expect(suggestedResourceName).toBe('Property');
    expect(suggestedFieldName).toBe('ListPrice');
    expect(strategy).toBe('Suggestion');
    expect(remainingSuggestions?.length).toBe(0);
  });

  it('Should not flag field suggestions when they are found in the metadata and the standard field exists', async () => {
    const suggestionsMap = {
      Property: {
        Price: {
          suggestions: [
            {
              suggestedResourceName: 'Property',
              suggestedFieldName: 'ListPrice'
            }
          ]
        }
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'Price'
        },
        {
          resourceName: 'Property',
          fieldName: 'ListPrice'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag lookup value suggestions when they are found in the metadata', async () => {
    const suggestionsMap = {
      Property: {
        StandardStatus: {
          'Active UC': {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'StandardStatus',
                suggestedLookupValue: 'Active Under Contract'
              }
            ]
          }
        }
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'StandardStatus',
          type: 'StandardStatusLookups'
        }
      ],
      lookups: [
        {
          lookupName: 'StandardStatusLookups',
          type: 'Edm.String',
          lookupValue: 'Active UC'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(1);

    const [{ resourceName, fieldName, legacyODataValue, lookupValue, suggestions }, ...rest] = lookups;

    expect(resourceName).toBe('Property');
    expect(fieldName).toBe('StandardStatus');
    expect(lookupValue).toBe('Active UC');
    expect(!legacyODataValue).toBe(true);
    expect(rest?.length).toBe(0);

    const [
      { suggestedResourceName, suggestedFieldName, suggestedLookupValue, suggestedLegacyODataValue, strategy },
      ...remainingSuggestions
    ] = suggestions;

    expect(suggestedResourceName).toBe('Property');
    expect(suggestedFieldName).toBe('StandardStatus');
    expect(suggestedLookupValue).toBe('Active Under Contract');
    expect(!suggestedLegacyODataValue).toBe(true);
    expect(strategy).toBe('Suggestion');
    expect(remainingSuggestions?.length).toBe(0);
  });

  it('Should not flag lookup value suggestions when they are found in the metadata with a valid standard lookup value mapping ', async () => {
    const suggestionsMap = {
      Property: {
        StandardStatus: {
          'Active UC': {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'StandardStatus',
                suggestedLookupValue: 'Active Under Contract'
              }
            ]
          }
        }
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'StandardStatus',
          type: 'StandardStatusLookups'
        }
      ],
      lookups: [
        {
          lookupName: 'StandardStatusLookups',
          type: 'Edm.String',
          lookupValue: 'Active UC',
          annotations: [{ term: ANNOTATION_TERM_STANDARD_NAME, value: 'Active Under Contract' }]
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag lookup value suggestions when they are found in the metadata with an invalid standard lookup value mapping ', async () => {
    const suggestionsMap = {
      Property: {
        StandardStatus: {
          'Active UC': {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'StandardStatus',
                suggestedLookupValue: 'Active Under Contract'
              }
            ]
          }
        }
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'StandardStatus',
          type: 'StandardStatusLookups'
        }
      ],
      lookups: [
        {
          lookupName: 'StandardStatusLookups',
          type: 'Edm.String',
          lookupValue: 'Active UC',
          annotations: [{ term: ANNOTATION_TERM_STANDARD_NAME, value: 'Active Under Contrct' }]
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(1);

    const [{ resourceName, fieldName, legacyODataValue, lookupValue, suggestions }, ...rest] = lookups;

    expect(resourceName).toBe('Property');
    expect(fieldName).toBe('StandardStatus');
    expect(lookupValue).toBe('Active UC');
    expect(!legacyODataValue).toBe(true);
    expect(rest?.length).toBe(0);

    const [
      { suggestedResourceName, suggestedFieldName, suggestedLookupValue, suggestedLegacyODataValue, strategy },
      ...remainingSuggestions
    ] = suggestions;

    expect(suggestedResourceName).toBe('Property');
    expect(suggestedFieldName).toBe('StandardStatus');
    expect(suggestedLookupValue).toBe('Active Under Contract');
    expect(!suggestedLegacyODataValue).toBe(true);
    expect(strategy).toBe('Suggestion');
    expect(remainingSuggestions?.length).toBe(0);
  });

  it('Should not flag lookup value suggestions when they are found in the metadata and the standard lookup value exists', async () => {
    const suggestionsMap = {
      Property: {
        ExteriorFeatures: {
          Grill: {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ExteriorFeatures',
                suggestedLookupValue: 'Gas Grill'
              }
            ]
          }
        }
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ExteriorFeatures',
          type: 'ExteriorFeatures'
        }
      ],
      lookups: [
        {
          lookupName: 'ExteriorFeatures',
          type: 'Edm.String',
          lookupValue: 'Gas Grill'
        },
        {
          lookupName: 'ExteriorFeatures',
          type: 'Edm.String',
          lookupValue: 'Grill'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag legacyODataValue suggestions when they are found in the metadata', async () => {
    const suggestionsMap = {
      Property: {
        ExteriorFeatures: {
          Grill: {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ExteriorFeatures',
                suggestedLegacyODataValue: 'GasGrill'
              }
            ]
          }
        }
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ExteriorFeatures',
          type: 'ExteriorFeaturesLookups.ExteriorFeatures'
        }
      ],
      lookups: [
        {
          lookupName: 'ExteriorFeaturesLookups.ExteriorFeatures',
          type: 'Edm.Int64',
          lookupValue: 'Grill'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(1);

    const [{ resourceName, fieldName, legacyODataValue, lookupValue, suggestions }, ...rest] = lookups;

    expect(resourceName).toBe('Property');
    expect(fieldName).toBe('ExteriorFeatures');
    expect(legacyODataValue).toBe('Grill');
    expect(!lookupValue).toBe(true);
    expect(rest?.length).toBe(0);

    const [
      { suggestedResourceName, suggestedFieldName, suggestedLookupValue, suggestedLegacyODataValue, strategy },
      ...remainingSuggestions
    ] = suggestions;

    expect(suggestedResourceName).toBe('Property');
    expect(suggestedFieldName).toBe('ExteriorFeatures');
    expect(suggestedLegacyODataValue).toBe('GasGrill');
    expect(!suggestedLookupValue).toBe(true);
    expect(strategy).toBe('Suggestion');
    expect(remainingSuggestions?.length).toBe(0);
  });

  it('Should not flag lookup value suggestions when they are found in the metadata and the standard lookup value exists', async () => {
    const suggestionsMap = {
      Property: {
        ExteriorFeatures: {
          Grill: {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ExteriorFeatures',
                suggestedLookupValue: 'Gas Grill'
              }
            ]
          }
        }
      }
    };

    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ExteriorFeatures',
          type: 'ExteriorFeatures'
        }
      ],
      lookups: [
        {
          lookupName: 'ExteriorFeatures',
          type: 'Edm.String',
          lookupValue: 'Gas Grill'
        },
        {
          lookupName: 'ExteriorFeatures',
          type: 'Edm.String',
          lookupValue: 'Grill'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should not suggest lookup values that are less than the minimum matching length when using machine matching', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'StateOrProvince',
          type: 'StateOrProvince'
        }
      ],
      lookups: [
        {
          lookupName: 'StateOrProvince',
          type: 'Edm.String',
          lookupValue: 'California'
        }
      ]
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should not flag ignored resources', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Offices',
          fieldName: 'ModificationTimestamp',
          type: 'Edm.DateTimeOffset'
        }
      ],
      lookups: []
    };

    const suggestionsMap = {
      Offices: {
        ignored: true
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should not flag ignored fields', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ListPrices',
          type: 'Edm.Decimal'
        }
      ],
      lookups: []
    };

    const suggestionsMap = {
      Property: {
        ListPrices: {
          ignored: true
        }
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should not flag ignored enumerations', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ArchitecturalStyle',
          type: 'ArchitecturalStyles'
        }
      ],
      lookups: [
        {
          lookupName: 'ArchitecturalStyles',
          lookupValue: 'Ranch/1 Story',
          type: 'Edm.String'
        },
        {
          lookupName: 'ArchitecturalStyles',
          lookupValue: 'BsmtRanch',
          type: 'Edm.String'
        }
      ]
    };

    const suggestionsMap = {
      Property: {
        ArchitecturalStyle: {
          'Ranch/1 Story': { ignored: true },
          BsmtRanch: { ignored: true }
        }
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag Fast Track resource suggestions when present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Offices',
          fieldName: 'ModificationTimestamp',
          type: 'Edm.DateTimeOffset'
        }
      ],
      lookups: []
    };

    const suggestionsMap = {
      Offices: {
        suggestions: [
          {
            suggestedResourceName: 'Office',
            isFastTrack: true
          }
        ]
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(1);
    expect(resources?.[0]?.suggestions?.[0].strategy).toBe(MATCHING_STRATEGIES.FAST_TRACK);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag Fast Track field suggestions when present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ListPrices',
          type: 'Edm.Decimal'
        }
      ],
      lookups: []
    };

    const suggestionsMap = {
      Property: {
        ListPrices: {
          suggestions: [
            {
              suggestedResourceName: 'Property',
              suggestedFieldName: 'ListPrice',
              isFastTrack: true
            }
          ]
        }
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(1);
    expect(fields?.[0]?.suggestions?.[0].strategy).toBe(MATCHING_STRATEGIES.FAST_TRACK);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag Fast Track enumerations when present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ArchitecturalStyle',
          type: 'ArchitecturalStyles'
        }
      ],
      lookups: [
        {
          lookupName: 'ArchitecturalStyles',
          lookupValue: 'Ranch/1 Story',
          type: 'Edm.String'
        }
      ]
    };

    const suggestionsMap = {
      Property: {
        ArchitecturalStyle: {
          'Ranch/1 Story': {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ArchitecturalStyle',
                suggestedLookupValue: 'Ranch',
                isFastTrack: true
              }
            ]
          }
        }
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(1);
    expect(lookups?.[0]?.suggestions?.[0].strategy).toBe(MATCHING_STRATEGIES.FAST_TRACK);
  });

  it('Should flag Admin resource suggestions when present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Offices',
          fieldName: 'ModificationTimestamp',
          type: 'Edm.DateTimeOffset'
        }
      ],
      lookups: []
    };

    const suggestionsMap = {
      Offices: {
        suggestions: [
          {
            suggestedResourceName: 'Office',
            isAdminReview: true
          }
        ]
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(1);
    expect(resources?.[0]?.suggestions?.[0].strategy).toBe(MATCHING_STRATEGIES.ADMIN_REVIEW);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag Admin field suggestions when present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ListPrices',
          type: 'Edm.Decimal'
        }
      ],
      lookups: []
    };

    const suggestionsMap = {
      Property: {
        ListPrices: {
          suggestions: [
            {
              suggestedResourceName: 'Property',
              suggestedFieldName: 'ListPrice',
              isAdminReview: true
            }
          ]
        }
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(1);
    expect(fields?.[0]?.suggestions?.[0].strategy).toBe(MATCHING_STRATEGIES.ADMIN_REVIEW);
    expect(lookups?.length).toBe(0);
  });

  it('Should flag Admin lookup suggestions when present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ArchitecturalStyle',
          type: 'ArchitecturalStyles'
        }
      ],
      lookups: [
        {
          lookupName: 'ArchitecturalStyles',
          lookupValue: 'Ranch/1 Story',
          type: 'Edm.String'
        }
      ]
    };

    const suggestionsMap = {
      Property: {
        ArchitecturalStyle: {
          'Ranch/1 Story': {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ArchitecturalStyle',
                suggestedLookupValue: 'Ranch',
                isAdminReview: true
              }
            ]
          }
        }
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(1);
    expect(lookups?.[0]?.suggestions?.[0].strategy).toBe(MATCHING_STRATEGIES.ADMIN_REVIEW);
  });

  it('Should not flag Fast Track resource suggestions when many exist and one is present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Properties',
          fieldName: 'ListPrice',
          type: 'Edm.Decimal'
        },
        {
          resourceName: 'Property',
          fieldName: 'ListPrice',
          type: 'Edm.Decimal'
        }
      ]
    };

    const suggestionsMap = {
      Properties: {
        suggestions: [
          {
            suggestedResourceName: 'Property',
            isFastTrack: true
          },
          {
            suggestedResourceName: 'Building',
            isFastTrack: true
          }
        ]
      }
    };

    const {
      variations: { resources = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
  });

  it('Should not flag Fast Track field suggestions when many exist and one is present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ListPrices',
          type: 'Edm.Decimal'
        },
        {
          resourceName: 'Property',
          fieldName: 'ListPrice',
          type: 'Edm.Decimal'
        }
      ]
    };

    const suggestionsMap = {
      Property: {
        ListPrices: {
          suggestions: [
            {
              suggestedResourceName: 'Property',
              suggestedFieldName: 'ListPrice',
              isFastTrack: true
            },
            {
              suggestedResourceName: 'Property',
              suggestedFieldName: 'ListPriceLow',
              isFastTrack: true
            }
          ]
        }
      }
    };

    const {
      variations: { resources = [], fields = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
  });

  it('Should not flag Fast Track enumeration suggestions when many exist and one is present', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ArchitecturalStyle',
          type: 'ArchitecturalStyle'
        }
      ],
      lookups: [
        {
          lookupName: 'ArchitecturalStyle',
          lookupValue: 'Ranch/1 Story',
          type: 'Edm.String'
        },
        {
          lookupName: 'ArchitecturalStyle',
          lookupValue: 'Ranch',
          type: 'Edm.String'
        }
      ]
    };

    const suggestionsMap = {
      Property: {
        ArchitecturalStyle: {
          'Ranch/1 Story': {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ArchitecturalStyle',
                suggestedLookupValue: 'Ranch',
                isFastTrack: true
              },
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ArchitecturalStyle',
                suggestedLookupValue: 'Raised Ranch',
                isFastTrack: true
              }
            ]
          }
        }
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });

  it('Should allow lookups to be remapped using StandardLookupValue in the Lookup Resource', async () => {
    const metadataReportJson = {
      fields: [
        {
          resourceName: 'Property',
          fieldName: 'ArchitecturalStyle',
          type: 'ArchitecturalStyle'
        }
      ],
      lookups: [
        {
          lookupName: 'ArchitecturalStyle',
          lookupValue: 'Ranch/1 Story',
          type: 'Edm.String',
          annotations: [{ term: ANNOTATION_TERM_STANDARD_NAME, value: 'Ranch' }]
        }
      ]
    };

    const suggestionsMap = {
      Property: {
        ArchitecturalStyle: {
          'Ranch/1 Story': {
            suggestions: [
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ArchitecturalStyle',
                suggestedLookupValue: 'Ranch',
                isFastTrack: true
              },
              {
                suggestedResourceName: 'Property',
                suggestedFieldName: 'ArchitecturalStyle',
                suggestedLookupValue: 'Raised Ranch',
                isFastTrack: true
              }
            ]
          }
        }
      }
    };

    const {
      variations: { resources = [], fields = [], lookups = [] }
    } = await computeVariations({ metadataReportJson, suggestionsMap });

    expect(resources?.length).toBe(0);
    expect(fields?.length).toBe(0);
    expect(lookups?.length).toBe(0);
  });
});
