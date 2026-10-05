/**
 * `submit-variation-decisions` — the pure half.
 *
 * Planning and formatting live here so they can be tested without a network, as
 * `variations-review-command.ts` does; the Commander wiring in `index.ts` makes the one request.
 *
 * ONE REQUEST. Josh, 2026-10-04: "client passes the variations report and comments and the backend
 * should do everything from there", and it "should make the same output as if a user is on the UI".
 * Marking an item is a field on its change, not a separate call, so the command marks the report and
 * pushes it once. The backend builds the flat `changes` array, derives `requestedAction` from the
 * flags, derives `editorInfo` from the auth context, writes the pool rows and notifies.
 *
 * NOTHING IS SENT UNTIL THE WHOLE SHEET VALIDATES. The push replaces the review rows this report
 * owns, so a half-applied sheet is worse than none: it would land a destructive replace carrying
 * only some of what the operator meant.
 */

import { applySheetToReport, countEntries } from '../variations/decisions.js';
import type { AppliedRow, DecisionReport, DecisionSheetRow } from '../variations/decisions.js';

export interface PlanDecisionPushInput {
  readonly report: DecisionReport;
  readonly rows: ReadonlyArray<DecisionSheetRow>;
  /** Passed in, not read from the clock, so a plan is a function of its inputs. */
  readonly now: string;
}

export interface DecisionPushPlan {
  /** The report to push, with flags and comments attached. Identical to the input when nothing applied. */
  readonly report: DecisionReport;
  readonly applied: ReadonlyArray<AppliedRow>;
  /** True when the report differs from the one given, so a caller can skip a pointless push. */
  readonly changed: boolean;
  /** Entries the report carries across all five level buckets. */
  readonly entryCount: number;
  /** Every unusable row. Non-empty means push nothing. */
  readonly errors: ReadonlyArray<string>;
}

/** Mark the report from the sheet, or report the reasons the sheet cannot mark it. */
export const planDecisionPush = (input: PlanDecisionPushInput): DecisionPushPlan => {
  const result = applySheetToReport(input.report, input.rows, input.now);
  return {
    report: result.report,
    applied: result.applied,
    changed: result.report !== input.report,
    entryCount: countEntries(input.report),
    errors: result.errors
  };
};

/** What each action will read as once the service has derived it onto the pool row. */
const REQUESTED_ACTION: Readonly<Record<string, string>> = {
  ignore: 'ignore',
  remove: 'remove',
  'submit-to-ft': 'fast-track'
};

/**
 * What the push will ask for, one line per row.
 *
 * Names the derived `requestedAction` beside the sheet's own word, because those are the terms the
 * review pool and the UI will show afterwards — `submit-to-ft` appears there as `fast-track`, and an
 * operator checking their work should not have to learn that from a mismatch.
 */
export const formatPlan = (plan: DecisionPushPlan): string =>
  plan.applied
    .map(row => {
      const parts = [
        row.action ? `${row.action} → requestedAction '${REQUESTED_ACTION[row.action] ?? row.action}'` : undefined,
        row.commented ? 'comment' : undefined
      ].filter(Boolean);
      return `  ${row.element} [${row.bucket}]: ${parts.join(' + ')}`;
    })
    .join('\n');
