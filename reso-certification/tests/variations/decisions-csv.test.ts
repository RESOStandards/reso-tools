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

import { describe, it, expect } from 'vitest';
import { parseDecisionsCsv } from '../../src/variations/csv.js';

const sheet = (body: string) => `Resource Name,Field Name,Lookup Value,Action,Comment\n${body}`;

describe('parseDecisionsCsv', () => {
  it('parses the identity columns plus Action and Comment', () => {
    const { items } = parseDecisionsCsv(
      sheet('Property,LeaseTerm,Months - 4,submit-to-ft,DD has no 4-month term\n')
    );
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
    expect(items).toEqual([
      { resourceName: 'Property', fieldName: 'Roof', lookupValue: 'Steel', comment: 'Which steel construction?' }
    ]);
  });

  it('rejects a row carrying neither an action nor a comment', () => {
    // Such a row names an element and asks for nothing. Silently skipping it would make a typo in the
    // Action column look like a successful no-op.
    expect(() => parseDecisionsCsv(sheet('Property,Roof,Steel,,\n'))).toThrow(/row 2 .*(action|comment)/i);
  });

  it('requires a Resource Name column', () => {
    expect(() => parseDecisionsCsv('Field Name,Action\nLeaseTerm,ignore\n')).toThrow(/Resource Name/i);
  });

  it('requires a Resource Name value on every row', () => {
    expect(() => parseDecisionsCsv(sheet(',LeaseTerm,Months - 4,ignore,\n'))).toThrow(/row 2/i);
  });

  it('reports unrecognized columns rather than ignoring them silently', () => {
    const { recognizedColumns, skippedColumns } = parseDecisionsCsv(
      'Resource Name,Action,Notes For Me\nProperty,ignore,whatever\n'
    );
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
    expect(() => parseDecisionsCsv(sheet('\nProperty,Roof,Steel,,\n'))).toThrow(/row 3/i);
  });

  it('rejects a row with more columns than the header, which means an unquoted comma', () => {
    expect(() => parseDecisionsCsv(sheet('Property,LeaseTerm,Months - 4,ignore,a,b\n'))).toThrow(/unquoted comma/i);
  });

  it('does not accept an update sheet, whose Outcome column it does not know', () => {
    // The guard that keeps the two sheets apart: an update sheet's rows carry no Action and no Comment.
    expect(() => parseDecisionsCsv('Resource Name,Field Name,Outcome\nProperty,MBR_Foo,Ignored\n')).toThrow(
      /row 2 .*(action|comment)/i
    );
  });
});
