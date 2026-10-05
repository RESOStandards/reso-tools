/**
 * Review decisions from a sheet — matching rows to report changes, building the decision payload, and
 * attaching an admin comment.
 *
 * The flow this serves, in Josh's words (2026-10-04): "we got a variations report, we're submitting it
 * for review as Admin on behalf of the provider, then, after we started the review, we selected FT on
 * the item I mentioned, and added a comment about it as admin."
 *
 * So the order matters. The report submission opens the review and creates the pool rows. The FT
 * selection and the comment come AFTER, which is why they are not part of the opening payload: the
 * decision goes to `POST /v2/certification/save-variation-decisions`, and the comment lands in
 * `conversations[]` on the change and is persisted by a report save. One sheet row can therefore drive
 * two routes, and these functions produce the input for each without performing either.
 *
 * Two things under test, both pure:
 *   - `decisionsFromSheet` — sheet rows to a decisions payload, with the variationKey DERIVED
 *   - `annotateReportWithComments` — sheet comments onto the matching changes' `conversations[]`
 */

import { describe, it, expect } from 'vitest';
import { decisionsFromSheet, annotateReportWithComments, VARIATION_KEY_SEPARATOR } from '../../src/variations/decisions.js';

/** The unit separator the pool joins a variation key with. Never typed as a literal in a sheet. */
const US = VARIATION_KEY_SEPARATOR;

const report = () => ({
  version: '2.1',
  providerUoi: 'T00000045',
  providerUsi: '50013',
  recipientUoi: 'M00000574',
  changes: [
    { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', level: 'lookup' },
    { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 3', level: 'lookup' },
    { resourceName: 'Property', fieldName: 'OKC_SoilType', level: 'field' },
    { resourceName: 'Property', fieldName: 'Roof', lookupValue: 'Steel', level: 'lookup' }
  ]
});

const NOW = '2026-10-05T04:30:00.000Z';
const ADMIN = { username: 'admin-user', displayName: 'Admin User', providerUoi: 'RESO' };

describe('decisionsFromSheet', () => {
  it('derives the variationKey from the matched change, never from the sheet', () => {
    const { decisions, errors } = decisionsFromSheet(report(), [
      { resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft' }
    ]);
    expect(errors).toEqual([]);
    expect(decisions).toHaveLength(1);
    // The separator is a non-printing control character: a hand-written key looks right, never matches,
    // and errors nowhere. So the key is built, and the test asserts the built shape rather than a literal.
    expect(decisions[0].variationKey).toBe(`Property${US}LeaseTerm${US}Months - 4`);
    expect(decisions[0].action).toBe('submit-to-ft');
  });

  it('builds a field-level key with no lookup segment', () => {
    const { decisions } = decisionsFromSheet(report(), [
      { resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }
    ]);
    expect(decisions[0].variationKey).toBe(`Property${US}OKC_SoilType`);
  });

  it('refuses a row that matches no change in the report', () => {
    const { decisions, errors } = decisionsFromSheet(report(), [
      { resourceName: 'Property', fieldName: 'NotInTheReport', action: 'ignore' }
    ]);
    expect(decisions).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/matches no change/i);
  });

  it('refuses a row that matches more than one change', () => {
    // Ambiguity must stop, not pick. A row naming only the field matches both LeaseTerm values.
    const { decisions, errors } = decisionsFromSheet(report(), [
      { resourceName: 'Property', fieldName: 'LeaseTerm', action: 'ignore' }
    ]);
    expect(decisions).toEqual([]);
    expect(errors[0]).toMatch(/matches 2 changes/i);
  });

  it('refuses an unknown action rather than passing it to the service', () => {
    const { decisions, errors } = decisionsFromSheet(report(), [
      { resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'send-to-ft' }
    ]);
    expect(decisions).toEqual([]);
    expect(errors[0]).toMatch(/action must be one of/i);
  });

  it('refuses accept and ft-mapped without a mapping, before any request is made', () => {
    // The service rejects these per-item; refusing here means a bad batch never leaves the machine.
    for (const action of ['accept', 'ft-mapped'] as const) {
      const { decisions, errors } = decisionsFromSheet(report(), [
        { resourceName: 'Property', fieldName: 'OKC_SoilType', action }
      ]);
      expect(decisions).toEqual([]);
      expect(errors[0]).toMatch(new RegExp(`'${action}' requires a mapping`, 'i'));
    }
  });

  it('carries a mapping through for accept', () => {
    const { decisions, errors } = decisionsFromSheet(report(), [
      {
        resourceName: 'Property',
        fieldName: 'OKC_SoilType',
        action: 'accept',
        suggestedFieldName: 'SoilType'
      }
    ]);
    expect(errors).toEqual([]);
    expect(decisions[0].mapping).toEqual({ suggestedFieldName: 'SoilType' });
  });

  it('preserves a lookup value exactly, spaces and case included', () => {
    const { decisions } = decisionsFromSheet(report(), [
      { resourceName: 'Property', fieldName: 'Roof', lookupValue: 'Steel', action: 'submit-to-ft' }
    ]);
    expect(decisions[0].variationKey).toBe(`Property${US}Roof${US}Steel`);
  });

  it('produces no decision for a comment-only row', () => {
    // A row may carry a comment and no action: the comment is still worth recording on the report.
    const { decisions, errors } = decisionsFromSheet(report(), [
      { resourceName: 'Property', fieldName: 'Roof', lookupValue: 'Steel', comment: 'Which steel?' }
    ]);
    expect(errors).toEqual([]);
    expect(decisions).toEqual([]);
  });

  it('reports every bad row rather than stopping at the first', () => {
    const { errors } = decisionsFromSheet(report(), [
      { resourceName: 'Property', fieldName: 'NotThere', action: 'ignore' },
      { resourceName: 'Property', fieldName: 'AlsoNotThere', action: 'ignore' }
    ]);
    expect(errors).toHaveLength(2);
  });
});

describe('annotateReportWithComments', () => {
  it('attaches the comment to the matching change only', () => {
    const out = annotateReportWithComments(
      report(),
      [{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft', comment: 'DD has no 4-month term.' }],
      ADMIN,
      NOW
    );
    const touched = out.report.changes.filter(c => (c.conversations ?? []).length > 0);
    expect(touched).toHaveLength(1);
    expect(touched[0].lookupValue).toBe('Months - 4');
    expect(touched[0].conversations?.[0]).toEqual({
      timestamp: NOW,
      from: 'RESO',
      to: 'T00000045',
      message: 'DD has no 4-month term.'
    });
  });

  it('appends to an existing thread rather than replacing it', () => {
    const base = report();
    base.changes[0] = {
      ...base.changes[0],
      conversations: [{ timestamp: '2026-10-01T00:00:00.000Z', from: 'T00000045', to: 'RESO', message: 'earlier' }]
    } as never;
    const out = annotateReportWithComments(
      base,
      [{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', comment: 'later' }],
      ADMIN,
      NOW
    );
    const thread = out.report.changes[0].conversations ?? [];
    expect(thread).toHaveLength(2);
    expect(thread[0].message).toBe('earlier');
    expect(thread[1].message).toBe('later');
  });

  it('leaves the report untouched when no row carries a comment', () => {
    const before = report();
    const out = annotateReportWithComments(
      before,
      [{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore' }],
      ADMIN,
      NOW
    );
    expect(out.changed).toBe(false);
    expect(JSON.stringify(out.report)).toBe(JSON.stringify(before));
  });

  it('does not mutate the report it was given', () => {
    const before = report();
    const snapshot = JSON.stringify(before);
    annotateReportWithComments(
      before,
      [{ resourceName: 'Property', fieldName: 'OKC_SoilType', comment: 'note' }],
      ADMIN,
      NOW
    );
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('reports a comment row that matches no change instead of dropping it', () => {
    const out = annotateReportWithComments(
      report(),
      [{ resourceName: 'Property', fieldName: 'NotThere', comment: 'orphan' }],
      ADMIN,
      NOW
    );
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/matches no change/i);
    expect(out.changed).toBe(false);
  });

  it('takes the timestamp as an argument so the output is deterministic', () => {
    const a = annotateReportWithComments(report(), [{ resourceName: 'Property', fieldName: 'OKC_SoilType', comment: 'x' }], ADMIN, NOW);
    const b = annotateReportWithComments(report(), [{ resourceName: 'Property', fieldName: 'OKC_SoilType', comment: 'x' }], ADMIN, NOW);
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  });
});
