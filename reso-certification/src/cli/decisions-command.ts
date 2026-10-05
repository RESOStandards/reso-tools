/**
 * `submit-variation-decisions` — the pure half.
 *
 * Planning and formatting live here so they can be tested without a network, exactly as
 * `variations-review-command.ts` does; the Commander wiring in `index.ts` does the two requests.
 *
 * THE ORDER IS NOT A PREFERENCE. A comment is persisted by saving the report -- that is where the
 * review UI puts it too -- and a report save resets every pool row it touches to `pending` with its
 * `outcome` wiped (`updateExisting` in the service's variations-review module writes
 * `"status" = 'pending', "outcome" = null`). So a report saved AFTER a decision would undo it. The
 * comment goes first and the decision second, and no flag reorders them.
 *
 * NOTHING IS SENT UNTIL BOTH HALVES VALIDATE. The comment and the decision travel on different
 * requests, so a sheet half of which is wrong could otherwise leave a comment persisted with no
 * decision behind it, or the reverse. Planning collects the errors from both and refuses the batch
 * as a whole -- the same reason `decisionsFromSheet` voids its batch rather than applying part of it.
 */

import { annotateReportWithComments, decisionsFromSheet } from '../variations/decisions.js';
import type { Decision, DecisionReport, DecisionSheetRow } from '../variations/decisions.js';
import type { SaveVariationDecisionsResult } from '../variations/submit.js';

export interface PlanDecisionPushInput {
  readonly report: DecisionReport;
  readonly rows: ReadonlyArray<DecisionSheetRow>;
  /** Passed in, not read from the clock, so a plan is a function of its inputs. */
  readonly now: string;
  /** Save the report even when no row carries a comment — the explicit "open the review" case. */
  readonly openReview?: boolean;
}

export interface DecisionPushPlan {
  /** The report to save, with any comments attached. Identical to the input when there are none. */
  readonly report: DecisionReport;
  readonly decisions: ReadonlyArray<Decision>;
  readonly commentsAdded: number;
  /**
   * Whether the report has to be saved before the decisions go.
   *
   * True when a comment needs persisting, because a report save is the only thing that persists
   * one. Also true on `openReview`, for the case where the review is not open yet and the rows
   * the decisions address do not exist to be decided.
   */
  readonly needsReportSave: boolean;
  /** Every unusable row, from both halves. Non-empty means send nothing. */
  readonly errors: ReadonlyArray<string>;
}

/** Build the two requests from a sheet, or the reasons the sheet cannot produce them. */
export const planDecisionPush = (input: PlanDecisionPushInput): DecisionPushPlan => {
  const annotated = annotateReportWithComments(input.report, input.rows, input.now);
  const decided = decisionsFromSheet(input.report, input.rows);

  // Both are consulted even when the first has already failed, so one run names every bad row
  // rather than making the operator fix them one request at a time.
  const commentsAdded = input.rows.filter(r => typeof r.comment === 'string' && r.comment.length > 0).length;

  const errors = [...annotated.errors, ...decided.errors];

  if (errors.length > 0) {
    return { report: input.report, decisions: [], commentsAdded: 0, needsReportSave: false, errors };
  }

  return {
    report: annotated.report,
    decisions: decided.decisions,
    commentsAdded: annotated.changed ? commentsAdded : 0,
    needsReportSave: annotated.changed || input.openReview === true,
    errors: []
  };
};

/** `Property.LeaseTerm.Months - 4` from a separator-joined key. */
export const displayKey = (variationKey: string): string => variationKey.split(String.fromCharCode(31)).join('.');

/**
 * Items the service did not act on. `noop` is excluded deliberately: "already in the state you asked
 * for" is the requested end state, so counting it as a failure would make a correct re-run look bad.
 */
export const unappliedCount = (result: SaveVariationDecisionsResult): number =>
  result.stale.length + result.rejected.length + result.locked.length;

/**
 * Exit code. 0 only when nothing was declined.
 *
 * 4 rather than 0 for a partial result, because the common use is a scripted replay across
 * providers: a run where two of five items were stale has to be distinguishable from a clean one
 * without parsing the output.
 */
export const decisionExitCode = (result: SaveVariationDecisionsResult): number => (unappliedCount(result) > 0 ? 4 : 0);

/** The human report. Applied first, then every bucket that means something did not happen. */
export const formatDecisionResult = (result: SaveVariationDecisionsResult): string => {
  const lines: string[] = [];

  lines.push(`Applied ${result.applied.length} decision(s).`);
  for (const a of result.applied) {
    lines.push(`  ✓ ${displayKey(a.variationKey)} → ${a.action}${a.outcome ? ` (${a.outcome})` : ''}`);
  }

  for (const n of result.noop) {
    lines.push(`  = ${displayKey(n.variationKey)} — ${n.reason}`);
  }

  for (const s of result.stale) {
    lines.push(
      `  ! ${displayKey(s.variationKey)} — already resolved by ${s.resolvedBy} at ${s.resolvedAt.slice(0, 19)}${
        s.currentOutcome ? ` as ${s.currentOutcome}` : ''
      }. Your decision was not applied.`
    );
  }

  for (const r of result.rejected) {
    lines.push(`  ✗ ${displayKey(r.variationKey)} — refused: ${r.reason}`);
  }

  for (const l of result.locked) {
    const who = l.lock ? ` Held by ${l.lock.displayName} <${l.lock.email}> until ${l.lock.expiresAt}.` : '';
    lines.push(`  ⊘ ${displayKey(l.variationKey)} — ${l.reason}${who}`);
  }

  if (unappliedCount(result) > 0) {
    lines.push(`${unappliedCount(result)} item(s) were NOT applied. Nothing above marked ✓ is in doubt; the rest need another pass.`);
  }

  if (result.rollupNotificationsFanOutTo.length > 0) {
    lines.push(`Notified: ${result.rollupNotificationsFanOutTo.join(', ')}.`);
  }

  return lines.join('\n');
};
