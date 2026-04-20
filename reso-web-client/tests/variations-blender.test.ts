/**
 * Variations Blender — tests.
 *
 * Covers: service override, ignored suppression, FT priority,
 * machine-only fallback, mixed sources, counts.
 */

import { describe, it, expect } from 'vitest';
import { blendVariations, type BlendedVariationsReport } from '../src/services/variations-blender';

// ── Helpers ──────────────────────────────────────────────────────────

const makeLocalReport = (overrides: Record<string, unknown> = {}) => ({
  description: 'Data Dictionary Variations Report',
  version: '2.1',
  generatedOn: '2026-04-19T00:00:00Z',
  fuzziness: 0.25,
  variations: {
    resources: [],
    fields: [],
    lookups: [],
    expansions: [],
    complexTypes: [],
  },
  ...overrides,
});

// ── Basic blending ───────────────────────────────────────────────────

describe('blendVariations', () => {
  it('returns empty variations for empty input', () => {
    const result = blendVariations(makeLocalReport());
    expect(result.variations).toHaveLength(0);
    expect(result.counts.total).toBe(0);
  });

  it('passes through machine-only suggestions', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [{
          resourceName: 'Property',
          fieldName: 'LstPrice',
          suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ListPrice', strategy: 'Substring', exactMatch: false }],
        }],
        lookups: [],
        expansions: [],
        complexTypes: [],
      },
    });
    const result = blendVariations(local, {});
    expect(result.variations).toHaveLength(1);
    expect(result.variations[0].source).toBe('machine');
    expect(result.variations[0].suggestions[0].strategy).toBe('Substring');
  });

  it('service suggestions override machine suggestions', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [{
          resourceName: 'Property',
          fieldName: 'BuyerAgencyCompensation',
          suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'SomeMachineGuess', strategy: 'Edit Distance' }],
        }],
        lookups: [],
        expansions: [],
        complexTypes: [],
      },
    });
    const service = {
      Property: {
        BuyerAgencyCompensation: {
          suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'BuyerBrokerageCompensation', isAdminReview: true }],
        },
      },
    };
    const result = blendVariations(local, service);
    expect(result.variations).toHaveLength(1);
    expect(result.variations[0].source).toBe('blended');
    expect(result.variations[0].suggestions[0].suggestedFieldName).toBe('BuyerBrokerageCompensation');
    expect(result.variations[0].suggestions[0].strategy).toBe('Admin Review');
  });

  it('ignored items from service suppress the variation', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [{
          resourceName: 'Property',
          fieldName: 'CustomField',
          suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'StandardField', strategy: 'Substring' }],
        }],
        lookups: [],
        expansions: [],
        complexTypes: [],
      },
    });
    const service = {
      Property: {
        CustomField: { ignored: true },
      },
    };
    const result = blendVariations(local, service);
    expect(result.variations).toHaveLength(1);
    expect(result.variations[0].ignored).toBe(true);
    expect(result.variations[0].suggestions).toHaveLength(0);
    expect(result.variations[0].source).toBe('service');
  });

  it('Fast Track suggestions are tagged correctly', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [],
        lookups: [{
          resourceName: 'Property',
          fieldName: 'ConstructionMaterials',
          lookupValue: '?? Brick',
          suggestions: [],
        }],
        expansions: [],
        complexTypes: [],
      },
    });
    const service = {
      Property: {
        ConstructionMaterials: {
          '?? Brick': {
            suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ConstructionMaterials', suggestedLookupValue: 'Brick', isFastTrack: true }],
          },
        },
      },
    };
    const result = blendVariations(local, service);
    expect(result.variations[0].suggestions[0].isFastTrack).toBe(true);
    expect(result.variations[0].suggestions[0].strategy).toBe('Fast Track');
    expect(result.counts.fastTrack).toBe(1);
  });
});

// ── Lookup-level blending ────────────────────────────────────────────

describe('Lookup-level blending', () => {
  it('blends cross-field lookup suggestions', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [],
        lookups: [{
          resourceName: 'Property',
          fieldName: 'ConstructionMaterials',
          lookupValue: '1 Story',
          suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'ConstructionMaterials', suggestedLookupValue: 'OneStory', strategy: 'Substring' }],
        }],
        expansions: [],
        complexTypes: [],
      },
    });
    const service = {
      Property: {
        ConstructionMaterials: {
          '1 Story': {
            suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Levels', suggestedLookupValue: 'One', isFastTrack: true }],
          },
        },
      },
    };
    const result = blendVariations(local, service);
    expect(result.variations[0].suggestions[0].suggestedFieldName).toBe('Levels');
    expect(result.variations[0].suggestions[0].suggestedLookupValue).toBe('One');
  });

  it('handles compound suggestions with suggestedRelated* keys', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [],
        lookups: [{
          resourceName: 'Property',
          fieldName: 'PropertySubType',
          lookupValue: 'Acreage & Farms',
          suggestions: [],
        }],
        expansions: [],
        complexTypes: [],
      },
    });
    const service = {
      Property: {
        PropertySubType: {
          'Acreage & Farms': {
            suggestions: [{
              suggestedResourceName: 'Property',
              suggestedFieldName: 'PropertySubType',
              suggestedLookupValue: 'Farm',
              suggestedRelatedResourceName: 'Property',
              suggestedRelatedFieldName: 'PropertyType',
              suggestedRelatedLookupValue: 'Land',
              isFastTrack: true,
            }],
          },
        },
      },
    };
    const result = blendVariations(local, service);
    const suggestion = result.variations[0].suggestions[0];
    expect(suggestion.suggestedRelatedResourceName).toBe('Property');
    expect(suggestion.suggestedRelatedFieldName).toBe('PropertyType');
    expect(suggestion.suggestedRelatedLookupValue).toBe('Land');
  });
});

// ── Counts ───────────────────────────────────────────────────────────

describe('Counts', () => {
  it('counts by category correctly', () => {
    const local = makeLocalReport({
      variations: {
        resources: [{ resourceName: 'CustomResource', suggestions: [{ suggestedResourceName: 'Property', strategy: 'Substring' }] }],
        fields: [
          { resourceName: 'Property', fieldName: 'F1', suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'F2', strategy: 'Edit Distance' }] },
          { resourceName: 'Property', fieldName: 'F3', suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'F4', strategy: 'Substring' }] },
        ],
        lookups: [{ resourceName: 'Property', fieldName: 'Status', lookupValue: 'A', suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'StandardStatus', suggestedLookupValue: 'Active', strategy: 'Substring' }] }],
        expansions: [{ resourceName: 'Property', fieldName: 'Media', suggestions: [], message: 'Must be an expansion' }],
        complexTypes: [],
      },
    });
    const result = blendVariations(local);
    expect(result.counts.resources).toBe(1);
    expect(result.counts.fields).toBe(2);
    expect(result.counts.lookups).toBe(1);
    expect(result.counts.expansions).toBe(1);
    expect(result.counts.total).toBe(5);
  });

  it('counts ignored and FT correctly', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [
          { resourceName: 'Property', fieldName: 'F1', suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'F2', strategy: 'Substring' }] },
          { resourceName: 'Property', fieldName: 'F2', suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'F3', strategy: 'Substring' }] },
        ],
        lookups: [],
        expansions: [],
        complexTypes: [],
      },
    });
    const service = {
      Property: {
        F1: { ignored: true },
        F2: { suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'F3', isFastTrack: true }] },
      },
    };
    const result = blendVariations(local, service);
    expect(result.counts.ignored).toBe(1);
    expect(result.counts.fastTrack).toBe(1);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('items not in service get machine suggestions', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [{ resourceName: 'Property', fieldName: 'Unknown', suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'Known', strategy: 'Edit Distance', distance: 2, maxDistance: 3 }] }],
        lookups: [],
        expansions: [],
        complexTypes: [],
      },
    });
    const result = blendVariations(local, {});
    expect(result.variations[0].source).toBe('machine');
    expect(result.variations[0].suggestions[0].distance).toBe(2);
  });

  it('preserves report metadata', () => {
    const local = makeLocalReport();
    const result = blendVariations(local);
    expect(result.description).toBe('Data Dictionary Variations Report');
    expect(result.version).toBe('2.1');
    expect(result.fuzziness).toBe(0.25);
  });

  it('handles service with no suggestions and no ignored (zombie) gracefully', () => {
    const local = makeLocalReport({
      variations: {
        resources: [],
        fields: [{ resourceName: 'Property', fieldName: 'F1', suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'F2', strategy: 'Substring' }] }],
        lookups: [],
        expansions: [],
        complexTypes: [],
      },
    });
    const service = {
      Property: {
        F1: {},
      },
    };
    const result = blendVariations(local, service);
    // Zombie service entry should not affect the machine suggestion
    expect(result.variations[0].source).toBe('machine');
    expect(result.variations[0].suggestions).toHaveLength(1);
  });
});
