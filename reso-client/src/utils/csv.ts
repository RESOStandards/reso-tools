/**
 * CSV serialization helpers — RFC 4180-style escaping that works with
 * Google Sheets, Excel, and other spreadsheet tools. Quotes any field
 * containing commas, double quotes, line breaks, or leading/trailing
 * whitespace; internal double quotes are doubled.
 *
 * Pure functions, no Node or browser deps — safe to use anywhere.
 */

export const escapeCsvField = (value: string | undefined | null): string => {
  if (value == null) return '';
  const s = String(value);
  if (s === '') return '';
  const needsQuoting = /[",\r\n]/.test(s) || s !== s.trim();
  if (!needsQuoting) return s;
  return `"${s.replace(/"/g, '""')}"`;
};

export const rowsToCsv = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | undefined | null>>
): string => {
  const headerLine = headers.map(escapeCsvField).join(',');
  const dataLines = rows.map(row => row.map(escapeCsvField).join(','));
  return [headerLine, ...dataLines].join('\n');
};

/**
 * Parse an RFC 4180-style CSV string into rows of cells.
 *
 * Handles:
 *   - Quoted fields containing commas, double-quotes (doubled), and
 *     newlines.
 *   - CRLF, LF, or CR line endings.
 *   - Trailing empty line on the source (ignored).
 *   - An empty input (returns `[]`).
 *
 * Returns one `string[]` per row including the header row. Cell
 * values are returned verbatim — caller maps to typed records as
 * needed.
 *
 * Inverse of `rowsToCsv` for round-trips through a CSV file. Tested
 * against output from Google Sheets and Excel.
 */
export const csvToRows = (csv: string): ReadonlyArray<ReadonlyArray<string>> => {
  if (!csv) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < csv.length) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        // Doubled-quote inside a quoted field = literal `"`.
        if (csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      // Push the pending field, push the pending row, swallow CRLF
      // pair as one line terminator.
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && csv[i + 1] === '\n') {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    field += ch;
    i += 1;
  }
  // Final field / row (only if there was any content past the last newline).
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};
