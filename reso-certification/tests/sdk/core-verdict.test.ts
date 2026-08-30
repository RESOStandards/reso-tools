import { describe, expect, it } from 'vitest';
import { coreVerdict, deadlineResourceReport, reportVerdict } from '../../src/sdk/core.js';

/**
 * Guards the run-verdict precedence surfaced by the adversarial review of the graceful-stop
 * change: a definitive failure must NOT be softened to "incomplete" just because the run also
 * ran out of time, and a not-tested (deadline) resource must never read as a failure.
 */
describe('coreVerdict — failed > incomplete > passed', () => {
  it('passed: nothing failed and the run finished', () => {
    expect(coreVerdict({ totalFailed: 0, coverageFailed: false, deadlineReached: false })).toBe('passed');
  });

  it('failed: a real required-scenario failure', () => {
    expect(coreVerdict({ totalFailed: 1, coverageFailed: false, deadlineReached: false })).toBe('failed');
  });

  it('failed: a coverage-gate failure with no scenario failures (the gate is run-level)', () => {
    expect(coreVerdict({ totalFailed: 0, coverageFailed: true, deadlineReached: false })).toBe('failed');
  });

  it('incomplete: cut short by the deadline, but observed no failure', () => {
    expect(coreVerdict({ totalFailed: 0, coverageFailed: false, deadlineReached: true })).toBe('incomplete');
  });

  it('FAILED, not incomplete: a real failure AND a deadline — a definitive failure is not softened', () => {
    expect(coreVerdict({ totalFailed: 1, coverageFailed: false, deadlineReached: true })).toBe('failed');
    expect(coreVerdict({ totalFailed: 0, coverageFailed: true, deadlineReached: true })).toBe('failed');
  });
});

describe('reportVerdict — the report headline is never a false-PASS for an incomplete/aborted run', () => {
  const clean = {
    priorStepFailed: false,
    testingAborted: false,
    totalFailed: 0,
    coverageFailed: false,
    deadlineReached: false
  };

  it('a clean, fully-passing run is passed', () => {
    expect(reportVerdict(clean)).toBe('passed');
  });

  it('a failed UPSTREAM step forces failed even when every sampled scenario passed (was a false-PASS)', () => {
    // e.g. metadata XSD/semantic validation failed but failFast=false let sampling proceed and pass.
    expect(reportVerdict({ ...clean, priorStepFailed: true })).toBe('failed');
  });

  it('a testing ABORT (no results at all — e.g. fatal-auth mid-run) forces failed, never passed (was a false-PASS)', () => {
    expect(reportVerdict({ ...clean, testingAborted: true })).toBe('failed');
  });

  it('otherwise it defers to the testing verdict (failed > incomplete > passed)', () => {
    expect(reportVerdict({ ...clean, totalFailed: 1 })).toBe('failed');
    expect(reportVerdict({ ...clean, coverageFailed: true })).toBe('failed');
    expect(reportVerdict({ ...clean, deadlineReached: true })).toBe('incomplete');
  });

  it('a real failure is never masked, even when the run was also aborted or incomplete', () => {
    expect(reportVerdict({ ...clean, testingAborted: true, deadlineReached: true })).toBe('failed');
    expect(reportVerdict({ ...clean, priorStepFailed: true, totalFailed: 0 })).toBe('failed');
  });
});

describe('deadlineResourceReport — a resource not reached before the run deadline', () => {
  it('is reported NOT TESTED (skipped, never failed) and flags the run incomplete', () => {
    const report = deadlineResourceReport('Property');
    expect(report.resource).toBe('Property');
    expect(report.deadlineReached).toBe(true);
    expect(report.summary.failed).toBe(0); // the core guarantee: never a failure — no vendor misreport
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.passed).toBe(0);
    // Its lone synthetic scenario is a skip, not a failure.
    expect(report.scenarios.every(s => s.skipped && s.passed)).toBe(true);
  });
});
