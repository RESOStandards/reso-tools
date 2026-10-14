/**
 * Planning the push: what will be marked, and when nothing is sent.
 *
 * One request, by design. Josh, 2026-10-04: "client passes the variations report and comments and
 * the backend should do everything from there", and it "should make the same output as if a user is
 * on the UI". The plan therefore produces one artifact -- the marked report -- rather than a payload
 * per route.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatPlan, planDecisionPush } from '../../src/cli/decisions-command.js';
import type { DecisionReport } from '../../src/variations/decisions.js';

const NOW = '2026-10-05T04:30:00.000Z';

const report = (): DecisionReport =>
  JSON.parse(readFileSync(new URL('../fixtures/variations-report-level-buckets.json', import.meta.url), 'utf-8')) as DecisionReport;

const plan = (rows: ReadonlyArray<Record<string, unknown>>) => planDecisionPush({ report: report(), rows: rows as never, now: NOW });

describe('planning', () => {
  it('reports the report’s own size from its level buckets', () => {
    // The number an operator checks against what the run told them. Read off the five buckets, so a
    // report with no `changes` key still reports its real size rather than zero.
    expect(plan([]).entryCount).toBe(5);
  });

  it('marks nothing and reports unchanged when no row asks for anything', () => {
    const result = plan([{ resourceName: 'Property', fieldName: 'OKC_SoilType' }]);
    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports changed once a row marks an entry', () => {
    const result = plan([{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft' }]);
    expect(result.changed).toBe(true);
    expect(result.report).not.toBe(report());
  });

  it('reports unchanged when the sheet is unusable, so nothing is pushed', () => {
    // The push replaces this report's review rows. Landing a destructive replace carrying part of
    // what the operator meant is worse than landing nothing.
    const result = plan([{ resourceName: 'Property', fieldName: 'Nowhere', action: 'ignore' }]);
    expect(result.changed).toBe(false);
    expect(result.errors).toHaveLength(1);
  });
});

describe('what the operator is shown before it goes', () => {
  it('names the derived requestedAction beside the sheet’s own word', () => {
    // `submit-to-ft` shows up in the pool and the UI as `fast-track`. An operator checking their
    // work should not have to learn that from a mismatch afterwards.
    const text = formatPlan(
      plan([{ resourceName: 'Property', fieldName: 'LeaseTerm', lookupValue: 'Months - 4', action: 'submit-to-ft' }])
    );
    expect(text).toContain('Property.LeaseTerm.Months - 4');
    expect(text).toContain('[lookups]');
    expect(text).toContain("requestedAction 'fast-track'");
  });

  it('says when a row carries a comment as well as an action', () => {
    const text = formatPlan(
      plan([{ resourceName: 'Property', fieldName: 'OKC_SoilType', action: 'ignore', comment: 'Local soil taxonomy.' }])
    );
    expect(text).toMatch(/ignore .*\+ comment/);
  });

  it('names a comment-only row without inventing an action for it', () => {
    const text = formatPlan(plan([{ resourceName: 'Property', fieldName: 'OKC_SoilType', comment: 'a note' }]));
    expect(text).toContain('comment');
    expect(text).not.toContain('requestedAction');
  });
});
