/**
 * Golden-master coverage — field-level machine matching.
 *
 * Ported from cert-utils `test/variations.js` (de-randomized, mocha→vitest):
 *   - one-character differences flag as `closeMatch`
 *   - a standard field is suggested when not already present (substring)
 *   - a standard field is NOT suggested when the provider already has it
 *   - and when a local field still matches, the already-present standard is
 *     excluded from its suggestions
 *
 * Oracle: legacy `computeVariations` (src/legacy).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const FUZZINESS = 0.25;
const DD_1_7 = '1.7';

type FieldVariation = { resourceName: string; fieldName: string; suggestions: Array<{ suggestedFieldName?: string; closeMatch?: boolean }> };

const fieldsOf = async (metadataReportJson: unknown): Promise<FieldVariation[]> => {
  const { variations } = (await computeVariations({ metadataReportJson, fuzziness: FUZZINESS, version: DD_1_7 })) as {
    variations: { fields: FieldVariation[] };
  };
  return variations.fields ?? [];
};

describe('computeVariations: field-level machine matching', () => {
  it('flags one-character differences as close matches', async () => {
    const report = {
      fields: [
        { resourceName: 'Property', fieldName: 'ListtPrice' },
        { resourceName: 'Property', fieldName: 'CancelationDate' },
        { resourceName: 'Office', fieldName: 'MoodificationTimestamp' },
        { resourceName: 'Member', fieldName: 'MemmberEmail' },
      ],
    };
    const fields = await fieldsOf(report);
    expect(fields).toHaveLength(report.fields.length);
    for (const f of fields) {
      expect(f.suggestions.some((s) => s.closeMatch)).toBe(true);
    }
  });

  it('suggests a standard field when it is not already present', async () => {
    const fields = await fieldsOf({ fields: [{ resourceName: 'Property', fieldName: 'APIModificationTimestamp' }] });
    const hits = fields.filter((f) => f.fieldName === 'APIModificationTimestamp');
    expect(hits).toHaveLength(1);
    expect(hits[0].suggestions.some((s) => s.suggestedFieldName === 'ModificationTimestamp')).toBe(true);
  });

  it('does not suggest a standard field the provider already has', async () => {
    const fields = await fieldsOf({
      fields: [
        { resourceName: 'Property', fieldName: 'APIModificationTimestamp' },
        { resourceName: 'Property', fieldName: 'ModificationTimestamp' },
      ],
    });
    expect(fields.filter((f) => f.fieldName === 'APIModificationTimestamp')).toHaveLength(0);
  });

  it('excludes an already-present standard from a still-matching local field’s suggestions', async () => {
    const fields = await fieldsOf({
      fields: [
        { resourceName: 'Property', fieldName: 'Price' },
        { resourceName: 'Property', fieldName: 'ListPrice' },
      ],
    });
    const hits = fields.filter((f) => f.fieldName === 'Price');
    expect(hits).toHaveLength(1);
    expect(hits[0].suggestions.length).toBeGreaterThan(0);
    expect(hits[0].suggestions.some((s) => s.suggestedFieldName === 'ListPrice')).toBe(false);
  });
});
