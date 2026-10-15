/**
 * The decision sheet parser.
 *
 * A DIFFERENT sheet from the update sheet, deliberately, even though both name an element and both are
 * read by `tokenizeCsv`. An update sheet carries an `Outcome` and writes the CANONICAL store; a decision
 * sheet carries an `Action` and a `Comment` and drives a REVIEW — the pool row and the report's comment
 * thread. Their validation differs too: an update row must carry an outcome or a suggestion, while a
 * decision row may legitimately carry a comment and no action at all.
 *
 * Keeping them separate is the point. `parseVariationsCsv`'s guard is real, and relaxing it so one
 * parser could read both sheets would let an operator submit an update sheet to the review route, or the
 * reverse, and get a success report for the wrong thing.
 */

import { describe, expect, it } from 'vitest';
import { parseDecisionsCsv } from '../../src/variations/csv.js';

const sheet = (body: string) => `Resource Name,Field Name,Lookup Value,Action,Comment\n${body}`;

describe('parseDecisionsCsv', () => {
  it('parses the identity columns plus Action and Comment', () => {
    const { items } = parseDecisionsCsv(sheet('Property,LeaseTerm,Months - 4,submit-to-ft,DD has no 4-month term\n'));
    expect(items).toEqual([
      {
        resourceName: 'Property',
        fieldName: 'LeaseTerm',
        lookupValue: 'Months - 4',
        action: 'submit-to-ft',
        comment: 'DD has no 4-month term'
      }
    ]);
  });

  it('accepts an action with no comment', () => {
    const { items } = parseDecisionsCsv(sheet('Property,OKC_SoilType,,ignore,\n'));
    expect(items).toEqual([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }]);
  });

  it('accepts a comment with no action, since a comment alone is worth recording', () => {
    const { items } = parseDecisionsCsv(sheet('Property,Roof,Steel,,Which steel construction?\n'));
    expect(items).toEqual([{ resourceName: 'Property', fieldName: 'Roof', lookupValue: 'Steel', comment: 'Which steel construction?' }]);
  });

  it('refuses a sheet where no row asks for anything', () => {
    // Updated 2026-10-15. This used to be a row-level error. Deciding on a SUBSET is the normal
    // case once a review can be exported, so an undecided row is now reported rather than fatal.
    // A sheet where NOTHING is decided is still refused, because nothing would be submitted.
    expect(() => parseDecisionsCsv(sheet('Property,Roof,Steel,,\n'))).toThrow(/no Action or Comment on any row/);
  });

  it('reports an undecided row by name instead of dropping it quietly', () => {
    // The original objection to skipping was that a typo in the Action column would look like a
    // successful no-op. That objection is about silence, so the row is named.
    const { items, undecidedRows } = parseDecisionsCsv(sheet('Property,Roof,Steel,ignore,\nProperty,Heating,Gas,,\n'));
    expect(items).toHaveLength(1);
    expect(undecidedRows).toEqual(['Property.Heating.Gas']);
  });

  it('requires a Resource Name column', () => {
    expect(() => parseDecisionsCsv('Field Name,Action\nLeaseTerm,ignore\n')).toThrow(/Resource Name/i);
  });

  it('requires a Resource Name value on every row', () => {
    expect(() => parseDecisionsCsv(sheet(',LeaseTerm,Months - 4,ignore,\n'))).toThrow(/row 2/i);
  });

  it('reports unrecognized columns rather than ignoring them silently', () => {
    const { recognizedColumns, skippedColumns } = parseDecisionsCsv('Resource Name,Action,Notes For Me\nProperty,ignore,whatever\n');
    expect(recognizedColumns).toContain('Action');
    expect(skippedColumns).toEqual(['Notes For Me']);
  });

  it('preserves a comment containing a comma, when quoted', () => {
    const { items } = parseDecisionsCsv(
      sheet('Property,LeaseTerm,Months - 4,submit-to-ft,"No 4-month term, and the format is undecided"\n')
    );
    expect(items[0].comment).toBe('No 4-month term, and the format is undecided');
  });

  it('preserves a lookup value exactly, spaces and case included', () => {
    const { items } = parseDecisionsCsv(sheet('Property,Roof,Standing Seam Steel,ignore,\n'));
    expect(items[0].lookupValue).toBe('Standing Seam Steel');
  });

  it('skips a wholly blank row without shifting the reported row number of a later error', () => {
    // A row with the wrong column count is still row-level, so the numbering guard still applies.
    expect(() => parseDecisionsCsv(sheet('\nProperty,LeaseTerm,Months - 4,ignore,a,b\n'))).toThrow(/row 3/i);
  });

  it('rejects a row with more columns than the header, which means an unquoted comma', () => {
    expect(() => parseDecisionsCsv(sheet('Property,LeaseTerm,Months - 4,ignore,a,b\n'))).toThrow(/unquoted comma/i);
  });

  it('does not accept an update sheet, whose rows ask for nothing', () => {
    // The guard that keeps the two sheets apart still holds: an update sheet's rows carry no
    // Action and no Comment, so none of them asks for anything and the sheet is refused.
    expect(() => parseDecisionsCsv('Resource Name,Field Name,Outcome\nProperty,MBR_Foo,Ignored\n')).toThrow(
      /no Action or Comment on any row/
    );
  });
});

/**
 * The export-edit-submit round trip.
 *
 * `list-variation-reviews --csv` writes the sheet, a person or an agent fills in the Action
 * column, and `submit-variation-decisions` reads it back. That loop is the whole review workflow
 * for anyone without the desktop client, so the file one side writes has to be the file the other
 * side reads, warning-free.
 */
describe('parseDecisionsCsv — the exported sheet', () => {
  it('accepts Comments, the spelling the desktop export writes', () => {
    // The decisions sheet calls it `Comment`; the desktop export writes `Comments`. The column was
    // therefore dropped, so a comment typed into an exported sheet was silently not submitted.
    const csv = ['Resource Name,Field Name,Action,Comments', 'Property,MBR_SoilType,ignore,looks right'].join('\n');
    const { items, skippedColumns } = parseDecisionsCsv(csv);
    expect(items[0]).toMatchObject({ action: 'ignore', comment: 'looks right' });
    expect(skippedColumns).toEqual([]);
  });

  it('does not warn about the context columns the export carries', () => {
    // Strategy, Status and Outcome are context for whoever is deciding. The push does not act on
    // them, but calling them "unrecognized" on every submit of our own sheet teaches people to
    // ignore the warning that exists to catch a real typo.
    const csv = [
      'Resource Name,Field Name,Suggested Field Name,Strategy,Status,Outcome,Action',
      'Property,MBR_SoilType,SoilType,Substring,pending,,ignore'
    ].join('\n');
    const { items, skippedColumns } = parseDecisionsCsv(csv);
    expect(skippedColumns).toEqual([]);
    expect(items[0]).toMatchObject({ action: 'ignore' });
  });

  it('still warns about a column that is a genuine typo', () => {
    const csv = ['Resource Name,Field Name,Action,Stratgy', 'Property,MBR_SoilType,ignore,Substring'].join('\n');
    expect(parseDecisionsCsv(csv).skippedColumns).toEqual(['Stratgy']);
  });

  it('says the sheet is unfilled when no row asks for anything', () => {
    // A freshly exported review has no Action anywhere. Reporting that as a problem with row 2
    // sends someone looking at row 2, when what happened is they have not filled it in yet.
    const csv = [
      'Resource Name,Field Name,Suggested Field Name,Action,Comment',
      'Property,MBR_SoilType,SoilType,,',
      'Property,MBR_YearRenovated,YearRenovated,,'
    ].join('\n');
    expect(() => parseDecisionsCsv(csv)).toThrow(/no Action or Comment on any row/);
  });

  it('leaves an undecided row alone and names it, when others are decided', () => {
    const csv = ['Resource Name,Field Name,Action', 'Property,MBR_SoilType,ignore', 'Property,MBR_YearRenovated,'].join('\n');
    const { items, undecidedRows } = parseDecisionsCsv(csv);
    expect(items.map(i => i.fieldName)).toEqual(['MBR_SoilType']);
    expect(undecidedRows).toEqual(['Property.MBR_YearRenovated']);
  });
});
