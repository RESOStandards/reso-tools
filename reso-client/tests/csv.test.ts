/**
 * Tests for the CSV utilities — round-trip parse + stringify, RFC 4180
 * edge cases (quoted fields, embedded delimiters, CRLF), and the
 * variations-CSV schema-specific path.
 */

import { describe, it, expect } from 'vitest';
import {
  escapeCsvField,
  rowsToCsv,
  csvToRows,
  variationsToCsv,
  csvToVariations,
  type VariationCsvRow,
} from '../src/index.js';

describe('escapeCsvField', () => {
  it('returns plain strings unchanged', () => {
    expect(escapeCsvField('Property')).toBe('Property');
  });

  it('quotes fields containing commas', () => {
    expect(escapeCsvField('one, two')).toBe('"one, two"');
  });

  it('quotes fields containing double quotes and doubles them', () => {
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('quotes fields containing newlines', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('quotes fields with leading or trailing whitespace', () => {
    expect(escapeCsvField('  padded  ')).toBe('"  padded  "');
  });

  it('returns empty string for null/undefined/empty inputs', () => {
    expect(escapeCsvField(undefined)).toBe('');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField('')).toBe('');
  });
});

describe('rowsToCsv ↔ csvToRows round-trip', () => {
  it('round-trips a simple row set', () => {
    const headers = ['a', 'b', 'c'];
    const rows = [['1', '2', '3'], ['x', 'y', 'z']];
    const csv = rowsToCsv(headers, rows);
    const parsed = csvToRows(csv);
    expect(parsed).toEqual([headers, ...rows]);
  });

  it('round-trips values with embedded commas + quotes + newlines', () => {
    const headers = ['col'];
    const rows = [['simple'], ['a, b'], ['he said "hi"'], ['line1\nline2']];
    const csv = rowsToCsv(headers, rows);
    const parsed = csvToRows(csv);
    expect(parsed).toEqual([headers, ...rows]);
  });

  it('treats undefined / null cells as empty', () => {
    const headers = ['a', 'b'];
    const rows = [[undefined, 'x'], [null, 'y']];
    const csv = rowsToCsv(headers, rows);
    expect(csv).toBe('a,b\n,x\n,y');
  });

  it('returns empty list for empty input', () => {
    expect(csvToRows('')).toEqual([]);
  });

  it('parses CRLF-delimited input', () => {
    expect(csvToRows('a,b\r\n1,2\r\n3,4')).toEqual([['a','b'],['1','2'],['3','4']]);
  });
});

describe('csvToRows edge cases', () => {
  it('ignores a trailing newline', () => {
    expect(csvToRows('a,b\n1,2\n')).toEqual([['a','b'],['1','2']]);
  });

  it('preserves empty trailing fields', () => {
    expect(csvToRows('a,b,c\n1,,')).toEqual([['a','b','c'],['1','','']]);
  });
});

describe('variationsToCsv ↔ csvToVariations round-trip', () => {
  const rows: ReadonlyArray<VariationCsvRow> = [
    {
      resourceName: 'Property',
      fieldName: 'MlgCanView',
      lookupValue: undefined,
      suggestedResourceName: undefined,
      suggestedFieldName: 'View',
      suggestedLookupValue: undefined,
      suggestedStandardLookupValue: undefined,
      suggestedLegacyODataValue: undefined,
      suggestedRelatedResourceName: undefined,
      suggestedRelatedFieldName: undefined,
      suggestedRelatedLookupValue: undefined,
      outcome: 'Fast Track',
      comments: 'fuzzy match: "MlgCanView" within 25 % of length to "View"',
    },
    {
      resourceName: 'Property',
      fieldName: 'StandardStatus',
      lookupValue: 'Active, Pending', // comma in value
      outcome: 'Ignore',
    },
  ];

  it('serializes and re-parses to the same set', () => {
    const csv = variationsToCsv(rows);
    const result = csvToVariations(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows.length).toBe(rows.length);
    expect(result.rows[0].resourceName).toBe('Property');
    expect(result.rows[0].fieldName).toBe('MlgCanView');
    expect(result.rows[0].suggestedFieldName).toBe('View');
    expect(result.rows[0].outcome).toBe('Fast Track');
    expect(result.rows[0].comments).toBe('fuzzy match: "MlgCanView" within 25 % of length to "View"');
    expect(result.rows[1].lookupValue).toBe('Active, Pending');
    expect(result.rows[1].comments).toBeUndefined();
  });

  it('parses 10-column legacy CSV (no Comments column) without error', () => {
    const legacyCsv = 'Resource Name,Field Name,Lookup Value,Suggested Resource Name,Suggested Field Name,Suggested Lookup Value,Suggested Related Resource Name,Suggested Related Field Name,Suggested Related Lookup Value,Outcome\nProperty,StandardStatus,,,,Active,,,,Fast Track';
    const result = csvToVariations(legacyCsv);
    expect(result.errors).toEqual([]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].resourceName).toBe('Property');
    expect(result.rows[0].outcome).toBe('Fast Track');
    expect(result.rows[0].comments).toBeUndefined();
    expect(result.rows[0].suggestedStandardLookupValue).toBeUndefined();
    expect(result.rows[0].suggestedLegacyODataValue).toBeUndefined();
  });

  it('round-trips the explicit Standard/Legacy OData suggestion columns', () => {
    const rows: ReadonlyArray<VariationCsvRow> = [
      {
        resourceName: 'Property',
        fieldName: 'Possession',
        lookupValue: 'CloseOfEscrow',
        suggestedResourceName: 'Property',
        suggestedFieldName: 'Possession',
        suggestedStandardLookupValue: 'Close Of Escrow',
        suggestedLegacyODataValue: 'CloseOfEscrow',
        outcome: 'RESO',
        comments: "input already matches canonical LegacyODataValue='CloseOfEscrow'",
      },
    ];
    const csv = variationsToCsv(rows);
    const result = csvToVariations(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0].suggestedStandardLookupValue).toBe('Close Of Escrow');
    expect(result.rows[0].suggestedLegacyODataValue).toBe('CloseOfEscrow');
    expect(result.rows[0].outcome).toBe('RESO');
  });
});

describe('csvToVariations validation', () => {
  it('returns an error for an empty CSV', () => {
    const result = csvToVariations('');
    expect(result.rows).toEqual([]);
    expect(result.errors[0].message).toMatch(/empty/i);
  });

  it('returns an error if the header is missing Resource Name', () => {
    const result = csvToVariations('Foo,Bar\nx,y');
    expect(result.rows).toEqual([]);
    expect(result.errors[0].message).toMatch(/Resource Name/i);
  });

  it('skips rows missing required Resource Name', () => {
    const csv = 'Resource Name,Field Name\nProperty,Foo\n,Bar';
    const result = csvToVariations(csv);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].resourceName).toBe('Property');
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].line).toBe(3);
  });

  it('tolerates unknown columns', () => {
    const csv = 'Resource Name,Extra,Field Name\nProperty,ignored,Foo';
    const result = csvToVariations(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0].resourceName).toBe('Property');
    expect(result.rows[0].fieldName).toBe('Foo');
  });

  it('is case-insensitive on header names', () => {
    const csv = 'resource name,FIELD NAME\nProperty,Foo';
    const result = csvToVariations(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0].fieldName).toBe('Foo');
  });

  it('ignores trailing blank rows (Excel often appends them)', () => {
    const csv = 'Resource Name,Field Name\nProperty,Foo\n,\n,';
    const result = csvToVariations(csv);
    expect(result.rows.length).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
