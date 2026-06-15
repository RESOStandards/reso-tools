/**
 * Golden-master coverage — DD 2.x StandardLookupValue remap via the Lookup Resource.
 *
 * A provider may use any local lookup value on an Edm.String + LookupResource field
 * as long as the canonical is declared via the RESO.OData.Metadata.StandardName
 * annotation. When the annotation declares a suggested target, the suggestion is
 * suppressed (the provider has satisfied it) — and any-one applies across multiple
 * suggestions: one satisfied target suppresses the whole entry.
 *
 * Ported from cert-utils `test/variations.js`. Oracle: legacy `computeVariations`.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const FUZZINESS = 0.25;
const DD_1_7 = '1.7';
const SN = 'RESO.OData.Metadata.StandardName';

describe('computeVariations: DD 2.x StandardLookupValue remap (Lookup Resource)', () => {
  it('suppresses FT suggestions when the canonical is declared via StandardName annotation', async () => {
    const metadataReportJson = {
      fields: [{ resourceName: 'Property', fieldName: 'ArchitecturalStyle', type: 'ArchitecturalStyle' }],
      lookups: [
        {
          lookupName: 'ArchitecturalStyle',
          lookupValue: 'Ranch/1 Story',
          type: 'Edm.String',
          annotations: [{ term: SN, value: 'Ranch' }],
        },
      ],
    };
    const suggestionsMap = {
      Property: {
        ArchitecturalStyle: {
          'Ranch/1 Story': {
            suggestions: [
              { suggestedResourceName: 'Property', suggestedFieldName: 'ArchitecturalStyle', suggestedLookupValue: 'Ranch', isFastTrack: true },
              { suggestedResourceName: 'Property', suggestedFieldName: 'ArchitecturalStyle', suggestedLookupValue: 'Raised Ranch', isFastTrack: true },
            ],
          },
        },
      },
    };

    const { variations: { resources = [], fields = [], lookups = [] } } = await computeVariations({
      metadataReportJson,
      fuzziness: FUZZINESS,
      version: DD_1_7,
      suggestionsMap,
    });

    expect(resources).toHaveLength(0);
    expect(fields).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });
});
