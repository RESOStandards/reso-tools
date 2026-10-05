/**
 * Planning a decision push: what gets sent, in what order, and when nothing gets sent.
 *
 * The flow, in Josh's words (2026-10-04): "we got a variations report, we're submitting it for
 * review as Admin on behalf of the provider, then, after we started the review, we selected FT on
 * the item I mentioned, and added a comment about it as admin."
 *
 * The comment and the decision travel on two different requests, and the order between them is
 * forced rather than chosen. A comment persists only through a report save, and a report save resets
 * every pool row it touches to `pending` with the outcome wiped -- `updateExisting` in the service
 * writes `"status" = 'pending', "outcome" = null` on re-submission. So a report saved after a
 * decision undoes it. What this file pins is the consequence: whether a report save is needed at
 * all, and that a sheet with one bad row sends neither request.
 */

import { describe, it, expect } from 'vitest';
import { planDecisionPush, unappliedCount, decisionExitCode, formatDecisionResult, displayKey } from '../../src/cli/decisions-command.js';
import { VARIATION_KEY_SEPARATOR } from '../../src/variations/decisions.js';
import type { SaveVariationDecisionsResult } from '../../src/variations/submit.js';

const US = VARIATION_KEY_SEPARATOR;
const NOW = '2026-10-05T04:30:00.000Z';

const report = () => ({
  version: '2.1',
  providerUoi: 'T00000045',
  providerUsi: '50013',
  recipientUoi: 'M00000574',
  changes: [
    { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', level: 'lookup' },
    { resourceName: 'Property', fieldName: 'OKC_SoilType', level: 'field' }
  ]
});

const plan = (rows: ReadonlyArray<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  planDecisionPush({ report: report(), rows: rows as never, now: NOW, ...over });

const emptyResult = (over: Partial<SaveVariationDecisionsResult> = {}): SaveVariationDecisionsResult => ({
  applied: [],
  stale: [],
  noop: [],
  rejected: [],
  locked: [],
  rollupNotificationsFanOutTo: [],
  ...over
});

describe('planning', () => {
  it('produces the decision and the annotated report from one row', async () => {
    const result = plan([
      { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft', comment: 'DD has no 4-month term.' }
    ]);
    expect(result.errors).toEqual([]);
    expect(result.decisions).toEqual([{ variationKey: `Property${US}LeaseTerm${US}Months - 4`, action: 'submit-to-ft' }]);
    expect(result.report.changes[0].conversations?.[0].message).toBe('DD has no 4-month term.');
  });

  it('needs a report save when a comment has to be persisted', async () => {
    // A report save is the only thing that persists a comment, so the need is derived, not optional.
    const result = plan([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore', comment: 'Local soil taxonomy.' }]);
    expect(result.needsReportSave).toBe(true);
    expect(result.commentsAdded).toBe(1);
  });

  it('does NOT save the report when no row carries a comment', async () => {
    // The save resets every row it touches to pending. Doing it when nothing needs persisting would
    // revert decisions an earlier run applied, for no gain.
    const result = plan([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }]);
    expect(result.needsReportSave).toBe(false);
    expect(result.commentsAdded).toBe(0);
  });

  it('saves the report on openReview even with no comments, to open a review that is not there yet', async () => {
    const result = plan([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }], { openReview: true });
    expect(result.needsReportSave).toBe(true);
  });

  it('leaves the report object untouched when there is nothing to attach', async () => {
    const before = report();
    const result = planDecisionPush({ report: before, rows: [{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }], now: NOW });
    expect(result.report).toBe(before);
  });
});

describe('a comment names who may read it, and nothing about who wrote it', () => {
  it('addresses the comment to the report’s organization and asserts no author', async () => {
    // Josh, 2026-10-04: "it's from Admin targeted at providerUoi", and "that means anyone who has an
    // account at providerUoi sees it." So `to` is a visibility scope, read off the report. `from` is
    // filled from the auth context, which a client cannot read: the identity is columns on the token
    // row and the bearer token is an opaque key with no claims in it.
    const result = plan([{ resourceName: 'Property', fieldName: 'OKC_SoilType', comment: 'a note' }]);
    expect(result.report.changes[1].conversations?.[0]).toEqual({ timestamp: NOW, to: 'T00000045', message: 'a note' });
  });

  it('needs no identity passed in to attach one', async () => {
    const result = planDecisionPush({
      report: report(),
      rows: [{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore', comment: 'a note' }],
      now: NOW
    });
    expect(result.errors).toEqual([]);
    expect(result.commentsAdded).toBe(1);
    expect(result.decisions).toHaveLength(1);
  });
});

describe('a sheet that does not validate sends nothing', () => {
  it('sends neither request when a decision row is bad', async () => {
    const result = plan([
      { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft', comment: 'fine' },
      { resourceName: 'Property', fieldName: 'NotInTheReport', action: 'ignore' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.decisions).toEqual([]);
    // And no report save either: a comment persisted with no decision behind it is the half-applied
    // state the whole-batch refusal exists to prevent.
    expect(result.needsReportSave).toBe(false);
    expect(result.commentsAdded).toBe(0);
  });

  it('reports the errors from BOTH halves in one pass', async () => {
    // One bad row can fail as a comment target and as a decision target. Reporting only the first
    // would make the operator fix the sheet one request at a time.
    const result = plan([{ resourceName: 'Property', fieldName: 'Nowhere', action: 'ignore', comment: 'orphan' }]);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('refuses the batch when only the comment half fails', async () => {
    const result = plan([
      { resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' },
      { resourceName: 'Property', fieldName: 'Nowhere', comment: 'orphan' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.decisions).toEqual([]);
  });
});

describe('reporting what the service did', () => {
  it('counts stale, rejected and locked as unapplied — but never noop', async () => {
    // "Already in the state you asked for" is the requested end state. Counting it against the run
    // would make a correct replay look like a partial failure.
    expect(unappliedCount(emptyResult({ noop: [{ variationKey: 'a', reason: 'already in target state (ft-submitted)' }] }))).toBe(0);
    expect(unappliedCount(emptyResult({ rejected: [{ variationKey: 'a', reason: 'not found' }] }))).toBe(1);
    expect(unappliedCount(emptyResult({ locked: [{ variationKey: 'a', reason: 'locked' }] }))).toBe(1);
    expect(unappliedCount(emptyResult({ stale: [{ variationKey: 'a', resolvedBy: 'T1', resolvedAt: NOW }] }))).toBe(1);
  });

  it('exits non-zero on a partial result, so a scripted replay can tell it from a clean one', async () => {
    expect(decisionExitCode(emptyResult({ applied: [{ variationKey: 'a', action: 'ignore' }] }))).toBe(0);
    expect(decisionExitCode(emptyResult({ applied: [{ variationKey: 'a', action: 'ignore' }], rejected: [{ variationKey: 'b', reason: 'no' }] }))).toBe(4);
  });

  it('names every declined item and why, not just a count', async () => {
    const text = formatDecisionResult(
      emptyResult({
        applied: [{ variationKey: `Property${US}LeaseTerm${US}Months - 4`, action: 'submit-to-ft' }],
        stale: [{ variationKey: `Property${US}Roof${US}Steel`, resolvedBy: 'T00000076', resolvedAt: NOW, currentOutcome: 'ignored' }],
        locked: [
          {
            variationKey: `Property${US}OKC_SoilType`,
            reason: 'A report holding this item is locked for review by someone else.',
            lock: { displayName: 'Anna', email: 'anna@example.org', expiresAt: '2026-10-05T14:30:00Z' }
          }
        ]
      })
    );
    expect(text).toContain('Property.LeaseTerm.Months - 4');
    expect(text).toContain('already resolved by T00000076');
    expect(text).toContain('Anna');
    expect(text).toMatch(/2 item\(s\) were NOT applied/);
  });

  it('shows the separator-joined key as dots, since the separator prints as nothing', async () => {
    expect(displayKey(`Property${US}Roof${US}Steel`)).toBe('Property.Roof.Steel');
  });
});
