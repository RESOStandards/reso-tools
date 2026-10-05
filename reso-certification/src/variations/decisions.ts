import { VARIATION_LEVEL_KEYS, countBucketedEntries } from './constants.js';
import type { LevelBuckets, ReportEntry, VariationLevelKey } from './constants.js';

/**
 * Marking a variations report the way the review UI marks it.
 *
 * The flow, in Josh's words (2026-10-04): "we got a variations report, we're submitting it for
 * review as Admin on behalf of the provider, then, after we started the review, we selected FT on
 * the item I mentioned, and added a comment about it as admin." And the governing constraint:
 * "client passes the variations report and comments and the backend should do everything from
 * there", which "should make the same output as if a user is on the UI".
 *
 * SO THERE IS ONE REQUEST, NOT TWO. Marking an item is not a separate call: it is a field on the
 * change inside the report. The service's `VariationsChange` declares `ignore`,
 * `flaggedForFastTrack` and `conversations`, and `provider.ts` derives the pool row's
 * `requestedAction` from them:
 *
 *     flaggedForFastTrack === true → 'fast-track'
 *     remove === true              → 'remove'
 *     ignore === true              → 'ignore'
 *
 * Everything else is the backend's: it builds the flat `changes` array, derives `editorInfo` from
 * the auth context, creates the pool rows and notifies. This module's whole job is to put the flag
 * and the comment on the right entry and hand the report back.
 *
 * THE REPORT IS LEVEL-BUCKETED, which is the shape a Data Dictionary run writes:
 * `resources`, `fields`, `lookups`, `expansions`, `complexTypes`, each an array of entries. It is
 * NOT a flat `changes` array -- that is the shape the service stores, and assuming it here is what
 * made an earlier version of this module reject a perfectly good artifact as "the wrong file".
 */

/**
 * What a sheet row can ask for, and the field on the change that carries it.
 *
 * Only the three the report save understands. An admin's TERMINAL decision -- accepting a mapping,
 * or recording an FT mapping -- is a different operation on a different route
 * (`save-variation-decisions`), because it writes the canonical store for every organization
 * holding the key. It is deliberately not expressible here: a sheet that pushes a report cannot
 * also resolve one.
 */
export const SHEET_ACTIONS = ['ignore', 'remove', 'submit-to-ft'] as const;
export type SheetAction = (typeof SHEET_ACTIONS)[number];

/** The change field each action sets. `submit-to-ft` is spelled `flaggedForFastTrack` on the wire. */
const ACTION_FIELD: Readonly<Record<SheetAction, 'ignore' | 'remove' | 'flaggedForFastTrack'>> = {
  ignore: 'ignore',
  remove: 'remove',
  'submit-to-ft': 'flaggedForFastTrack'
};

/** True for a string the report save understands as a requested action. A guard, because a person typed it. */
const isSheetAction = (value: string): value is SheetAction => (SHEET_ACTIONS as ReadonlyArray<string>).includes(value);

/** One sheet row: which element, optionally what to ask for, optionally what to say about it. */
export interface DecisionSheetRow {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  /** As written in the sheet, unvalidated. This module is what checks it against the vocabulary. */
  readonly action?: string;
  readonly comment?: string;
}

/**
 * A comment in a variations conversation thread: what was said, when, and who may read it.
 *
 * `from` IS ABSENT and is filled from the auth context. Josh: "there's no comment attribution, it
 * comes from the submitter", and "it's from Admin targeted at providerUoi". It is also the only
 * shape a client could honestly produce: the caller's identity is columns on the token row, read by
 * the Lambda authorizer and handed to the handler. The bearer token is an opaque key, not a JWT with
 * claims to read.
 *
 * `to` IS REQUIRED, and it is not a label. Josh: "the provider here controls who can see it - the
 * to", and "that means anyone who has an account at providerUoi sees it." It is the comment's
 * VISIBILITY SCOPE, read off the report's own `providerUoi` -- a fact about the report, not a claim
 * about the caller -- and an absent one is a refusal rather than an empty string. An empty `to` is
 * not "addressed to nobody": it is a readership nothing defines, on the field that decides who sees
 * what an administrator said about a provider's data.
 */
export interface ReportComment {
  readonly timestamp: string;
  /** The organization that may read this. Anyone with an account there sees it. */
  readonly to: string;
  readonly message: string;
}

/** The slice of a variations report this module reads and rewrites. */
export interface DecisionReport extends LevelBuckets {
  readonly providerUoi?: string;
  readonly [key: string]: unknown;
}

/** Where one entry lives: which bucket, and its index in that bucket. */
interface EntryAddress {
  readonly bucket: VariationLevelKey;
  readonly index: number;
  readonly entry: ReportEntry;
}

/** Every entry across every bucket, in declared bucket order. */
const allEntries = (report: DecisionReport): ReadonlyArray<EntryAddress> =>
  VARIATION_LEVEL_KEYS.flatMap(bucket => {
    const entries = report[bucket];
    return Array.isArray(entries) ? entries.map((entry, index) => ({ bucket, index, entry: entry as ReportEntry })) : [];
  });

/** Total entries the report carries, across all buckets. */
export const countEntries = (report: DecisionReport): number => countBucketedEntries(report);

/** A human label for a row, for an error message that names what the operator wrote. */
const rowLabel = (row: DecisionSheetRow): string => [row.resourceName, row.fieldName, row.lookupValue].filter(Boolean).join('.');

/**
 * The value a lookup entry is named by, in whichever wire form it carries.
 *
 * `LookupEntry` declares `lookupValue` AND `legacyODataValue`, both optional, so an entry can be
 * named by either. Matching only the first would make a legacy-form variation permanently
 * unaddressable: the operator would type what the report showed them, nothing would match, and the
 * row would be reported as naming an element that is not in the report.
 */
const lookupValueOf = (entry: ReportEntry): string | undefined => entry.lookupValue ?? entry.legacyODataValue;

/** A label for an entry, so an ambiguity error can name what it matched. */
const entryLabel = (entry: ReportEntry): string => [entry.resourceName, entry.fieldName, lookupValueOf(entry)].filter(Boolean).join('.');

/**
 * Entries a row addresses.
 *
 * An ABSENT sheet value is a wildcard and a PRESENT one must match exactly. That asymmetry is
 * deliberate: it lets a row name a field-level entry without inventing an empty lookup value, and it
 * makes an under-specified row AMBIGUOUS rather than silently matching nothing. A row naming only
 * `Property.LeaseTerm` when the report holds two LeaseTerm values is a mistake worth reporting, not
 * a miss worth swallowing.
 */
const matchEntries = (report: DecisionReport, row: DecisionSheetRow): ReadonlyArray<EntryAddress> =>
  allEntries(report).filter(
    ({ entry }) =>
      entry.resourceName === row.resourceName &&
      (row.fieldName === undefined || entry.fieldName === row.fieldName) &&
      // Either wire form satisfies the row. Two entries answering to one value make the row
      // ambiguous, which the caller reports rather than resolving by preference.
      (row.lookupValue === undefined || entry.lookupValue === row.lookupValue || entry.legacyODataValue === row.lookupValue)
  );

/** What one row asked for, once it has been matched to an entry. */
export interface AppliedRow {
  readonly bucket: VariationLevelKey;
  readonly element: string;
  readonly action?: SheetAction;
  readonly commented: boolean;
}

export interface ApplySheetResult {
  /** The report with flags and comments attached. Identical to the input when nothing applied. */
  readonly report: DecisionReport;
  readonly applied: ReadonlyArray<AppliedRow>;
  /** Every unusable row. Non-empty means the report is handed back untouched. */
  readonly errors: ReadonlyArray<string>;
}

/**
 * Attach each row's requested action and comment to the entry it names.
 *
 * Returns the report UNCHANGED when any row is unusable. One push carries the whole sheet, so a
 * half-applied sheet would leave the operator reconciling which rows landed -- and the push is a
 * full replace of the review rows, which makes a partial one worse than none.
 *
 * `now` is a parameter rather than read from the clock, so the output is a function of its inputs
 * and a test can assert the whole report. The input is never mutated.
 *
 * No actor is taken. `from` is filled from the auth context, and `to` is the report's own
 * `providerUoi`, which scopes who may read the comment. See `ReportComment`.
 */
export const applySheetToReport = (report: DecisionReport, rows: ReadonlyArray<DecisionSheetRow>, now: string): ApplySheetResult => {
  const errors: string[] = [];
  const applied: AppliedRow[] = [];
  // Keyed by `bucket:index`, so two rows touching one entry both land, in row order.
  const edits = new Map<string, { bucket: VariationLevelKey; index: number; action?: SheetAction; comments: ReportComment[] }>();

  const needsComment = rows.some(r => typeof r.comment === 'string' && r.comment.length > 0);

  // `to` scopes who can read a comment, so it is established or nothing is written. Defaulting it
  // would not produce an unaddressed comment, it would produce one whose readership is undefined --
  // and this is the field deciding whether a provider's people see what an administrator said about
  // their data. Checked only when a comment actually needs addressing.
  const to = report.providerUoi;
  if (needsComment && !to) {
    return {
      report,
      applied: [],
      errors: [
        'The report carries no providerUoi, so there is no organization to address these comments to. A comment is visible to everyone with an account at the organization it names, and that scope is not inferred.'
      ]
    };
  }

  for (const row of rows) {
    const hasComment = typeof row.comment === 'string' && row.comment.length > 0;

    if (row.action !== undefined && !isSheetAction(row.action)) {
      // `accept` and `ft-mapped` land here deliberately. They resolve an item into the canonical
      // store for every organization holding it, which is a different route, so the message names
      // it rather than just listing what is allowed.
      errors.push(
        `${rowLabel(row)}: action must be one of ${SHEET_ACTIONS.join(', ')} — got "${row.action}". Resolving an item into the canonical store is a separate operation and cannot be done by pushing a report.`
      );
      continue;
    }
    if (row.action === undefined && !hasComment) continue;

    const matched = matchEntries(report, row);
    if (matched.length === 0) {
      errors.push(`${rowLabel(row)}: matches no entry in the report.`);
      continue;
    }
    if (matched.length > 1) {
      errors.push(
        `${rowLabel(row)}: matches ${matched.length} entries (${matched.map(m => entryLabel(m.entry)).join(', ')}) — name the lookup value to disambiguate.`
      );
      continue;
    }

    const { bucket, index, entry } = matched[0];
    const key = `${bucket}:${index}`;
    const existing = edits.get(key) ?? { bucket, index, comments: [] };

    if (row.action !== undefined && existing.action !== undefined && existing.action !== row.action) {
      errors.push(`${entryLabel(entry)}: two rows ask for different actions ('${existing.action}' and '${row.action}').`);
      continue;
    }

    edits.set(key, {
      ...existing,
      ...(row.action !== undefined ? { action: row.action } : {}),
      comments: hasComment
        ? [...existing.comments, { timestamp: now, to: to as string, message: row.comment as string }]
        : existing.comments
    });

    applied.push({
      bucket,
      element: entryLabel(entry),
      ...(row.action !== undefined ? { action: row.action } : {}),
      commented: hasComment
    });
  }

  if (errors.length > 0) return { report, applied: [], errors };
  if (edits.size === 0) return { report, applied: [], errors: [] };

  // Rebuild only the buckets that changed, and only the entries within them.
  const touched = new Set([...edits.values()].map(e => e.bucket));
  const rebuilt = Object.fromEntries(
    [...touched].map(bucket => [
      bucket,
      (report[bucket] as ReadonlyArray<ReportEntry>).map((entry, index) => {
        const edit = edits.get(`${bucket}:${index}`);
        if (!edit) return entry;
        return {
          ...entry,
          ...(edit.action ? { [ACTION_FIELD[edit.action]]: true } : {}),
          // Comments APPEND. A thread is a conversation between the provider and RESO, so replacing
          // it would destroy the half the other side wrote. The service appends too, keyed on the
          // same resource/field/value identity, so this is consistent rather than redundant.
          ...(edit.comments.length > 0 ? { conversations: [...(entry.conversations ?? []), ...edit.comments] } : {})
        };
      })
    ])
  );

  return { report: { ...report, ...rebuilt }, applied, errors: [] };
};
