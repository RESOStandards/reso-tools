import { describe, expect, it } from 'vitest';
import { parseVariationsCsv } from '../../src/variations/csv.js';

describe('parseVariationsCsv', () => {
  it('parses a basic suggestion CSV into items', () => {
    const csv = ['Resource Name,Field Name,Suggested Resource Name,Suggested Field Name', 'Property,ListPriceX,Property,ListPrice'].join(
      '\n'
    );
    const { items, recognizedColumns, skippedColumns } = parseVariationsCsv(csv);
    expect(items).toEqual([
      { resourceName: 'Property', fieldName: 'ListPriceX', suggestedResourceName: 'Property', suggestedFieldName: 'ListPrice' }
    ]);
    expect(recognizedColumns).toEqual(['Resource Name', 'Field Name', 'Suggested Resource Name', 'Suggested Field Name']);
    expect(skippedColumns).toEqual([]);
  });

  it("reads a Strategy column as the mapping's provenance", () => {
    // The CLI is the whole surface for anyone without the desktop, so a suggestion's provenance
    // has to survive a trip through the sheet. Before this column it was dropped on parse and the
    // reviewer saw a mapping with no indication of where it came from.
    const csv = [
      'Resource Name,Field Name,Suggested Resource Name,Suggested Field Name,Strategy',
      'Property,ListPriceX,Property,ListPrice,Substring',
      'Property,RoofX,Property,Roof,Fast Track'
    ].join('\n');

    const { items, recognizedColumns, skippedColumns } = parseVariationsCsv(csv);
    expect(items.map(i => i.strategy)).toEqual(['Substring', 'Fast Track']);
    expect(recognizedColumns).toContain('Strategy');
    expect(skippedColumns).toEqual([]);
  });

  it('leaves strategy absent when the sheet omits the column', () => {
    // Absent, not an empty string or a placeholder. A row that says nothing about provenance is
    // not a row asserting it has none.
    const { items } = parseVariationsCsv('Resource Name,Suggested Resource Name,Suggested Field Name\nProperty,Property,ListPrice');
    expect(items[0]).not.toHaveProperty('strategy');
  });

  it('accepts a suggestion named by field alone, with no Suggested Resource Name', () => {
    // A same-resource mapping names only the field, so the pool stores `{suggestedFieldName}` and
    // the desktop export leaves Suggested Resource Name empty. 14 of 17 rows in a real export did.
    // The guard tested that one column alone, so the desktop's own sheet could not be read back
    // by the CLI at all: "row 2 has neither a suggestion nor an Outcome".
    const csv = ['Resource Name,Field Name,Suggested Field Name', 'Property,PricePerSquareFoot,LeasePricePerSquareFoot'].join('\n');
    const { items } = parseVariationsCsv(csv);
    expect(items[0]).toMatchObject({ resourceName: 'Property', suggestedFieldName: 'LeasePricePerSquareFoot' });
  });

  it('accepts a suggestion named by lookup value alone', () => {
    const csv = ['Resource Name,Field Name,Lookup Value,Suggested Lookup Value', 'Property,Heating,Gas,Natural Gas'].join('\n');
    expect(parseVariationsCsv(csv).items[0]).toMatchObject({ suggestedLookupValue: 'Natural Gas' });
  });

  it('accepts an expansion named by its related coordinates alone', () => {
    const csv = [
      'Resource Name,Field Name,Suggested Related Resource Name,Suggested Related Field Name',
      'Property,Rooms,Room,RoomType'
    ].join('\n');
    expect(parseVariationsCsv(csv).items[0]).toMatchObject({ suggestedRelatedResourceName: 'Room' });
  });

  it('still refuses a row that names no suggestion and carries no outcome', () => {
    // The guard's intent is right and stays: a row that says nothing does nothing.
    expect(() => parseVariationsCsv('Resource Name,Field Name\nProperty,PricePerSquareFoot')).toThrow(
      /row 2 \(Property\.PricePerSquareFoot\) names no suggestion/
    );
  });

  it('keeps the lookup coordinates the desktop export writes', () => {
    // A lookup mapping is named by the standard value or the legacy OData value. The sheet
    // recognized neither, so both were reported as skipped and a lookup mapping could not survive
    // a round trip through the file the CLI reads back.
    const csv = [
      'Resource Name,Field Name,Lookup Value,Suggested Field Name,Suggested Standard Lookup Value,Suggested Legacy OData Value',
      'Property,Heating,Gas,Heating,Natural Gas,NaturalGas'
    ].join('\n');
    const { items, skippedColumns } = parseVariationsCsv(csv);
    expect(items[0]).toMatchObject({
      suggestedStandardLookupValue: 'Natural Gas',
      suggestedLegacyODataValue: 'NaturalGas'
    });
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
      /row 3 is missing a Resource Name/
    );
  });

  it('throws on an unterminated quoted field', () => {
    expect(() => parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,"Office\nOffice,Bar')).toThrow(
      /unterminated quoted field/
    );
  });

  it('throws when a row has more columns than the header', () => {
    expect(() => parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,A,B')).toThrow(
      /row 2 has 3 columns but the header has 2/
    );
  });

  it('throws on a bare-identity row with no suggestion or outcome', () => {
    expect(() => parseVariationsCsv('Resource Name,Field Name\nProperty,Foo')).toThrow(/row 2 \(Property\.Foo\) names no suggestion/);
  });

  it('skips fully blank rows and keeps accurate row numbers', () => {
    const { items } = parseVariationsCsv('Resource Name,Suggested Resource Name\nProperty,X\n\nOffice,Y');
    expect(items).toHaveLength(2);
    expect(items.map(i => i.resourceName)).toEqual(['Property', 'Office']);
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
