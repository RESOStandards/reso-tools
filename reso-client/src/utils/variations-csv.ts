/**
 * Variations report ↔ CSV. Defines the canonical 10-column schema
 * used by RESO variations submissions and provides round-trip
 * serialization that handles quoting/escaping properly (works with
 * Google Sheets, Excel, etc.) — unlike the older legacy split-on-
 * comma helpers, which fail the moment a value contains a comma.
 *
 * Consumers: web-client variations review export, reso-certification
 * CLI ingest. Pure functions, no Node or browser deps.
 */

import { rowsToCsv } from './csv.js';

export const VARIATIONS_CSV_COLUMNS = [
  'Resource Name',
  'Field Name',
  'Lookup Value',
  'Suggested Resource Name',
  'Suggested Field Name',
  'Suggested Lookup Value',
  'Suggested Related Resource Name',
  'Suggested Related Field Name',
  'Suggested Related Lookup Value',
  'Outcome',
] as const;

export interface VariationCsvRow {
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

export const variationsToCsv = (rows: ReadonlyArray<VariationCsvRow>): string => {
  const data = rows.map(r => [
    r.resourceName,
    r.fieldName,
    r.lookupValue,
    r.suggestedResourceName,
    r.suggestedFieldName,
    r.suggestedLookupValue,
    r.suggestedRelatedResourceName,
    r.suggestedRelatedFieldName,
    r.suggestedRelatedLookupValue,
    r.outcome,
  ]);
  return rowsToCsv(VARIATIONS_CSV_COLUMNS, data);
};
