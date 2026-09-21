/**
 * `list-variation-reviews` and `variations-review-status` — the read side of
 * the review pool on the CLI. Pure formatters here (tested on their own); the
 * Commander wiring in `index.ts` fetches through `src/variations/review.ts`
 * and prints either the JSON as served (`--json`) or one of these tables.
 */

import type { EndorsementStatusRow, VariationReviewItem } from '../variations/review.js';

/** The variation key joins its segments with the unit separator; show it as dots. */
const KEY_SEPARATOR = '';

const cell = (value: unknown): string => (value === undefined || value === null || value === '' ? '-' : String(value));

const pad = (value: string, width: number): string => value.padEnd(width);

const renderTable = (headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: ReadonlyArray<string>): string => cells.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  return [line(headers), line(widths.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n');
};

/** `Property.Roof.Corrugated` from the pool's separator-joined key. */
export const displayVariationKey = (variationKey: string): string => variationKey.split(KEY_SEPARATOR).join('.');

/** The mapping's target, whichever kind it is: `Buyer`, `EdmDate`, `Property.OpenHouses`. */
export const displayMapping = (mapping: VariationReviewItem['mapping']): string => {
  if (!mapping) return '-';
  const parts = [
    mapping.suggestedResourceName,
    mapping.suggestedFieldName,
    mapping.suggestedStandardLookupValue ?? mapping.suggestedLookupValue ?? mapping.suggestedLegacyODataValue,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.length > 0 ? parts.join('.') : '-';
};

const earliest = (item: VariationReviewItem): string =>
  item.provenance.reduce<string | undefined>((min, p) => (min === undefined || p.submittedAt < min ? p.submittedAt : min), undefined) ?? '';

/** One line per item: status, element, mapping, strategy, how many tuples flagged it and when the earliest did. */
export const formatReviewItemsTable = (items: ReadonlyArray<VariationReviewItem>): string => {
  if (items.length === 0) return 'No items in review.';
  const rows = items.map(item => [
    cell(item.status),
    displayVariationKey(item.variationKey),
    displayMapping(item.mapping),
    cell(item.strategy),
    String(item.provenance.length),
    cell(earliest(item).slice(0, 19) || undefined),
    cell(item.outcome),
  ]);
  return renderTable(['status', 'element', 'mapping', 'strategy', 'tuples', 'first submitted', 'outcome'], rows);
};

/** One line per submission: the tuple, the endorsement, and where the review stands. */
export const formatEndorsementStatusTable = (rows: ReadonlyArray<EndorsementStatusRow>): string => {
  if (rows.length === 0) return 'No submissions.';
  const lines = rows.map(r => [
    cell(r.providerUoi),
    cell(r.providerUsi),
    cell(r.recipientUoi),
    cell(r.endorsement),
    cell(r.version),
    cell(r.lifecycleStatus),
    cell(r.reviewStatus),
    cell((r.updatedAt ?? r.submittedAt ?? '').slice(0, 19) || undefined),
  ]);
  return renderTable(['provider', 'usi', 'recipient', 'endorsement', 'version', 'lifecycle', 'review', 'updated'], lines);
};

/** Provenance one tuple per line, indented under its item — the `--provenance` view. */
export const formatProvenance = (items: ReadonlyArray<VariationReviewItem>): string =>
  items
    .map(item => {
      const head = `${displayVariationKey(item.variationKey)} → ${displayMapping(item.mapping)} [${cell(item.status)}${item.strategy ? `, ${item.strategy}` : ''}]`;
      const lines = item.provenance.map(
        p =>
          `  ${p.submittedAt.slice(0, 19)}  ${p.providerUoi}/${p.providerUsi}/${p.recipientUoi}  by ${cell(p.submittedByProviderUoi)}  ${cell(p.environmentName)}${
            p.lastEditorRole ? `  ${p.lastEditorRole}` : ''
          }`,
      );
      return [head, ...lines].join('\n');
    })
    .join('\n');
