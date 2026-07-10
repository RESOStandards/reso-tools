import { describe, it, expect } from 'vitest';
import { parseVariationsCsv } from '../../src/variations/csv.js';

describe('parseVariationsCsv', () => {
  it('parses a basic suggestion CSV into items', () => {
    const csv = [
      'Resource Name,Field Name,Suggested Resource Name,Suggested Field Name',
      'Property,ListPriceX,Property,ListPrice',
    ].join('\n');
    const { items, recognizedColumns, skippedColumns } = parseVariationsCsv(csv);
    expect(items).toEqual([
      { resourceName: 'Property', fieldName: 'ListPriceX', suggestedResourceName: 'Property', suggestedFieldName: 'ListPrice' },
    ]);
    expect(recognizedColumns).toEqual(['Resource Name', 'Field Name', 'Suggested Resource Name', 'Suggested Field Name']);
    expect(skippedColumns).toEqual([]);
  });

  it('matches headers case-insensitively and trims them', () => {
    const { items, recognizedColumns } = parseVariationsCsv('resource name , SUGGESTED RESOURCE NAME\nProperty,Office');
    expect(items).toEqual([{ resourceName: 'Property', suggestedResourceName: 'Office' }]);
    expect(recognizedColumns).toEqual(['Resource Name', 'Suggested Resource Name']);
  });

  it('handles quoted fields with embedded commas', () => {
    const { items } = parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,"A, B, C"');
    expect(items[0]?.suggestedResourceName).toBe('A, B, C');
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    const { items } = parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,"a ""quoted"" value"');
    expect(items[0]?.suggestedResourceName).toBe('a "quoted" value');
  });

  it('reports unrecognized columns instead of dropping them silently', () => {
    const { items, skippedColumns } = parseVariationsCsv('Resource Name,Bogus Column,Outcome\nProperty,x,Ignored');
    expect(skippedColumns).toEqual(['Bogus Column']);
    expect(items).toEqual([{ resourceName: 'Property', outcome: 'Ignored' }]);
  });

  it('throws when the Resource Name column is absent', () => {
    expect(() => parseVariationsCsv('Field Name,Suggested Field Name\nFoo,Bar')).toThrow(/must include a "Resource Name" column/);
  });

  it('throws, with the row number, when a row is missing a Resource Name', () => {
    expect(() => parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,Office\n,Bar')).toThrow(
      /row 3 is missing a Resource Name/,
    );
  });

  it('throws on an unterminated quoted field', () => {
    expect(() => parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,"Office\nOffice,Bar')).toThrow(
      /unterminated quoted field/,
    );
  });

  it('throws when a row has more columns than the header', () => {
    expect(() => parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,A,B')).toThrow(
      /row 2 has 3 columns but the header has 2/,
    );
  });

  it('throws on a bare-identity row with no suggestion or outcome', () => {
    expect(() => parseVariationsCsv('Resource Name,Field Name\nProperty,Foo')).toThrow(
      /row 2 has neither a suggestion .* nor an Outcome/,
    );
  });

  it('skips fully blank rows and keeps accurate row numbers', () => {
    const { items } = parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,X\n\nOffice,Y');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.resourceName)).toEqual(['Property', 'Office']);
  });

  it('handles CRLF line endings', () => {
    const { items } = parseVariationsCsv('Resource Name,Suggested Resource Name\r\nProperty,Office\r\n');
    expect(items).toEqual([{ resourceName: 'Property', suggestedResourceName: 'Office' }]);
  });

  it('carries the Outcome column for ignored rows', () => {
    const { items } = parseVariationsCsv('Resource Name,Field Name,Outcome\nProperty,Foo,Ignored');
    expect(items[0]).toEqual({ resourceName: 'Property', fieldName: 'Foo', outcome: 'Ignored' });
  });

  it('throws on an empty CSV', () => {
    expect(() => parseVariationsCsv('')).toThrow(/empty/);
  });

  it('throws on a header with no data rows', () => {
    expect(() => parseVariationsCsv('Resource Name,Field Name')).toThrow(/no suggestion rows/);
  });
});
