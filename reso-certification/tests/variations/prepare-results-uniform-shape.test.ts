/**
 * Every element-level bucket carries the same record shape.
 *
 * `prepareResults` groups flat matcher records into one entry per element with a
 * `suggestions[]` array. Fields, lookups and resources always did; expansions and
 * complex types were passed through raw, so an expansion arrived as one record per
 * suggestion with the target inline. Downstream that is invisible: every consumer
 * reads `suggestions`, finds none, and renders the element as having no suggestion —
 * which is how a correct `OpenHouse -> OpenHouses` never reached a reviewer.
 *
 * The parity suite pins reso-common against the legacy original, so it passes as long
 * as both agree. These pin the shape itself, so a revert on both sides is still caught.
 */

import { describe, expect, it } from 'vitest';
import { prepareResults } from '@reso-standards/reso-common';

describe('prepareResults — one record shape across every bucket', () => {
  it('groups an expansion into a suggestions array', () => {
    const { expansions } = prepareResults({
      expansions: [{ resourceName: 'Property', fieldName: 'OpenHouse', suggestedFieldName: 'OpenHouses', strategy: 'Substring' }],
    });

    expect(expansions).toHaveLength(1);
    expect(expansions[0]).toMatchObject({ resourceName: 'Property', fieldName: 'OpenHouse' });
    expect(expansions[0].suggestions).toEqual([{ suggestedFieldName: 'OpenHouses', strategy: 'Substring' }]);
  });

  it('collapses several suggestions for one expansion into a single entry', () => {
    // Observed on a live report: Teams.SocialMedia arrived as two records, which read
    // downstream as a duplicated row rather than one element with two candidates.
    const { expansions } = prepareResults({
      expansions: [
        { resourceName: 'Teams', fieldName: 'SocialMedia', suggestedFieldName: 'Media', strategy: 'Substring' },
        { resourceName: 'Teams', fieldName: 'SocialMedia', suggestedFieldName: 'TeamsSocialMedia', strategy: 'Substring' },
      ],
    });

    expect(expansions).toHaveLength(1);
    expect(expansions[0].suggestions).toHaveLength(2);
  });

  it('groups complex types the same way', () => {
    const { complexTypes } = prepareResults({
      complexTypes: [{ resourceName: 'Property', fieldName: 'Address', suggestedFieldName: 'Addresses', strategy: 'Substring' }],
    });

    expect(complexTypes).toHaveLength(1);
    expect(complexTypes[0].suggestions).toHaveLength(1);
  });

  it('keeps every bucket readable through the same key', () => {
    const out = prepareResults({
      fields: [{ resourceName: 'Property', fieldName: 'ListPrce', suggestedFieldName: 'ListPrice' }],
      expansions: [{ resourceName: 'Property', fieldName: 'OpenHouse', suggestedFieldName: 'OpenHouses' }],
      complexTypes: [{ resourceName: 'Property', fieldName: 'Address', suggestedFieldName: 'Addresses' }],
    });

    for (const bucket of [out.fields, out.expansions, out.complexTypes]) {
      expect(bucket[0]).toHaveProperty('suggestions');
      expect(Array.isArray(bucket[0].suggestions)).toBe(true);
    }
  });

  it('carries the element level on the record, not just in the bucket', () => {
    // The matcher knows an expansion from a field — it picks the bucket on exactly
    // that — and used to discard the distinction. A field and an expansion populate
    // the same keys, so a consumer re-deriving the level from the keys reads every
    // expansion as a field. That is the review page's Expansions (0) bug.
    const out = prepareResults({
      resources: [{ resourceName: 'Prop', suggestedResourceName: 'Property' }],
      fields: [{ resourceName: 'Property', fieldName: 'ListPrce', suggestedFieldName: 'ListPrice' }],
      expansions: [{ resourceName: 'Property', fieldName: 'OpenHouse', suggestedFieldName: 'OpenHouses' }],
      complexTypes: [{ resourceName: 'Property', fieldName: 'Address', suggestedFieldName: 'Addresses' }],
      lookupValues: [{ resourceName: 'Property', fieldName: 'StandardStatus', lookupValue: 'Active UC' }],
    });

    expect(out.resources[0].level).toBe('resource');
    expect(out.fields[0].level).toBe('field');
    expect(out.expansions[0].level).toBe('expansion');
    expect(out.complexTypes[0].level).toBe('complexType');
    expect(out.lookups[0].level).toBe('lookup');
  });

  it('distinguishes a field from an expansion that populates the same keys', () => {
    const out = prepareResults({
      fields: [{ resourceName: 'Property', fieldName: 'Media', suggestedFieldName: 'Medias' }],
      expansions: [{ resourceName: 'Property', fieldName: 'Media', suggestedFieldName: 'Medias' }],
    });

    // Identical records, distinguishable only by the level they carry.
    expect(out.fields[0].level).toBe('field');
    expect(out.expansions[0].level).toBe('expansion');
    expect(out.fields[0].fieldName).toBe(out.expansions[0].fieldName);
  });

  it('returns an empty bucket rather than a placeholder entry', () => {
    const out = prepareResults({});
    expect(out.expansions).toEqual([]);
    expect(out.complexTypes).toEqual([]);
  });
});
