/**
 * Variations suggestions CSV → ingest items.
 *
 * Ports the legacy `convertVariationsCsvToJson` (src/legacy/lib/variations/utils.js)
 * into the TS SDK and hardens it for the admin-write path. The legacy converter
 * matched headers by loose substring, split rows on a bare comma (so a value
 * containing a comma corrupted the row), and dropped unrecognized columns and
 * malformed rows silently — all of which let a bad file half-submit against a
 * store that overwrites canonical data. This version:
 *
 *  - matches headers by exact (case-insensitive, trimmed) name, not substring;
 *  - tokenizes quote-aware (RFC-4180-ish: embedded commas, "" escapes, CRLF/LF);
 *  - requires the `Resource Name` identity column and a `Resource Name` value on
 *    every row, failing loud with the offending row number; and
 *  - returns a recognized-vs-skipped column report so a header typo surfaces.
 *
 * The item shape matches what `POST /v2/certification/variations` ingests.
 */

/** One suggestion row: the identity, plus a suggestion or an outcome. */
export interface VariationSuggestionItem {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  readonly suggestedLookupValue?: string;
  readonly suggestedRelatedResourceName?: string;
  readonly suggestedRelatedFieldName?: string;
  readonly suggestedRelatedLookupValue?: string;
  readonly outcome?: string;
}

/** Canonical columns, in the legacy sheet order. A header cell must equal one `header` (trimmed, case-insensitive). */
const COLUMNS: ReadonlyArray<{ readonly header: string; readonly field: keyof VariationSuggestionItem }> = [
  { header: 'Resource Name', field: 'resourceName' },
  { header: 'Field Name', field: 'fieldName' },
  { header: 'Lookup Value', field: 'lookupValue' },
  { header: 'Suggested Resource Name', field: 'suggestedResourceName' },
  { header: 'Suggested Field Name', field: 'suggestedFieldName' },
  { header: 'Suggested Lookup Value', field: 'suggestedLookupValue' },
  { header: 'Suggested Related Resource Name', field: 'suggestedRelatedResourceName' },
  { header: 'Suggested Related Field Name', field: 'suggestedRelatedFieldName' },
  { header: 'Suggested Related Lookup Value', field: 'suggestedRelatedLookupValue' },
  { header: 'Outcome', field: 'outcome' },
];

export interface ParsedVariationsCsv {
  readonly items: ReadonlyArray<VariationSuggestionItem>;
  /** Canonical column names matched in the header. */
  readonly recognizedColumns: ReadonlyArray<string>;
  /** Non-empty header cells that matched no known column. */
  readonly skippedColumns: ReadonlyArray<string>;
}

/**
 * Quote-aware CSV tokenizer (RFC-4180-ish): honors quoted fields with embedded
 * commas and newlines, `""` escapes, and CRLF or LF line endings. Uses a small
 * local state machine — the one place a char-stream reads clearest — whose
 * mutable state is scoped to this function and never leaks. The imperative scan
 * is deliberate: it keeps tokenization O(n), where an immutable-accumulator
 * reduce would grow the field/row/rows arrays by spread and run O(n²) on a large
 * suggestions file.
 */
const tokenizeCsv = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // Close the record on LF; swallow the LF of a CRLF pair.
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw new Error('Variations CSV has an unterminated quoted field — a value opened with a quote that never closes.');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

const isComplete = (item: Partial<VariationSuggestionItem>): item is VariationSuggestionItem =>
  typeof item.resourceName === 'string' && item.resourceName.length > 0;

/**
 * Parse a variations suggestions CSV into ingest items. Throws with a specific
 * message (bad header, missing identity column, or the row number missing a
 * Resource Name) rather than dropping content silently.
 */
export const parseVariationsCsv = (csvData: string): ParsedVariationsCsv => {
  const rows = tokenizeCsv(csvData.trim());
  if (rows.length === 0) {
    throw new Error('Variations CSV is empty.');
  }

  const [headerRow, ...dataRows] = rows;
  const recognized: string[] = [];
  const skipped: string[] = [];
  const fieldByIndex: ReadonlyArray<keyof VariationSuggestionItem | undefined> = headerRow.map((cell) => {
    const name = cell.trim();
    const column = COLUMNS.find((c) => c.header.toLowerCase() === name.toLowerCase());
    if (column) {
      recognized.push(column.header);
      return column.field;
    }
    if (name !== '') skipped.push(name);
    return undefined;
  });

  if (!recognized.includes('Resource Name')) {
    throw new Error(
      `Variations CSV must include a "Resource Name" column. ` +
        `Recognized: [${recognized.join(', ')}]` +
        (skipped.length ? `; unrecognized: [${skipped.join(', ')}]` : '') +
        '.',
    );
  }

  const items = dataRows.flatMap((cells, index) => {
    // +2: the header is row 1, and dataRows are 0-indexed. Computed from the
    // original position so blank-row skipping never drifts the reported number.
    const rowNumber = index + 2;
    if (cells.every((value) => value.trim() === '')) return [];
    if (cells.length > headerRow.length) {
      throw new Error(
        `Variations CSV row ${rowNumber} has ${cells.length} columns but the header has ${headerRow.length} — check for an unquoted comma.`,
      );
    }
    const item = fieldByIndex.reduce<Partial<VariationSuggestionItem>>((acc, field, i) => {
      const value = cells[i]?.trim();
      return field && value ? { ...acc, [field]: value } : acc;
    }, {});
    if (!isComplete(item)) {
      throw new Error(`Variations CSV row ${rowNumber} is missing a Resource Name.`);
    }
    if (!item.outcome && !item.suggestedResourceName) {
      throw new Error(
        `Variations CSV row ${rowNumber} has neither a suggestion (Suggested Resource Name) nor an Outcome — it would do nothing.`,
      );
    }
    return [item];
  });

  if (items.length === 0) {
    throw new Error('Variations CSV has a header but no suggestion rows.');
  }

  return { items, recognizedColumns: recognized, skippedColumns: skipped };
};
