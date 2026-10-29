/**
 * Plain-text tables for CLI output: one header row, a rule, then one line per row, each column as wide
 * as its widest cell. Shared by the commands that print rows, so they all read the same way.
 */

/** A value as a table cell. Anything absent shows as `-`, so an empty column is visibly empty. */
export const cell = (value: unknown): string => (value === undefined || value === null || value === '' ? '-' : String(value));

const pad = (value: string, width: number): string => value.padEnd(width);

export const renderTable = (headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: ReadonlyArray<string>): string =>
    cells
      .map((c, i) => pad(c, widths[i]))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n');
};
