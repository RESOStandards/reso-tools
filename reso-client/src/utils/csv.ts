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
