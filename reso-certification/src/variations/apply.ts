/**
 * Apply a decisions sheet to a variations report that is ALREADY UNDER REVIEW, as a merge.
 *
 * `submit-variation-decisions` marks the report a run wrote and pushes it as a FULL REPLACE, which starts (or
 * restarts) a review. This is the other half: the review exists, the sheet holds RESO's answers, and the answers
 * go onto it without replacing anything. It is the request the desktop's Save sends: only the items the sheet
 * changes, with no `replaceReviewRows`, so the service merges them into the stored report item by item and every
 * other item, comment and decision is left as it was.
 *
 * The stored report is read first, and every row must name an item in it. A sheet with any unusable row sends
 * nothing, because a half-applied sheet leaves someone reconciling which rows landed.
 *
 * Two rules make a re-run safe and keep the report and the review pool in step:
 *
 * - EVERY FLAG, EVERY TIME. Each item sent carries all three of `ignore`, `flaggedForFastTrack` and `remove`,
 *   at the item's resulting values: the row's action where it has one, the stored decision where it does not.
 *   The service merges the report field by field, but rebuilds the pool row's requested action from what was
 *   sent, so a comment-only item sent without its flags keeps the decision in the report and drops it from the
 *   pool. The desktop sends every flag for the same reason.
 * - A COMMENT ALREADY ON THE THREAD IS NOT SENT AGAIN. The service appends every comment it receives, so the
 *   same sheet applied twice would say everything twice.
 *
 * The pool row is read as well as the report. They can disagree: a comment-only save from elsewhere clears the
 * pool row's requested action while the report keeps the flag. A row whose report already shows its decision is
 * still sent when its pool row says something else, so a re-run repairs the pool instead of skipping the row.
 *
 * After a save, the report and the pool are read back and every applied row is checked against both.
 */

import {
  cliAuthRejectedMessage,
  cliAuthRequiredMessage,
  lockedError,
  mintProviderToken,
  resolveServicesUrl,
  serviceError
} from '../sdk/common.js';
import type { LockHolderInfo } from '../sdk/common.js';
import { SHEET_ACTIONS, type SheetAction } from './decisions.js';
import { type VariationReviewItem, listVariationReviewItemsViaService } from './review.js';

const REPORT_ROUTE = '/v2/certification/variations-reports';

/**
 * Who a comment is from, when RESO writes it. The desktop client writes RESO's comments with this value and
 * decides which side said something by it, so a comment from this command reads as RESO's there. The service
 * stores `from` as sent and does not derive it.
 */
export const RESO_COMMENT_AUTHOR = 'RESO';

/** The four coordinates a report is addressed by. */
export interface ReportCoordinates {
  readonly version: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
}

/** One sheet row, as `parseDecisionsCsv` reads it. */
export interface ApplyRow {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  /** As written in the sheet; checked here against `SHEET_ACTIONS`. */
  readonly action?: string;
  readonly comment?: string;
}

/** A comment on an item's thread, as the service stores it. */
export interface StoredComment {
  readonly timestamp?: string;
  readonly from?: string;
  readonly to?: string;
  readonly message?: string;
}

/** An item of the stored report, as far as this module reads it. */
export interface StoredChange {
  readonly resourceName?: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly ignore?: boolean;
  readonly flaggedForFastTrack?: boolean;
  readonly remove?: boolean;
  readonly suggestions?: ReadonlyArray<unknown>;
  readonly conversations?: ReadonlyArray<StoredComment>;
}

/** The stored report, as far as this module reads it. */
export interface StoredReport {
  readonly changes: ReadonlyArray<StoredChange>;
}

/** The decision an item carries, as the three flags. */
interface Flags {
  readonly ignore: boolean;
  readonly flaggedForFastTrack: boolean;
  readonly remove: boolean;
}

const FLAGS_OF: Readonly<Record<SheetAction, Flags>> = {
  ignore: { ignore: true, flaggedForFastTrack: false, remove: false },
  remove: { ignore: false, flaggedForFastTrack: false, remove: true },
  'submit-to-ft': { ignore: false, flaggedForFastTrack: true, remove: false }
};

const storedFlags = (change: StoredChange): Flags => ({
  ignore: change.ignore === true,
  flaggedForFastTrack: change.flaggedForFastTrack === true,
  remove: change.remove === true
});

/** The decision as the sheet would write it, for a message. */
const actionOf = (flags: Flags): SheetAction | undefined =>
  flags.flaggedForFastTrack ? 'submit-to-ft' : flags.remove ? 'remove' : flags.ignore ? 'ignore' : undefined;

/**
 * The pool row's requested action for a decision, derived as the service derives it from the flags it receives:
 * Fast Track first, then remove, then ignore.
 */
const requestedActionOf = (flags: Flags): string | undefined =>
  flags.flaggedForFastTrack ? 'fast-track' : flags.remove ? 'remove' : flags.ignore ? 'ignore' : undefined;

const sameFlags = (a: Flags, b: Flags): boolean =>
  a.ignore === b.ignore && a.flaggedForFastTrack === b.flaggedForFastTrack && a.remove === b.remove;

const isSheetAction = (value: string): value is SheetAction => (SHEET_ACTIONS as ReadonlyArray<string>).includes(value);

/** An item's identity: resource, field and lookup value, with an absent field or value written empty. */
const keyOf = (item: { readonly resourceName?: string; readonly fieldName?: string; readonly lookupValue?: string }): string =>
  [item.resourceName ?? '', item.fieldName ?? '', item.lookupValue ?? ''].join('\u001f');

const labelOf = (item: { readonly resourceName?: string; readonly fieldName?: string; readonly lookupValue?: string }): string =>
  [item.resourceName, item.fieldName, item.lookupValue].filter(Boolean).join('.');

/**
 * This report's pool rows, as element key to requested action (null for none). A row belongs to the report when
 * its submission names the same provider, system and recipient, and the same DD version where the row records one.
 * An element with no row here is not in review for this report.
 */
export const poolActionsFor = (items: ReadonlyArray<VariationReviewItem>, c: ReportCoordinates): ReadonlyMap<string, string | null> =>
  new Map(
    items.flatMap(item => {
      const mine = item.provenance.find(
        p =>
          p.providerUoi === c.providerUoi &&
          p.providerUsi === c.providerUsi &&
          p.recipientUoi === c.recipientUoi &&
          (p.ddVersion === undefined || p.ddVersion === c.version)
      );
      return mine
        ? [
            [
              keyOf({
                resourceName: item.resourceName,
                fieldName: item.fieldName ?? undefined,
                lookupValue: item.lookupValue ?? undefined
              }),
              mine.requestedAction ?? null
            ] as const
          ]
        : [];
    })
  );

/** One item the save will send, and what it changes. */
export interface PlannedItem {
  readonly element: string;
  /** The decision the item ends with, or undefined for none. */
  readonly action?: SheetAction;
  /** The decision it had, when the row changes it. */
  readonly replaces?: SheetAction;
  /** The comment added to its thread. */
  readonly comment?: string;
  /** The requested action the pool row had, when the item is sent to bring the pool row back in line with the report. */
  readonly repairsPool?: string;
  /** The change as it goes on the wire. */
  readonly change: Readonly<Record<string, unknown>>;
}

export interface ApplyPlan {
  readonly items: ReadonlyArray<PlannedItem>;
  /** Rows that ask for nothing the report does not already have: the same decision, and a comment already said. */
  readonly unchanged: ReadonlyArray<string>;
  /** Things worth knowing that do not stop the save. */
  readonly warnings: ReadonlyArray<string>;
  /** Unusable rows. Non-empty means nothing is sent. */
  readonly errors: ReadonlyArray<string>;
}

/** How one row came out of planning. */
type Assessment =
  | { readonly kind: 'item'; readonly item: PlannedItem; readonly warning?: string }
  | { readonly kind: 'unchanged'; readonly note: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * What the sheet would change on the stored report. A pure function of its inputs: `now` is the comments'
 * timestamp, passed in so a test can assert the whole plan.
 */
export const planApply = (input: {
  readonly stored: StoredReport;
  readonly rows: ReadonlyArray<ApplyRow>;
  readonly providerUoi: string;
  readonly now: string;
  /** This report's pool rows (`poolActionsFor`). Omitted, the plan is made from the report alone. */
  readonly pooled?: ReadonlyMap<string, string | null>;
}): ApplyPlan => {
  const storedByKey = new Map(input.stored.changes.map(change => [keyOf(change), change]));
  const rowCounts = input.rows.reduce((acc, row) => acc.set(keyOf(row), (acc.get(keyOf(row)) ?? 0) + 1), new Map<string, number>());

  const assessed: ReadonlyArray<Assessment> = input.rows.map((row): Assessment => {
    const label = labelOf(row);
    const action = row.action?.trim().toLowerCase() || undefined;
    const comment = row.comment?.trim() || undefined;
    if ((rowCounts.get(keyOf(row)) ?? 0) > 1)
      return { kind: 'error', message: `${label}: named by more than one row – merge them into one.` };
    if (action !== undefined && !isSheetAction(action)) {
      return { kind: 'error', message: `${label}: Action "${row.action}" is not one of ${SHEET_ACTIONS.join(', ')}.` };
    }
    const stored = storedByKey.get(keyOf(row));
    if (!stored) return { kind: 'error', message: `${label}: matches no item in the stored report.` };
    if (action === undefined && comment === undefined) return { kind: 'unchanged', note: `${label}: no Action and no Comment` };

    const before = storedFlags(stored);
    const after = action ? FLAGS_OF[action] : before;
    const alreadySaid =
      comment !== undefined && (stored.conversations ?? []).some(c => c.from === RESO_COMMENT_AUTHOR && c.message?.trim() === comment);
    const newComment = comment !== undefined && !alreadySaid ? comment : undefined;
    const decisionChanges = !sameFlags(before, after);
    const pooledAction = input.pooled?.has(keyOf(row)) ? (input.pooled.get(keyOf(row)) ?? undefined) : undefined;
    const poolDisagrees = input.pooled?.has(keyOf(row)) === true && pooledAction !== requestedActionOf(after);
    if (!decisionChanges && newComment === undefined && !poolDisagrees) {
      return {
        kind: 'unchanged',
        note: `${label}: already ${actionOf(after) ?? 'without a decision'}${comment ? ', and the comment is already on the thread' : ''}`
      };
    }

    const suggestionCount = stored.suggestions?.length ?? 0;
    const warning =
      action === 'ignore' && decisionChanges && suggestionCount > 1
        ? `${label}: the ignore covers the element, so it clears all ${suggestionCount} of its suggestions.`
        : undefined;
    const ends = actionOf(after);
    const had = actionOf(before);
    return {
      kind: 'item',
      item: {
        element: label,
        ...(ends ? { action: ends } : {}),
        ...(decisionChanges && had ? { replaces: had } : {}),
        ...(newComment ? { comment: newComment } : {}),
        ...(poolDisagrees ? { repairsPool: pooledAction ?? 'none' } : {}),
        change: {
          resourceName: row.resourceName,
          ...(row.fieldName ? { fieldName: row.fieldName } : {}),
          ...(row.lookupValue ? { lookupValue: row.lookupValue } : {}),
          ...after,
          ...(newComment
            ? { conversations: [{ timestamp: input.now, from: RESO_COMMENT_AUTHOR, to: input.providerUoi, message: newComment }] }
            : {})
        }
      },
      ...(warning ? { warning } : {})
    };
  });

  return {
    items: assessed.flatMap(a => (a.kind === 'item' ? [a.item] : [])),
    unchanged: assessed.flatMap(a => (a.kind === 'unchanged' ? [a.note] : [])),
    warnings: assessed.flatMap(a => (a.kind === 'item' && a.warning ? [a.warning] : [])),
    errors: assessed.flatMap(a => (a.kind === 'error' ? [a.message] : []))
  };
};

/** Items whose stored state, after the save, does not show what the plan sent. */
export const verifyApplied = (plan: ApplyPlan, after: StoredReport): ReadonlyArray<string> => {
  const byKey = new Map(after.changes.map(change => [keyOf(change), change]));
  return plan.items.flatMap(item => {
    const sent = item.change as StoredChange;
    const stored = byKey.get(keyOf(sent));
    if (!stored) return [`${item.element}: no longer in the report`];
    const problems = [
      ...(sameFlags(storedFlags(stored), storedFlags(sent))
        ? []
        : [`the decision is ${actionOf(storedFlags(stored)) ?? 'none'}, not ${item.action ?? 'none'}`]),
      ...(item.comment && !(stored.conversations ?? []).some(c => c.message?.trim() === item.comment)
        ? ['the comment is not on the thread']
        : [])
    ];
    return problems.length ? [`${item.element}: ${problems.join('; ')}`] : [];
  });
};

/** Items whose pool row, after the save, does not carry the requested action the sent flags give. */
export const verifyPool = (plan: ApplyPlan, pooledAfter: ReadonlyMap<string, string | null>): ReadonlyArray<string> =>
  plan.items.flatMap(item => {
    const sent = item.change as StoredChange;
    const key = keyOf(sent);
    if (!pooledAfter.has(key)) return [`${item.element}: not in the review pool`];
    const expected = requestedActionOf(storedFlags(sent));
    const actual = pooledAfter.get(key) ?? undefined;
    return actual === expected ? [] : [`${item.element}: the pool row requests ${actual ?? 'nothing'}, not ${expected ?? 'nothing'}`];
  });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The report route for these coordinates. */
const reportUrl = (servicesUrl: string, c: ReportCoordinates): string =>
  `${servicesUrl}${REPORT_ROUTE}/${[c.version, c.providerUoi, c.providerUsi, c.recipientUoi].map(encodeURIComponent).join('/')}`;

interface ServiceAuthInput {
  readonly bearerToken?: string;
  readonly fromCli?: boolean;
}

const resolveToken = async (input: ServiceAuthInput, what: string): Promise<string> => {
  const token = input.bearerToken ?? (await mintProviderToken());
  if (!token) {
    throw serviceError(
      'AUTH_REQUIRED',
      input.fromCli ? cliAuthRequiredMessage(what) : `${what} requires authentication. Pass a token (bearerToken).`
    );
  }
  return token;
};

const authRejected = (input: ServiceAuthInput, what: string): Error =>
  serviceError('AUTH_REJECTED', input.fromCli ? cliAuthRejectedMessage(what) : `${what}: the token was rejected or has expired.`);

/**
 * Read the report under review. The read route takes a fifth path segment, a certification request id, which
 * the service does not use: a report is addressed by its four coordinates.
 */
export const readStoredReportViaService = async (
  input: ServiceAuthInput & { readonly coordinates: ReportCoordinates }
): Promise<StoredReport> => {
  const what = 'Reading the variations report';
  const token = await resolveToken(input, what);
  const response = await fetch(`${reportUrl(resolveServicesUrl(), input.coordinates)}/current`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 401 || response.status === 403) throw authRejected(input, what);
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
    throw serviceError('SERVICE_ERROR', `${what} failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body) || !Array.isArray(body.changes)) {
    throw serviceError(
      'SERVICE_ERROR',
      `${what}: there is no report under review for provider ${input.coordinates.providerUoi}, system ${input.coordinates.providerUsi}, recipient ${input.coordinates.recipientUoi}, DD ${input.coordinates.version}.`
    );
  }
  return { changes: body.changes as ReadonlyArray<StoredChange> };
};

const lockFrom = (body: unknown): LockHolderInfo | undefined => {
  if (!isRecord(body) || !isRecord(body.lock)) return undefined;
  const { displayName, email, expiresAt, heldByProviderUoi } = body.lock;
  if (typeof displayName !== 'string' || typeof email !== 'string' || typeof expiresAt !== 'string') return undefined;
  return { displayName, email, expiresAt, ...(typeof heldByProviderUoi === 'string' ? { heldByProviderUoi } : {}) };
};

export interface ApplyResult {
  readonly plan: ApplyPlan;
  /** True when nothing was sent: a dry run, an unusable sheet, or nothing to change. */
  readonly sent: boolean;
  /** After a save: items whose stored state does not show what was sent. Empty means every row landed. */
  readonly mismatches: ReadonlyArray<string>;
}

/**
 * Plan the sheet against the stored report and, unless this is a dry run, save it as one merge. Nothing is sent
 * when any row is unusable or when nothing would change.
 */
export const applyVariationDecisionsViaService = async (
  input: ServiceAuthInput & {
    readonly coordinates: ReportCoordinates;
    readonly rows: ReadonlyArray<ApplyRow>;
    readonly dryRun?: boolean;
    readonly now?: string;
  }
): Promise<ApplyResult> => {
  const what = 'Applying the decisions';
  const stored = await readStoredReportViaService(input);
  const readPool = async (): Promise<ReadonlyMap<string, string | null>> =>
    poolActionsFor(
      await listVariationReviewItemsViaService({
        ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
        ...(input.fromCli ? { fromCli: input.fromCli } : {})
      }),
      input.coordinates
    );
  const plan = planApply({
    stored,
    rows: input.rows,
    providerUoi: input.coordinates.providerUoi,
    now: input.now ?? new Date().toISOString(),
    pooled: await readPool()
  });
  if (input.dryRun || plan.errors.length > 0 || plan.items.length === 0) return { plan, sent: false, mismatches: [] };

  const token = await resolveToken(input, what);
  const response = await fetch(reportUrl(resolveServicesUrl(), input.coordinates), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    // A DELTA: no `replaceReviewRows`, so the service merges these items and authorizes no delete. The editor is
    // left empty for the service to record from the caller's token.
    body: JSON.stringify({
      description: 'RESO Data Dictionary Change Log',
      ...input.coordinates,
      changes: plan.items.map(item => item.change),
      editorInfo: []
    })
  });
  if (response.status === 401 || response.status === 403) throw authRejected(input, what);
  if (response.status === 409) {
    const lock = lockFrom(await response.json().catch(() => undefined));
    const who = lock ? `${lock.displayName} (${lock.email})` : 'another user';
    throw lockedError(
      `${what} was refused: this report is locked for review by ${who}${lock ? `, until ${lock.expiresAt}` : ''}. Ask them to release it.`,
      lock
    );
  }
  if (response.status === 503) {
    throw serviceError(
      'SERVICE_ERROR',
      `${what} was refused: the service could not verify whether this report is being reviewed, so it wrote nothing. Retry shortly.`
    );
  }
  if (!response.ok && response.status !== 304) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
    throw serviceError('SERVICE_ERROR', `${what} failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}`);
  }

  const after = await readStoredReportViaService(input);
  return { plan, sent: true, mismatches: [...verifyApplied(plan, after), ...verifyPool(plan, await readPool())] };
};
