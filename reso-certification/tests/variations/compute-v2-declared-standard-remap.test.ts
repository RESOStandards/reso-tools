/**
 * computeVariationsV2 — DD-2.x Lookup Resource remap carve-out.
 *
 * On an Edm.String lookup field, a provider value whose DECLARED StandardName annotation resolves
 * to a DD standard value is an already-declared standard→standard remap: the lookup gate
 * (`hasStandardLookupMapping`) skips it BEFORE the store-suggestion branch, so no variation emits.
 * If the declared annotation does NOT resolve, the carve-out is silent and the normal path runs.
 *
 * This pins the V2 machine gate directly — the existing dd2x-remap suite exercises the invariant
 * only against the legacy oracle. Teeth: in the resolving case a "Pending" store suggestion would
 * emit absent the carve-out; the control confirms it (a non-resolving annotation lets it through).
 *
 * Real DD 1.7 StandardStatus values; synthetic inputs — no vendor reports or identifiers.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const SN = 'RESO.OData.Metadata.StandardName';
const VERSION = '1.7';

// Provider lookup value "Active UC" with a StandardName annotation = `annotationValue`, plus a store
// suggestion routing "Active UC" → "Pending". Returns the suggested lookup values that emit.
const suggestedLookups = (annotationValue: string): string[] => {
  const metadataReportJson = {
    fields: [{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'StandardStatusLookups' }],
    lookups: [
      { lookupName: 'StandardStatusLookups', type: 'Edm.String', lookupValue: 'Active UC', annotations: [{ term: SN, value: annotationValue }] },
    ],
  };
  const suggestionsMap = {
    Property: {
      StandardStatus: {
        'Active UC': { suggestions: [{ suggestedResourceName: 'Property', suggestedFieldName: 'StandardStatus', suggestedLookupValue: 'Pending' }] },
      },
    },
  };
  const { variations } = computeVariationsV2({
    metadataReportJson,
    referenceMetadata: getReferenceMetadata(VERSION),
    suggestionsMap,
    version: VERSION,
    fuzziness: 0.25,
    applyVersionBucketing: false,
  }) as { variations: { lookups?: Array<Record<string, unknown>> } };
  return (variations.lookups ?? []).flatMap((l) => {
    const direct = l.suggestedLookupValue as string | undefined;
    const nested = ((l.suggestions as Array<Record<string, unknown>>) ?? []).map((s) => s.suggestedLookupValue as string);
    return [direct, ...nested].filter((v): v is string => !!v);
  });
};

describe('computeVariationsV2: DD-2.x Lookup Resource remap carve-out', () => {
  it('declared StandardName resolving in DD suppresses the whole lookup entry (no suggestion)', () => {
    // "Active Under Contract" is a DD StandardStatus value → hasStandardLookupMapping → gate skips
    // before the store-suggestion branch, so the "Pending" suggestion never emits.
    expect(suggestedLookups('Active Under Contract')).toEqual([]);
  });

  it('declared StandardName NOT resolving leaves the normal path (suggestion emits)', () => {
    // control: annotation points at a non-DD value → carve-out silent → the store suggestion emits.
    expect(suggestedLookups('NotADDValue')).toContain('Pending');
  });
});
