/**
 * Variations report ↔ CSV. Defines the canonical 13-column schema
 * used by RESO variations submissions and provides round-trip
 * serialization that handles quoting/escaping properly (works with
 * Google Sheets, Excel, etc.) — unlike the older legacy split-on-
 * comma helpers, which fail the moment a value contains a comma.
 *
 * Two suggestion columns make the canonical form explicit:
 * - `Suggested Standard Lookup Value`: the StandardName annotation
 *   (human-friendly display form, e.g. "Close Of Escrow").
 * - `Suggested Legacy OData Value`: the LegacyODataValue (camelCase
 *   wire identifier, e.g. "CloseOfEscrow").
 *
 * Both forms are valid in RESO payloads. If a row's input matches
 * either form for the suggested canonical, that row should carry
 * `Outcome = RESO` — already a standard value, no correction needed.
 *
 * Backwards compatibility:
 * - `Suggested Lookup Value` is retained as the legacy single column.
 *   Web-client consumers still use it.
 * - `Comments` carries free-form rationale or notes per row.
 * - Older 10/11-column files still parse — both new columns and
 *   Comments are optional on import.
 *
 * Consumers: web-client variations review export, reso-certification
 * CLI ingest, mapping tools (RESO MCP server). Pure functions, no
 * Node or browser deps.
 */

import { csvToRows, rowsToCsv } from './csv.js';

export const VARIATIONS_CSV_COLUMNS = [
  'Resource Name',
  'Field Name',
  'Lookup Value',
  'Suggested Resource Name',
  'Suggested Field Name',
  'Suggested Lookup Value',
  'Suggested Standard Lookup Value',
  'Suggested Legacy OData Value',
  'Suggested Related Resource Name',
  'Suggested Related Field Name',
  'Suggested Related Lookup Value',
  'Outcome',
  'Comments',
] as const;

export interface VariationCsvRow {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  /**
   * Legacy single-column suggestion. Kept for backward compatibility
   * with existing web-client consumers. New tools should prefer the
   * explicit `suggestedStandardLookupValue` and
   * `suggestedLegacyODataValue` pair.
   */
  readonly suggestedLookupValue?: string;
  readonly suggestedStandardLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly suggestedRelatedResourceName?: string;
  readonly suggestedRelatedFieldName?: string;
  readonly suggestedRelatedLookupValue?: string;
  readonly outcome?: string;
  readonly comments?: string;
}

export const variationsToCsv = (rows: ReadonlyArray<VariationCsvRow>): string => {
  const data = rows.map(r => [
    r.resourceName,
    r.fieldName,
    r.lookupValue,
    r.suggestedResourceName,
    r.suggestedFieldName,
    r.suggestedLookupValue,
    r.suggestedStandardLookupValue,
    r.suggestedLegacyODataValue,
    r.suggestedRelatedResourceName,
    r.suggestedRelatedFieldName,
    r.suggestedRelatedLookupValue,
    r.outcome,
    r.comments,
  ]);
  return rowsToCsv(VARIATIONS_CSV_COLUMNS, data);
};

/** Maps a column header string to the VariationCsvRow attribute name. */
const HEADER_TO_FIELD: Readonly<Record<string, keyof VariationCsvRow>> = {
  'resource name': 'resourceName',
  'field name': 'fieldName',
  'lookup value': 'lookupValue',
  'suggested resource name': 'suggestedResourceName',
  'suggested field name': 'suggestedFieldName',
  'suggested lookup value': 'suggestedLookupValue',
  'suggested standard lookup value': 'suggestedStandardLookupValue',
  'suggested legacy odata value': 'suggestedLegacyODataValue',
  'suggested related resource name': 'suggestedRelatedResourceName',
  'suggested related field name': 'suggestedRelatedFieldName',
  'suggested related lookup value': 'suggestedRelatedLookupValue',
  'outcome': 'outcome',
  'comments': 'comments',
};

export interface ParseVariationsCsvError {
  /** 1-indexed line number in the source CSV. */
  readonly line: number;
  readonly message: string;
}

export interface ParseVariationsCsvResult {
  readonly rows: ReadonlyArray<VariationCsvRow>;
  readonly errors: ReadonlyArray<ParseVariationsCsvError>;
}

/**
 * Parse a variations-CSV string into `VariationCsvRow` records.
 *
 * - Resolves column order from the header row by case-insensitive
 *   name match. Unknown columns are ignored. Extra spaces around
 *   names are tolerated.
 *   - At least one of `Resource Name` must be present.
 * - Rows missing `Resource Name` (the schema's required field) are
 *   recorded as errors and excluded from the success list.
 * - Trailing empty rows are ignored.
 *
 * Returns both the parsed rows and any per-row errors so the
 * caller can surface them in a single pass — no exception thrown
 * for partial-failure imports.
 */
export const csvToVariations = (csv: string): ParseVariationsCsvResult => {
  const raw = csvToRows(csv);
  if (raw.length === 0) return { rows: [], errors: [{ line: 0, message: 'CSV is empty' }] };

  const headerRow = raw[0].map(h => h.trim().toLowerCase());
  const columnMap: Array<keyof VariationCsvRow | null> = headerRow.map(h =>
    HEADER_TO_FIELD[h] ?? null
  );
  if (!columnMap.includes('resourceName')) {
    return {
      rows: [],
      errors: [{ line: 1, message: 'Header row must include a "Resource Name" column' }],
    };
  }

  const rows: VariationCsvRow[] = [];
  const errors: ParseVariationsCsvError[] = [];

  for (let i = 1; i < raw.length; i += 1) {
    const cells = raw[i];
    // Skip fully-blank rows (Excel often appends one).
    if (cells.every(c => c === '')) continue;

    const record: Record<string, string | undefined> = {};
    for (let c = 0; c < cells.length; c += 1) {
      const field = columnMap[c];
      if (!field) continue;
      const value = cells[c]?.trim();
      if (value) record[field] = value;
    }

    if (!record.resourceName) {
      errors.push({ line: i + 1, message: 'Row missing required Resource Name' });
      continue;
    }

    rows.push(record as unknown as VariationCsvRow);
  }

  return { rows, errors };
};
