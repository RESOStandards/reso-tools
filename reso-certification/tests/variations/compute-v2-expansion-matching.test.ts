/**
 * computeVariationsV2 — expansion matching (the DD 2.1 fill of the legacy expansion stub).
 *
 * Exact-name expansion conformance is the DD metadata gate's job (checkExpansionStructure); the
 * matcher only finds APPROXIMATE expansion variations, like-with-like: a provider expansion is
 * matched against the standard EXPANSIONS, a plain field against the standard FIELDS. A local
 * expansion variant is allowed when the provider also declares the standard expansion (the Issue-2
 * canonical suppression — machineMatch's hasStandard skip). General rule, per the Aug-4 Transport
 * "Expansions and False Positives" decision; Media is the example, not the limit.
 *
 * Real DD 2.1 expansions (Property/Media); provider inputs are synthetic — no vendor reports.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

type Json = Record<string, unknown>;

const MEDIA_TYPE = 'Collection(org.reso.metadata.Media)';

const variationsFor = (report: Json, version = '2.1'): Json => {
  const { variations } = computeVariationsV2({
    metadataReportJson: report,
    referenceMetadata: getReferenceMetadata(version),
    version,
    fuzziness: 0.25,
    applyVersionBucketing: false,
  }) as { variations: Json };
  return variations;
};

// Suggested expansion targets, tolerant of flat vs nested `.suggestions` shapes.
const suggestedExpansions = (variations: Json): string[] =>
  ((variations.expansions as Json[]) ?? []).flatMap((i) => {
    const direct = i.suggestedFieldName as string | undefined;
    const nested = ((i.suggestions as Json[]) ?? []).map((s) => s.suggestedFieldName as string);
    return [direct, ...nested].filter((v): v is string => !!v);
  });

describe('computeVariationsV2: expansion matching (like-with-like; the gate owns exact)', () => {
  it('flags a provider expansion with a near-miss name against the standard expansion', () => {
    const v = variationsFor({
      fields: [{ resourceName: 'Property', fieldName: 'Medias', type: MEDIA_TYPE, isExpansion: true }],
    });
    expect(suggestedExpansions(v)).toContain('Media');
  });

  it('suppresses the local variant when the provider also declares the standard expansion (Issue-2)', () => {
    const v = variationsFor({
      fields: [
        { resourceName: 'Property', fieldName: 'Medias', type: MEDIA_TYPE, isExpansion: true },
        { resourceName: 'Property', fieldName: 'Media', type: MEDIA_TYPE, isExpansion: true },
      ],
    });
    expect(suggestedExpansions(v)).not.toContain('Media');
  });

  it('does not match a plain field against the standard expansions (like-with-like)', () => {
    const v = variationsFor({
      fields: [{ resourceName: 'Property', fieldName: 'Medias' }], // a plain field, not an expansion
    });
    expect(suggestedExpansions(v)).not.toContain('Media');
  });

  it('does not emit an expansion variation for an exact-name expansion mistyped as a non-expansion (the gate owns that)', () => {
    const v = variationsFor({
      fields: [{ resourceName: 'Property', fieldName: 'Media', type: 'Collection(Property.MediaType)' }],
    });
    expect(v.expansions as Json[]).toEqual([]);
  });
});
