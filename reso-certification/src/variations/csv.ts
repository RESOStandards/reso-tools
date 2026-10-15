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
  /** The display-name form the live dd.reso.org routes use, and the legacy OData form. A lookup
   *  mapping is named by one of these, so a sheet that drops them cannot carry one. */
  readonly suggestedStandardLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly suggestedRelatedResourceName?: string;
  readonly suggestedRelatedFieldName?: string;
  readonly suggestedRelatedLookupValue?: string;
  /** How the matcher arrived at the suggested mapping: Substring, Edit Distance, Fast Track,
   *  Admin Review. Carried through the sheet so a reviewer can weigh a suggestion without
   *  leaving the CSV, and so the provenance survives a round trip through it. */
  readonly strategy?: string;
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
  { header: 'Suggested Standard Lookup Value', field: 'suggestedStandardLookupValue' },
  { header: 'Suggested Legacy OData Value', field: 'suggestedLegacyODataValue' },
  { header: 'Suggested Related Resource Name', field: 'suggestedRelatedResourceName' },
  { header: 'Suggested Related Field Name', field: 'suggestedRelatedFieldName' },
  { header: 'Suggested Related Lookup Value', field: 'suggestedRelatedLookupValue' },
  { header: 'Strategy', field: 'strategy' },
  { header: 'Outcome', field: 'outcome' }
];

/**
 * The columns that NAME a suggested target. Any one of them makes a row actionable.
 *
 * The guard used to test `suggestedResourceName` alone. A same-resource mapping names only the
 * field, so the pool stores `{suggestedFieldName}` and the desktop export leaves the resource
 * column empty: 14 of 17 rows in a real export did. The desktop's own sheet therefore could not
 * be read back by the CLI, which is the one path that has to work for anyone without a desktop
 * client, since the decisions workflow round-trips through this file.
 */
const SUGGESTION_FIELDS: ReadonlyArray<keyof VariationSuggestionItem> = [
  'suggestedResourceName',
  'suggestedFieldName',
  'suggestedLookupValue',
  'suggestedStandardLookupValue',
  'suggestedLegacyODataValue',
  'suggestedRelatedResourceName',
  'suggestedRelatedFieldName',
  'suggestedRelatedLookupValue'
];

/** True when the row names a target at all, by any coordinate. */
const namesASuggestion = (item: Partial<VariationSuggestionItem>): boolean =>
  SUGGESTION_FIELDS.some(field => {
    const value = item[field];
    return typeof value === 'string' && value.length > 0;
  });

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

// ── Decision sheets ──────────────────────────────────────────────────

/**
 * One decision-sheet row: which element, optionally what to do, optionally what to say.
 *
 * A DIFFERENT sheet from the update sheet above, and deliberately a different parser. An update row
 * carries an `Outcome` and writes the CANONICAL store; a decision row carries an `Action` and a
 * `Comment` and drives a REVIEW — the pool row and the report's comment thread. Their validation
 * differs: an update row must carry an outcome or a suggestion, while a decision row may legitimately
 * carry a comment and no action.
 *
 * They share `tokenizeCsv` and nothing else. Relaxing `parseVariationsCsv`'s guard so one parser could
 * read both would let an operator submit an update sheet to the review route, or the reverse, and
 * receive a success report for the wrong thing.
 */
export interface DecisionCsvItem {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly action?: string;
  readonly comment?: string;
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  readonly suggestedLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly suggestedRelatedResourceName?: string;
  readonly suggestedRelatedFieldName?: string;
  readonly suggestedRelatedLookupValue?: string;
}

/**
 * No Strategy column here, deliberately.
 *
 * A decisions sheet NAMES an entry and says what to do with it; `applySheetToReport` attaches the
 * action to the matching entry of a report it was handed. The report's own suggestions already
 * carry their strategy, so provenance travels that path untouched. A column here would let an
 * operator type a provenance the path then ignores, which is worse than not offering it.
 */
const DECISION_COLUMNS: ReadonlyArray<{ readonly header: string; readonly field: keyof DecisionCsvItem }> = [
  { header: 'Resource Name', field: 'resourceName' },
  { header: 'Field Name', field: 'fieldName' },
  { header: 'Lookup Value', field: 'lookupValue' },
  { header: 'Action', field: 'action' },
  { header: 'Comment', field: 'comment' },
  { header: 'Suggested Resource Name', field: 'suggestedResourceName' },
  { header: 'Suggested Field Name', field: 'suggestedFieldName' },
  { header: 'Suggested Lookup Value', field: 'suggestedLookupValue' },
  { header: 'Suggested Legacy OData Value', field: 'suggestedLegacyODataValue' },
  { header: 'Suggested Related Resource Name', field: 'suggestedRelatedResourceName' },
  { header: 'Suggested Related Field Name', field: 'suggestedRelatedFieldName' },
  { header: 'Suggested Related Lookup Value', field: 'suggestedRelatedLookupValue' }
];

export interface ParsedDecisionsCsv {
  readonly items: ReadonlyArray<DecisionCsvItem>;
  readonly recognizedColumns: ReadonlyArray<string>;
  readonly skippedColumns: ReadonlyArray<string>;
}

/**
 * Parse a decision sheet. Throws with the offending row number rather than dropping content, for the
 * same reason the update parser does: a sheet that silently loses a row reports success for work that
 * never happened.
 */
export const parseDecisionsCsv = (csvData: string): ParsedDecisionsCsv => {
  const rows = tokenizeCsv(csvData.trim());
  if (rows.length === 0) throw new Error('Decision CSV is empty.');

  const [headerRow, ...dataRows] = rows;
  const recognized: string[] = [];
  const skipped: string[] = [];
  const fieldByIndex: ReadonlyArray<keyof DecisionCsvItem | undefined> = headerRow.map(cell => {
    const name = cell.trim();
    const column = DECISION_COLUMNS.find(c => c.header.toLowerCase() === name.toLowerCase());
    if (column) {
      recognized.push(column.header);
      return column.field;
    }
    if (name !== '') skipped.push(name);
    return undefined;
  });

  if (!recognized.includes('Resource Name')) {
    throw new Error(
      `Decision CSV must include a "Resource Name" column. Recognized: [${recognized.join(', ')}]${skipped.length ? `; unrecognized: [${skipped.join(', ')}]` : ''}.`
    );
  }

  const items = dataRows.flatMap((cells, index) => {
    // +2: the header is row 1 and dataRows are 0-indexed. Computed from the original position so
    // blank-row skipping never drifts the reported number.
    const rowNumber = index + 2;
    if (cells.every(value => value.trim() === '')) return [];
    if (cells.length > headerRow.length) {
      throw new Error(
        `Decision CSV row ${rowNumber} has ${cells.length} columns but the header has ${headerRow.length} — check for an unquoted comma.`
      );
    }
    const item = fieldByIndex.reduce<{ -readonly [K in keyof DecisionCsvItem]?: DecisionCsvItem[K] }>((acc, field, i) => {
      const value = cells[i]?.trim();
      if (field && value) acc[field] = value;
      return acc;
    }, {});
    if (typeof item.resourceName !== 'string' || item.resourceName.length === 0) {
      throw new Error(`Decision CSV row ${rowNumber} is missing a Resource Name.`);
    }
    if (!item.action && !item.comment) {
      throw new Error(`Decision CSV row ${rowNumber} has neither an Action nor a Comment — it names an element and asks for nothing.`);
    }
    return [item as DecisionCsvItem];
  });

  if (items.length === 0) throw new Error('Decision CSV has a header but no decision rows.');

  return { items, recognizedColumns: recognized, skippedColumns: skipped };
};

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
  const fieldByIndex: ReadonlyArray<keyof VariationSuggestionItem | undefined> = headerRow.map(cell => {
    const name = cell.trim();
    const column = COLUMNS.find(c => c.header.toLowerCase() === name.toLowerCase());
    if (column) {
      recognized.push(column.header);
      return column.field;
    }
    if (name !== '') skipped.push(name);
    return undefined;
  });

  if (!recognized.includes('Resource Name')) {
    throw new Error(
      `Variations CSV must include a "Resource Name" column. Recognized: [${recognized.join(', ')}]${skipped.length ? `; unrecognized: [${skipped.join(', ')}]` : ''}.`
    );
  }

  const items = dataRows.flatMap((cells, index) => {
    // +2: the header is row 1, and dataRows are 0-indexed. Computed from the
    // original position so blank-row skipping never drifts the reported number.
    const rowNumber = index + 2;
    if (cells.every(value => value.trim() === '')) return [];
    if (cells.length > headerRow.length) {
      throw new Error(
        `Variations CSV row ${rowNumber} has ${cells.length} columns but the header has ${headerRow.length} — check for an unquoted comma.`
      );
    }
    const item = fieldByIndex.reduce<{ -readonly [K in keyof VariationSuggestionItem]?: VariationSuggestionItem[K] }>((acc, field, i) => {
      const value = cells[i]?.trim();
      if (field && value) acc[field] = value;
      return acc;
    }, {});
    if (!isComplete(item)) {
      throw new Error(`Variations CSV row ${rowNumber} is missing a Resource Name.`);
    }
    if (!item.outcome && !namesASuggestion(item)) {
      // Name the element, not only the row. A row number alone sends someone counting lines in a
      // sheet of hundreds, and the usual cause is a pool row that never had a suggestion to begin
      // with, which is identified by what it names rather than by where it landed in the file.
      const element = [item.resourceName, item.fieldName, item.lookupValue].filter(Boolean).join('.');
      throw new Error(
        `Variations CSV row ${rowNumber} (${element}) names no suggestion and carries no Outcome — it would do nothing. ` +
          `Name the target with any of: ${SUGGESTION_FIELDS.map(f => COLUMNS.find(c => c.field === f)?.header ?? f).join(', ')}.`
      );
    }
    return [item];
  });

  if (items.length === 0) {
    throw new Error('Variations CSV has a header but no suggestion rows.');
  }

  return { items, recognizedColumns: recognized, skippedColumns: skipped };
};
