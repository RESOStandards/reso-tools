/**
 * computeVariationsV2 — store-suggestion emit is whole-set gated (emit all survivors).
 *
 * A store-suggestion set (human / Fast Track / admin) emits every survivor UNLESS any one
 * suggestion's target is already present in the provider's metadata (by direct key OR StandardName
 * annotation) — in which case the entire set is suppressed. There is no per-suggestion drop on the
 * emit path; the resource/field emit callbacks return their suggestion unconditionally, matching the
 * lookup/legacy callbacks.
 *
 * Synthetic inputs — no vendor reports or identifiers.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

type Json = Record<string, unknown>;

const suggestedResources = (report: Json, suggestionsMap: Json, version = '1.7'): string[] => {
  const { variations } = computeVariationsV2({
    metadataReportJson: report,
    referenceMetadata: getReferenceMetadata(version),
    suggestionsMap,
    version,
    fuzziness: 0.25,
    applyVersionBucketing: false,
  }) as { variations: { resources?: Json[] } };
  return (variations.resources ?? []).flatMap((r) =>
    [r.suggestedResourceName as string, ...((r.suggestions as Json[]) ?? []).map((s) => s.suggestedResourceName as string)].filter(
      (v): v is string => !!v,
    ),
  );
};

describe('computeVariationsV2: store-suggestion emit is whole-set gated', () => {
  it('emits the survivor when the suggested target is absent from the provider metadata', () => {
    const suggested = suggestedResources(
      { fields: [{ resourceName: 'Propertyy', fieldName: 'ListPrice' }] },
      { Propertyy: { suggestions: [{ suggestedResourceName: 'Property' }] } },
    );
    expect(suggested).toContain('Property');
  });

  it('suppresses the whole set when the suggested target is already present', () => {
    const suggested = suggestedResources(
      {
        fields: [
          { resourceName: 'Propertyy', fieldName: 'ListPrice' },
          { resourceName: 'Property', fieldName: 'ListPrice' },
        ],
      },
      { Propertyy: { suggestions: [{ suggestedResourceName: 'Property' }] } },
    );
    expect(suggested).not.toContain('Property');
  });
});
