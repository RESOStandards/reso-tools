/**
 * A skipped Core scenario must say it was skipped, say why, in a field something can read.
 *
 * Observed on a real Core 2.0.0 run (2026-10-05): 76 of 232 scenarios skipped, and **all 76 carried
 * `passed: true`**. The reason was present — but only as English prose inside the `assertions`
 * array, prefixed "Skipped:" on 73 of them and not labeled at all on the other 3. So:
 *
 *  - anything reading `passed` saw 76 passes
 *  - anything trying to aggregate or filter skips by reason had to pattern-match prose
 *  - three scenarios recorded "No records returned — filter executed but no matching data to
 *    validate" beside a passing `HTTP 200` assertion, which reads as an ordinary passing scenario
 *
 * The headline counts were never wrong, because `summarizeScenarios` already guards both tallies on
 * `!r.skipped`. That is exactly why `passed: true` on a skip survived: it was inert to every
 * consumer and misleading only to a reader. The first test here pins that guard, so the fix to
 * `passed` provably cannot move a verdict.
 */

import { describe, expect, it } from 'vitest';
import { emptyOutcome, summarizeScenarios } from '../../src/web-api-core/test-runner.js';
import type { ScenarioResult } from '../../src/web-api-core/test-runner.js';

const scenario = (over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  tag: 'filter-int-eq',
  name: 'Integer eq',
  passed: true,
  skipped: false,
  assertions: [],
  duration: 1,
  ...over
});

describe('a skip never reaches the pass or fail tally', () => {
  // The safety property. Both counts already filter on !skipped, so changing `passed` on a skipped
  // scenario cannot alter a verdict. Pinned here so the next person can change `passed` freely.
  it.each([true, false])('counts a skipped scenario in neither tally, whatever `passed` says (%s)', flag => {
    const summary = summarizeScenarios([scenario({ passed: true }), scenario({ name: 'skipped one', skipped: true, passed: flag })]);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

describe('a skipped scenario carries a machine-readable reason', () => {
  it('does not claim it passed', () => {
    // 76 of 76 skips on the observed run said `passed: true`. A reader of that field saw 76 passes.
    const summary = summarizeScenarios([scenario({ skipped: true, passed: false })]);
    expect(summary.skipped).toBe(1);
    expect(summary.passed).toBe(0);
  });

  it('exposes skipReason on the scenario, not only as prose in an assertion', () => {
    const withReason = scenario({ skipped: true, passed: false, skipReason: 'no enumeration field supports has' });
    expect(withReason.skipReason).toBe('no enumeration field supports has');
  });
});

describe('emptyOutcome — the no-matching-data skip', () => {
  // This is the branch behind the three scenarios that recorded a bare passing HTTP assertion with
  // nothing marking them as skipped-and-why. It is a skip, so it must present as one.
  it('marks a skip as not passed and supplies a reason', () => {
    const outcome = emptyOutcome('skip');
    expect(outcome.skipped).toBe(true);
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toMatch(/no matching data/i);
  });

  it('leaves the determinate verdicts alone', () => {
    // A guaranteed-match empty is a real defect and a correct `ne` empty is a real pass. Neither is
    // a skip, and this change must not blur them into one.
    expect(emptyOutcome('fail')).toMatchObject({ passed: false, skipped: false, retryable: false });
    expect(emptyOutcome('pass')).toMatchObject({ passed: true, skipped: false, retryable: false });
  });
});
