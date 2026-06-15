/**
 * /compute version bucketing — enforcement = must-fix | warning by targetMajor.
 *
 * NEW behavior (no legacy oracle — these pin the VER-* invariants directly).
 * `currentMajor` defaults to the major of `version` (which itself defaults to
 * CURRENT_DD_VERSION). A variation is:
 *   - must-fix  when ANY suggestion applies now: targetMajor <= currentMajor, OR
 *               targetMajor absent (machine matches / current-major store adds).
 *   - warning   only when EVERY suggestion targets a future major.
 * Items with no suggestions (machine-detected expansions / complex types) are
 * current-major must-fix.
 *
 * The flag `applyVersionBucketing: false` suppresses tagging entirely (faithful
 * legacy shape) — that path is covered by the parity suite.
 *
 * All inputs are anonymized synthetic — no vendor reports or identifiers.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { computeVariationsV2 } from '../../src/variations-v2/compute.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const REF = getReferenceMetadata('2.1');
const FUZZINESS = 0.25;

// A non-standard field carrying one human suggestion toward a standard field that
// is ABSENT from the report (so the suggestion always survives suppression and
// emits). targetMajor is parameterized to drive the bucket.
const fieldSuggestion = (targetMajor?: number): Record<string, unknown> => ({
  Property: {
    CustomFieldXYZ: {
      suggestions: [
        {
          suggestedResourceName: 'Property',
          suggestedFieldName: 'ListPrice',
          isFastTrack: true,
          ...(targetMajor != null ? { targetMajor } : {}),
        },
      ],
    },
  },
});

const REPORT = { fields: [{ resourceName: 'Property', fieldName: 'CustomFieldXYZ' }] };

const run = (
  suggestionsMap: Record<string, unknown>,
  opts: Record<string, unknown> = {},
): { variations: { fields: Array<{ enforcement?: string; suggestions: unknown[] }> } } =>
  computeVariationsV2({
    metadataReportJson: REPORT,
    referenceMetadata: REF,
    suggestionsMap,
    version: '2.1',
    fuzziness: FUZZINESS,
    ...opts,
  }) as never;

const enforcementOf = (r: ReturnType<typeof run>): string | undefined => r.variations.fields[0]?.enforcement;

describe('computeVariationsV2: version bucketing (enforcement)', () => {
  it('targetMajor == currentMajor → must-fix', () => {
    expect(enforcementOf(run(fieldSuggestion(2)))).toBe('must-fix');
  });

  it('targetMajor < currentMajor → must-fix', () => {
    expect(enforcementOf(run(fieldSuggestion(1)))).toBe('must-fix');
  });

  it('targetMajor > currentMajor → warning', () => {
    expect(enforcementOf(run(fieldSuggestion(3)))).toBe('warning');
  });

  it('no targetMajor (current-major store add) → must-fix', () => {
    expect(enforcementOf(run(fieldSuggestion(undefined)))).toBe('must-fix');
  });

  it('mixed suggestions — any one applies now → must-fix', () => {
    const map = {
      Property: {
        CustomFieldXYZ: {
          suggestions: [
            { suggestedResourceName: 'Property', suggestedFieldName: 'ListPrice', isFastTrack: true, targetMajor: 3 },
            { suggestedResourceName: 'Property', suggestedFieldName: 'CloseDate', isFastTrack: true, targetMajor: 2 },
          ],
        },
      },
    };
    const r = run(map);
    // both targets are absent from the report → both suggestions emit on the one field
    expect(r.variations.fields[0].suggestions).toHaveLength(2);
    // the targetMajor-2 suggestion forces the whole element to must-fix
    expect(r.variations.fields[0].enforcement).toBe('must-fix');
  });

  it('all-future suggestions → warning', () => {
    const map = {
      Property: {
        CustomFieldXYZ: {
          suggestions: [
            { suggestedResourceName: 'Property', suggestedFieldName: 'ListPrice', isFastTrack: true, targetMajor: 3 },
            { suggestedResourceName: 'Property', suggestedFieldName: 'CloseDate', isFastTrack: true, targetMajor: 4 },
          ],
        },
      },
    };
    const r = run(map);
    expect(r.variations.fields[0].suggestions).toHaveLength(2);
    expect(r.variations.fields[0].enforcement).toBe('warning');
  });

  it('machine match (no store suggestion) → current-major must-fix', () => {
    const r = computeVariationsV2({
      metadataReportJson: { fields: [{ resourceName: 'Property', fieldName: 'list_price' }] },
      referenceMetadata: REF,
      version: '2.1',
      fuzziness: FUZZINESS,
    }) as ReturnType<typeof run>;
    expect(r.variations.fields[0].enforcement).toBe('must-fix');
  });

  it('currentMajor overrides the version-derived major', () => {
    // version 2.1 → derived major 2; override to 3
    expect(enforcementOf(run(fieldSuggestion(3), { currentMajor: 3 }))).toBe('must-fix'); // 3 <= 3
    expect(enforcementOf(run(fieldSuggestion(4), { currentMajor: 3 }))).toBe('warning'); // 4 > 3
  });

  it('applyVersionBucketing: false leaves no enforcement tag (faithful shape)', () => {
    const r = run(fieldSuggestion(3), { applyVersionBucketing: false });
    expect(r.variations.fields[0].enforcement).toBeUndefined();
  });

  it('default version (CURRENT_DD_VERSION) buckets against major 2', () => {
    // omit version entirely → CURRENT_DD_VERSION (2.1) → currentMajor 2
    const future = computeVariationsV2({
      metadataReportJson: REPORT,
      referenceMetadata: REF,
      suggestionsMap: fieldSuggestion(3),
      fuzziness: FUZZINESS,
    }) as ReturnType<typeof run>;
    expect(future.variations.fields[0].enforcement).toBe('warning'); // 3 > 2

    const now = computeVariationsV2({
      metadataReportJson: REPORT,
      referenceMetadata: REF,
      suggestionsMap: fieldSuggestion(2),
      fuzziness: FUZZINESS,
    }) as ReturnType<typeof run>;
    expect(now.variations.fields[0].enforcement).toBe('must-fix'); // 2 <= 2
  });
});
