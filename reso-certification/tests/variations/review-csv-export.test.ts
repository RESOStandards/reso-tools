/**
 * `list-variation-reviews --csv`.
 *
 * The desktop client can export a review to a sheet; the CLI could only print a table or JSON.
 * That gap fell hardest on the people with no desktop client, because the decisions workflow
 * round-trips through a sheet: export, edit, `submit-variation-decisions`. Without an export they
 * had to hand-build the file the CLI would read back.
 *
 * The round-trip is the real contract, so it is asserted directly against `parseVariationsCsv`
 * rather than by eyeballing the header.
 */

import { describe, expect, it } from 'vitest';
import { formatReviewItemsCsv } from '../../src/cli/variations-review-command.js';
import { parseVariationsCsv } from '../../src/variations/csv.js';
import type { VariationReviewItem } from '../../src/variations/review.js';

const item = (over: Partial<VariationReviewItem> = {}): VariationReviewItem =>
  ({
    variationKey: 'Property\u001FMBR_SoilType\u001F',
    resourceName: 'Property',
    fieldName: 'MBR_SoilType',
    status: 'pending',
    provenance: [],
    ...over
  }) as VariationReviewItem;

const rowsOf = (csv: string): ReadonlyArray<string> => csv.split('\n').slice(1);

describe('formatReviewItemsCsv', () => {
  it('carries the strategy, which neither side exported before', () => {
    const csv = formatReviewItemsCsv([item({ mapping: { suggestedFieldName: 'SoilType' }, strategy: 'Substring' })]);
    expect(csv.split('\n')[0]).toContain('Strategy');
    expect(rowsOf(csv)[0]).toContain('Substring');
  });

  it('round-trips through the parser the CLI reads back', () => {
    // The point of the export. A sheet that cannot be read back is not a workflow.
    const csv = formatReviewItemsCsv([
      item({
        fieldName: 'MBR_SoilType',
        mapping: { suggestedResourceName: 'Property', suggestedFieldName: 'SoilType' },
        strategy: 'Substring'
      })
    ]);
    const { items, skippedColumns } = parseVariationsCsv(csv);
    expect(items[0]).toMatchObject({
      resourceName: 'Property',
      fieldName: 'MBR_SoilType',
      suggestedResourceName: 'Property',
      suggestedFieldName: 'SoilType',
      strategy: 'Substring'
    });
    expect(skippedColumns).toEqual(['Status']);
  });

  it("writes an empty cell, not the table's dash", () => {
    // The table prints `-` as a reading aid. In a sheet that is read back it would be submitted
    // as the literal string "-", so the two renderings must not be shared.
    const csv = formatReviewItemsCsv([item({ mapping: { suggestedFieldName: 'SoilType' } })]);
    expect(rowsOf(csv)[0]).not.toContain('-');
    const { items } = parseVariationsCsv(csv);
    expect(items[0]).not.toHaveProperty('strategy');
  });

  it('quotes a value holding a comma, and survives the round trip', () => {
    const csv = formatReviewItemsCsv([item({ lookupValue: 'Other, See Remarks', mapping: { suggestedFieldName: 'Other' } })]);
    expect(rowsOf(csv)[0]).toContain('"Other, See Remarks"');
    expect(parseVariationsCsv(csv).items[0]?.lookupValue).toBe('Other, See Remarks');
  });

  it('escapes an embedded quote by doubling it', () => {
    const csv = formatReviewItemsCsv([item({ lookupValue: 'a "quoted" value', mapping: { suggestedFieldName: 'X' } })]);
    expect(parseVariationsCsv(csv).items[0]?.lookupValue).toBe('a "quoted" value');
  });

  it('reads the mapping rather than re-deriving it from the variation key', () => {
    const csv = formatReviewItemsCsv([
      item({
        mapping: {
          suggestedStandardLookupValue: 'Natural Gas',
          suggestedLegacyODataValue: 'NaturalGas',
          suggestedFieldName: 'Heating'
        },
        strategy: 'Fast Track'
      })
    ]);
    const row = rowsOf(csv)[0];
    expect(row).toContain('Natural Gas');
    expect(row).toContain('NaturalGas');
    expect(row).toContain('Fast Track');
  });

  it('emits a header and nothing else for an empty pool', () => {
    expect(formatReviewItemsCsv([]).split('\n')).toHaveLength(1);
  });
});
