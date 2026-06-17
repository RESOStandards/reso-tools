/**
 * computeVariationsV2 — exact-filters-the-rest.
 *
 * When the machine matcher produces an exact suggestion for a provider element (normalized-
 * equal, raw-different), that element emits ONLY its exact suggestion(s); every substring and
 * edit-distance suggestion for the same element is dropped. (Legacy merely ordered the exact to
 * the head and kept the rest.) Exercised at the resource, field, and lookup levels.
 *
 * The 'lowercase resource' (property) and 'noisy field' (list_price) cases moved here from
 * compute-v2-parity, since the exact-filter is an intentional divergence from legacy.
 *
 * Real DD 1.7 values; inputs are synthetic — no vendor reports or identifiers.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

type Json = Record<string, unknown>;

const variationsFor = (report: Json, version = '1.7'): Json => {
  const { variations } = computeVariationsV2({
    metadataReportJson: report,
    referenceMetadata: getReferenceMetadata(version),
    version,
    fuzziness: 0.25,
    applyVersionBucketing: false,
  }) as { variations: Json };
  return variations;
};

// Flatten suggested-target values at a level, tolerant of flat vs nested `.suggestions` shapes.
const suggested = (items: Json[] | undefined, key: string): string[] =>
  (items ?? []).flatMap((i) => {
    const direct = i[key] as string | undefined;
    const nested = ((i.suggestions as Json[]) ?? []).map((s) => s[key] as string);
    return [direct, ...nested].filter((v): v is string => !!v);
  });

describe('computeVariationsV2: an exact match filters out the element’s fuzzy suggestions', () => {
  it('resource: "property" emits only the exact "Property", not the Property* substrings', () => {
    const v = variationsFor({ fields: [{ resourceName: 'property', fieldName: 'ListPrice' }] });
    expect(suggested(v.resources as Json[], 'suggestedResourceName')).toEqual(['Property']);
  });

  it('field: "list_price" emits only the exact "ListPrice", not the substring matches', () => {
    const v = variationsFor({ fields: [{ resourceName: 'Property', fieldName: 'list_price' }] });
    expect(suggested(v.fields as Json[], 'suggestedFieldName')).toEqual(['ListPrice']);
  });

  it('lookup: "active" emits only the exact "Active", not the substring "Active Under Contract"', () => {
    const v = variationsFor({
      fields: [{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'StandardStatusLookups' }],
      lookups: [{ lookupName: 'StandardStatusLookups', type: 'Edm.String', lookupValue: 'active' }],
    });
    expect(suggested(v.lookups as Json[], 'suggestedLookupValue')).toEqual(['Active']);
  });
});
