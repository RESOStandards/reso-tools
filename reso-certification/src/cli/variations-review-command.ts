/**
 * `list-variation-reviews` and `variations-review-status` — the read side of
 * the review pool on the CLI. Pure formatters here (tested on their own); the
 * Commander wiring in `index.ts` fetches through `src/variations/review.ts`
 * and prints either the JSON as served (`--json`) or one of these tables.
 */

import type { EndorsementStatusRow, VariationReviewItem } from '../variations/review.js';
import { cell, renderTable } from './table.js';

/** The variation key joins its segments with the unit separator; show it as dots. */
const KEY_SEPARATOR = '';

/** `Property.Roof.Corrugated` from the pool's separator-joined key. */
export const displayVariationKey = (variationKey: string): string => variationKey.split(KEY_SEPARATOR).join('.');

/** The mapping's target, whichever kind it is: `Buyer`, `EdmDate`, `Property.OpenHouses`. */
export const displayMapping = (mapping: VariationReviewItem['mapping']): string => {
  if (!mapping) return '-';
  const parts = [
    mapping.suggestedResourceName,
    mapping.suggestedFieldName,
    mapping.suggestedStandardLookupValue ?? mapping.suggestedLookupValue ?? mapping.suggestedLegacyODataValue
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.length > 0 ? parts.join('.') : '-';
};

const earliest = (item: VariationReviewItem): string =>
  item.provenance.reduce<string | undefined>((min, p) => (min === undefined || p.submittedAt < min ? p.submittedAt : min), undefined) ?? '';

/** One line per item: status, element, mapping, strategy, how many submissions flagged it and when the earliest did. */
export const formatReviewItemsTable = (items: ReadonlyArray<VariationReviewItem>): string => {
  if (items.length === 0) return 'No items in review.';
  const rows = items.map(item => [
    cell(item.status),
    displayVariationKey(item.variationKey),
    displayMapping(item.mapping),
    cell(item.strategy),
    String(item.provenance.length),
    cell(earliest(item).slice(0, 19) || undefined),
    cell(item.outcome)
  ]);
  return renderTable(['status', 'element', 'mapping', 'strategy', 'submissions', 'first submitted', 'outcome'], rows);
};

/**
 * The review as a sheet.
 *
 * The desktop client can export a review to CSV; the CLI could only print a table or `--json`.
 * That gap matters most to the people who have no desktop client at all, because the decisions
 * workflow round-trips through a sheet: export, edit, `submit-variation-decisions`. Without an
 * export those users had to hand-build the file the CLI would read back.
 *
 * Columns follow the desktop export so a sheet from either side is the same artifact, plus
 * `Strategy`, which neither side carried until now. `Status` is included because a CLI listing is
 * typically the whole pool rather than one report, so a row has to say where it stands.
 *
 * `Action` and `Comment` are written empty. They are what makes this a template rather than a
 * report: `submit-variation-decisions` reads them, so the exported file goes back in unchanged
 * except for what the reviewer typed. `Strategy`, `Status` and `Outcome` ride along as context
 * and are recognized-but-ignored on the way back, so our own sheet never warns about itself.
 */
const CSV_HEADERS: ReadonlyArray<string> = [
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
  'Strategy',
  'Status',
  'Outcome',
  // Empty on export, and the point of it. This sheet is filled in and submitted back through
  // `submit-variation-decisions`, which reads these two. Without them there is nowhere to write
  // the decision and the file has to be reshaped by hand before it can be used.
  'Action',
  'Comment'
];

/** The mapping fields a row carries, read off `mapping` rather than re-derived from the key. */
const mappingField = (mapping: VariationReviewItem['mapping'], field: string): string => {
  const value = mapping?.[field];
  return typeof value === 'string' ? value : '';
};

/**
 * RFC-4180 quoting: wrap when the value holds a comma, a quote or a newline, and double any quote.
 *
 * An empty cell is written empty rather than as `-`. The table's `-` is a reading aid; a sheet is
 * read back by `parseVariationsCsv`, and a literal dash there would be submitted as the string "-".
 */
const csvCell = (value: unknown): string => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * The suggestion as the pool holds it. Nothing is inferred.
 *
 * A mapping that names a field and no resource is INCOMPLETE, not a statement that the resource
 * is the same one. Filling the gap from the row's own identity would be a guess written into a
 * sheet that someone then acts on, and a wrong guess is indistinguishable from a real mapping
 * once it is in the file. Josh, 2026-10-15: "we should always have the suggested elements filled
 * in, not assume that because one is missing that it's the same resource."
 *
 * So an incomplete mapping exports incomplete, and the decisions planner refuses it by name. That
 * refusal is the correct outcome: the row cannot be acted on until the suggestion that produced it
 * says what it actually proposes. The repair belongs where the suggestion is built.
 */
const suggestionAtDepth = (item: VariationReviewItem): { readonly resource: string; readonly field: string } => ({
  resource: mappingField(item.mapping, 'suggestedResourceName'),
  field: mappingField(item.mapping, 'suggestedFieldName')
});

/** The review items as CSV, header first. Round-trips through `parseVariationsCsv`. */
export const formatReviewItemsCsv = (items: ReadonlyArray<VariationReviewItem>): string => {
  const rows = items.map(item => {
    const suggested = suggestionAtDepth(item);
    return [
      item.resourceName,
      item.fieldName ?? '',
      item.lookupValue ?? '',
      suggested.resource,
      suggested.field,
      mappingField(item.mapping, 'suggestedLookupValue'),
      mappingField(item.mapping, 'suggestedStandardLookupValue'),
      mappingField(item.mapping, 'suggestedLegacyODataValue'),
      mappingField(item.mapping, 'suggestedRelatedResourceName'),
      mappingField(item.mapping, 'suggestedRelatedFieldName'),
      mappingField(item.mapping, 'suggestedRelatedLookupValue'),
      item.strategy ?? '',
      item.status,
      item.outcome ?? '',
      '',
      ''
    ].map(csvCell);
  });
  return [CSV_HEADERS.map(csvCell).join(','), ...rows.map(r => r.join(','))].join('\n');
};

/**
 * One line per submission: the identifiers it came in under, the endorsement, and where the review stands.
 *
 * The empty case says WHICH question was asked, because the two are easy to confuse and the bare
 * command answers the narrower one. `endorsements/me` lists submissions made under the CALLER's own
 * organization, so an administrator acting on behalf of providers has none — their submissions belong
 * to the provider. "No submissions" is then true and useless, and the queue is one flag away.
 */
export const formatEndorsementStatusTable = (
  rows: ReadonlyArray<EndorsementStatusRow>,
  reviewStatus?: string,
  providerUoi?: string
): string => {
  if (rows.length === 0) {
    if (reviewStatus) return `No submissions with review status '${reviewStatus}'.`;
    const whose = providerUoi ? `for provider UOI ${providerUoi}` : 'under your own organization';
    return `No submissions ${whose}. Submissions you made on behalf of a provider belong to that provider. Run with --review-status in-review to see the review queue.`;
  }
  const lines = rows.map(r => [
    cell(r.providerUoi),
    cell(r.providerUsi),
    cell(r.recipientUoi),
    cell(r.endorsement),
    cell(r.version),
    cell(r.lifecycleStatus),
    cell(r.reviewStatus),
    cell((r.updatedAt ?? r.submittedAt ?? '').slice(0, 19) || undefined)
  ]);
  return renderTable(['provider', 'usi', 'recipient', 'endorsement', 'version', 'lifecycle', 'review', 'updated'], lines);
};

/** Provenance one submission per line, indented under its item — the `--provenance` view. */
export const formatProvenance = (items: ReadonlyArray<VariationReviewItem>): string =>
  items
    .map(item => {
      const head = `${displayVariationKey(item.variationKey)} → ${displayMapping(item.mapping)} [${cell(item.status)}${item.strategy ? `, ${item.strategy}` : ''}]`;
      const lines = item.provenance.map(
        p =>
          `  ${p.submittedAt.slice(0, 19)}  ${p.providerUoi}/${p.providerUsi}/${p.recipientUoi}  by ${cell(p.submittedByProviderUoi)}  ${cell(p.environmentName)}${
            p.lastEditorRole ? `  ${p.lastEditorRole}` : ''
          }`
      );
      return [head, ...lines].join('\n');
    })
    .join('\n');

/**
 * Variation keys the service returned more than once. The items route groups
 * rows by key within a page, so a key whose rows straddle a page boundary
 * comes back twice with its provenance split; the CLI reports the rows as
 * served and warns, rather than merging and hiding it.
 */
export const duplicateVariationKeys = (items: ReadonlyArray<VariationReviewItem>): ReadonlyArray<string> => {
  const counts = items.reduce((m, i) => m.set(i.variationKey, (m.get(i.variationKey) ?? 0) + 1), new Map<string, number>());
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => displayVariationKey(k));
};
