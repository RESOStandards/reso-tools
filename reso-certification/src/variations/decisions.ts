/**
 * Review decisions and admin comments from a sheet.
 *
 * The flow this serves, in Josh's words (2026-10-04): "we got a variations report, we're submitting it
 * for review as Admin on behalf of the provider, then, after we started the review, we selected FT on
 * the item I mentioned, and added a comment about it as admin."
 *
 * The order is the design. Submitting the report opens the review and creates the pool rows; the
 * selection and the comment come afterwards. They also travel by different routes to different stores:
 *
 *   - the ACTION goes to `POST /v2/certification/save-variation-decisions`, which for `submit-to-ft`
 *     flips the pool row from `pending` to `ft-submitted` and writes nothing to the canonical store;
 *   - the COMMENT lands in `conversations[]` on the change and is persisted by a report save, which is
 *     where the review UI puts it ("comments are stored in the localStorage draft until the user saves
 *     the entire variations report").
 *
 * So one sheet row can drive two routes. These functions produce the input for each and perform
 * neither, which is what makes them testable and what keeps the request-building separate from the
 * decision to send.
 *
 * Comments APPEND. Josh: "if we add one comment now, we should still be able to add another one later
 * from the review too." A thread is a conversation between the provider and RESO, so replacing it would
 * destroy the half the other side wrote.
 */

/**
 * The separator the pool joins a variation key with: an ASCII unit separator, which prints as nothing.
 *
 * Exported because a test asserting a key must build one the same way rather than embed a literal. A
 * hand-written key looks correct, never matches, and errors nowhere — the lookup simply misses and
 * whatever it gated goes quietly absent. Never type one out, and never copy one from terminal output.
 */
export const VARIATION_KEY_SEPARATOR = String.fromCharCode(31);

/** The actions the review service accepts. `submit-to-ft` is the one that needs no mapping. */
export const DECISION_ACTIONS = ['ignore', 'remove', 'accept', 'submit-to-ft', 'ft-mapped'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** Actions whose meaning is a mapping target, so one is required. */
const ACTIONS_REQUIRING_MAPPING: ReadonlyArray<DecisionAction> = ['accept', 'ft-mapped'];

/**
 * True for a string the review service accepts as an action.
 *
 * A guard rather than a cast, and it exists because the sheet's `action` is an UNVALIDATED string:
 * a person typed it. Typing the field as `DecisionAction` would claim a validation that happens
 * here, which only moves the typo past the one place that reports it by row.
 */
const isDecisionAction = (value: string): value is DecisionAction => (DECISION_ACTIONS as ReadonlyArray<string>).includes(value);

/** One sheet row: which element, optionally what to do, optionally what to say about it. */
export interface DecisionSheetRow {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  /** As written in the sheet, unvalidated. `decisionsFromSheet` is what checks it against the vocabulary. */
  readonly action?: string;
  readonly comment?: string;
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  readonly suggestedLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly suggestedRelatedResourceName?: string;
  readonly suggestedRelatedFieldName?: string;
  readonly suggestedRelatedLookupValue?: string;
  readonly notes?: string;
}

/** A change as a variations report carries it. Only the fields this module reads are named. */
export interface ReportChange {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly conversations?: ReadonlyArray<ReportComment>;
  readonly [key: string]: unknown;
}

/**
 * A comment in a variations conversation thread: what was said, when, and who may read it.
 *
 * `from` IS ABSENT and is filled from the auth context. Josh, 2026-10-04: "there's no comment
 * attribution, it comes from the submitter", and "it's from Admin targeted at providerUoi". Which is
 * also the only shape a client could honestly produce: the caller's identity is columns on the token
 * row -- `providerUoi`, `username`, `email`, `isAdmin` -- read by the Lambda authorizer and handed to
 * the handler in the request context. The bearer token is an opaque key, not a JWT with claims to
 * read, so a client asserting a `from` would be asserting what it cannot know.
 *
 * `to` IS REQUIRED, and it is not a label. Josh: "the provider here controls who can see it - the
 * to", and "that means anyone who has an account at providerUoi sees it." It is the comment's
 * VISIBILITY SCOPE, so it is read off the report's own `providerUoi` -- a fact about the report, not
 * a claim about the caller -- and an absent one is a refusal rather than an empty string. An empty
 * `to` is not "addressed to nobody": it is a scope nothing defines, on a field that decides who
 * reads an administrator's remarks about a provider's data.
 */
export interface ReportComment {
  readonly timestamp: string;
  /** The organization that may read this. Anyone with an account there sees it. */
  readonly to: string;
  readonly message: string;
}

/** The slice of a variations report this module reads and rewrites. */
export interface DecisionReport {
  readonly providerUoi?: string;
  readonly changes: ReadonlyArray<ReportChange>;
  readonly [key: string]: unknown;
}

/** One decision as `save-variation-decisions` ingests it. */
export interface Decision {
  readonly variationKey: string;
  readonly action: DecisionAction;
  readonly mapping?: Readonly<Record<string, string>>;
}

/** Build the pool's variation key for a change. DERIVED, never accepted from input. */
export const variationKeyFor = (change: ReportChange): string =>
  [change.resourceName, change.fieldName, change.lookupValue]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(VARIATION_KEY_SEPARATOR);

/** A human label for a row, for an error message that names what the operator wrote. */
const rowLabel = (row: DecisionSheetRow): string => [row.resourceName, row.fieldName, row.lookupValue].filter(Boolean).join('.');

/**
 * Changes a row addresses.
 *
 * An ABSENT sheet value is a wildcard and a PRESENT one must match exactly. That asymmetry is
 * deliberate: it lets a row name a field-level change without inventing an empty lookup value, and it
 * makes an under-specified row AMBIGUOUS rather than silently matching nothing. A row naming only
 * `Property.LeaseTerm` when the report holds two LeaseTerm values is a mistake worth reporting, not a
 * miss worth swallowing.
 */
const matchChanges = (report: DecisionReport, row: DecisionSheetRow): ReadonlyArray<ReportChange> =>
  report.changes.filter(
    c =>
      c.resourceName === row.resourceName &&
      (row.fieldName === undefined || c.fieldName === row.fieldName) &&
      (row.lookupValue === undefined || c.lookupValue === row.lookupValue)
  );

/** Collect the suggestion components a row carries into a mapping, or undefined when it carries none. */
const mappingFrom = (row: DecisionSheetRow): Readonly<Record<string, string>> | undefined => {
  const entries = (
    [
      ['suggestedResourceName', row.suggestedResourceName],
      ['suggestedFieldName', row.suggestedFieldName],
      ['suggestedLookupValue', row.suggestedLookupValue],
      ['suggestedLegacyODataValue', row.suggestedLegacyODataValue],
      ['suggestedRelatedResourceName', row.suggestedRelatedResourceName],
      ['suggestedRelatedFieldName', row.suggestedRelatedFieldName],
      ['suggestedRelatedLookupValue', row.suggestedRelatedLookupValue],
      ['notes', row.notes]
    ] as ReadonlyArray<readonly [string, string | undefined]>
  ).filter((e): e is readonly [string, string] => typeof e[1] === 'string' && e[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export interface DecisionsFromSheetResult {
  readonly decisions: ReadonlyArray<Decision>;
  /** One message per unusable row. Every row is reported, not just the first. */
  readonly errors: ReadonlyArray<string>;
}

/**
 * Turn sheet rows into a decisions payload.
 *
 * Returns no decisions at all when any row is unusable. A batch is submitted under one lock and
 * reported as one result, so a half-valid batch would leave the operator reconciling which rows landed
 * — the same ambiguity that makes a partially-applied update sheet hard to replay.
 */
export const decisionsFromSheet = (report: DecisionReport, rows: ReadonlyArray<DecisionSheetRow>): DecisionsFromSheetResult => {
  const errors: string[] = [];
  const decisions: Decision[] = [];

  for (const row of rows) {
    // A comment-only row is legitimate: the comment still belongs on the report.
    if (row.action === undefined) continue;

    if (!isDecisionAction(row.action)) {
      errors.push(`${rowLabel(row)}: action must be one of ${DECISION_ACTIONS.join(', ')} — got "${row.action}".`);
      continue;
    }
    const action = row.action;

    const mapping = mappingFrom(row);
    if (ACTIONS_REQUIRING_MAPPING.includes(action) && !mapping) {
      errors.push(`${rowLabel(row)}: action '${action}' requires a mapping target.`);
      continue;
    }

    const matched = matchChanges(report, row);
    if (matched.length === 0) {
      errors.push(`${rowLabel(row)}: matches no change in the report.`);
      continue;
    }
    if (matched.length > 1) {
      errors.push(`${rowLabel(row)}: matches ${matched.length} changes — name the lookup value to disambiguate.`);
      continue;
    }

    decisions.push({
      variationKey: variationKeyFor(matched[0]),
      action,
      ...(mapping ? { mapping } : {})
    });
  }

  return errors.length > 0 ? { decisions: [], errors } : { decisions, errors: [] };
};

export interface AnnotateResult {
  readonly report: DecisionReport;
  /** True only when a comment was actually attached, so a caller can skip a pointless report save. */
  readonly changed: boolean;
  readonly errors: ReadonlyArray<string>;
}

/**
 * Attach each row's comment to its change's `conversations[]`.
 *
 * `now` is a parameter rather than read from the clock, so the output is a function of its inputs and a
 * test can assert the whole report. The original is never mutated: a new report is returned and the
 * caller decides whether to save it.
 *
 * No actor is taken: `from` is filled from the auth context, and `to` is the report's own
 * `providerUoi`, which scopes who may read the comment. See `ReportComment`.
 */
export const annotateReportWithComments = (report: DecisionReport, rows: ReadonlyArray<DecisionSheetRow>, now: string): AnnotateResult => {
  const withComments = rows.filter(r => typeof r.comment === 'string' && r.comment.length > 0);
  if (withComments.length === 0) return { report, changed: false, errors: [] };

  // `to` scopes who can read the comment, so it is established or nothing is written. Defaulting it
  // would not produce an unaddressed comment, it would produce one whose readership is undefined --
  // and this is the field that decides whether a provider's people can see what an administrator
  // said about their data.
  const to = report.providerUoi;
  if (!to) {
    return {
      report,
      changed: false,
      errors: [
        'The report carries no providerUoi, so there is no organization to address these comments to. A comment is visible to everyone with an account at the organization it names, and that scope is not inferred.'
      ]
    };
  }

  const errors: string[] = [];
  // Keyed by index into `changes`, so two rows commenting on one change both land, in row order.
  const additions = new Map<number, ReportComment[]>();

  for (const row of withComments) {
    const indices = report.changes
      .map((c, i) => [c, i] as const)
      .filter(
        ([c]) =>
          c.resourceName === row.resourceName &&
          (row.fieldName === undefined || c.fieldName === row.fieldName) &&
          (row.lookupValue === undefined || c.lookupValue === row.lookupValue)
      )
      .map(([, i]) => i);

    if (indices.length === 0) {
      errors.push(`${rowLabel(row)}: matches no change in the report, so its comment has nowhere to go.`);
      continue;
    }
    if (indices.length > 1) {
      errors.push(`${rowLabel(row)}: matches ${indices.length} changes — name the lookup value to disambiguate.`);
      continue;
    }

    const bucket = additions.get(indices[0]) ?? [];
    bucket.push({ timestamp: now, to, message: row.comment as string });
    additions.set(indices[0], bucket);
  }

  if (errors.length > 0 || additions.size === 0) return { report, changed: false, errors };

  return {
    report: {
      ...report,
      changes: report.changes.map((c, i) => {
        const added = additions.get(i);
        return added ? { ...c, conversations: [...(c.conversations ?? []), ...added] } : c;
      })
    },
    changed: true,
    errors: []
  };
};
