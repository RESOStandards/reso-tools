/**
 * The DD report's `outcome`, and the remarks sentence beside it, must agree with the steps the run
 * actually recorded.
 *
 * Observed on a real DD 2.1 run (CDL, 2026-10-04): `report-detailed.json` carried
 * `outcome: "passed"` and `remarks: "14 resources, 1,237 fields, 3,352 lookups. Data Dictionary
 * compliance test passed."` in the SAME document as
 * `steps: [ ..., { "name": "Validate DD metadata", "status": "failed" } ]`, on a run with two
 * genuine conformance errors. `report.json` carried the same sentence and has no status field at
 * all, so the sentence is the only verdict a reader of that file gets.
 *
 * The cause is structural. `Write reports` is an `alwaysRun` finalizer, and the pipeline's own
 * status is not computed until after the step loop (`pipeline.ts`), so a finalizer cannot read it.
 * The finalizer must therefore derive the status from the steps recorded in `ctx.pipelineSteps`,
 * using the same precedence the pipeline uses: a real failure outranks an incomplete (deadline)
 * run, which outranks passed, and a skipped step is not a failure.
 *
 * These tests drive the real finalizer rather than a helper standing beside it, so the wiring is
 * what is under test. `writeComplianceReports` is exported for that reason.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeComplianceReports } from '../../src/sdk/dd.js';
import type { DDConfig, StepResult } from '../../src/sdk/types.js';

const step = (name: string, status: StepResult['status'], extra: Partial<StepResult> = {}): StepResult => ({
  name,
  endorsement: 'dd',
  status,
  duration: 10,
  ...extra
});

/** Run the real finalizer over a set of recorded steps and read back both reports it writes. */
const runFinalizer = async (steps: ReadonlyArray<StepResult>) => {
  const outputPath = await mkdtemp(join(tmpdir(), 'dd-report-outcome-'));
  try {
    const finalizer = writeComplianceReports({ version: '2.1' } as unknown as DDConfig);
    const ctx = { outputPath, pipelineSteps: steps };
    await finalizer.run?.(ctx as never, () => {});
    return {
      detailed: JSON.parse(await readFile(join(outputPath, 'report-detailed.json'), 'utf8')),
      generic: JSON.parse(await readFile(join(outputPath, 'report.json'), 'utf8'))
    };
  } finally {
    await rm(outputPath, { recursive: true, force: true });
  }
};

describe('the DD report outcome follows the steps', () => {
  it('reports failed when a step failed — the CDL case', async () => {
    const { detailed, generic } = await runFinalizer([
      step('Resolve authentication', 'passed'),
      step('Service check', 'passed'),
      step('Generate metadata report', 'passed', { counts: { resources: 14, fields: 1237, lookups: 3352 } }),
      step('Validate DD metadata', 'failed', { errors: ['"Off Market" is not a permitted value'] })
    ]);

    expect(detailed.outcome).toBe('failed');
    expect(detailed.remarks).toContain('Data Dictionary compliance test failed');
    // The sentence is the ONLY verdict report.json carries, so it has to be right there too.
    expect(generic.remarks).toContain('Data Dictionary compliance test failed');
    // And it must not still assert the opposite.
    expect(detailed.remarks).not.toContain('compliance test passed');
    expect(generic.remarks).not.toContain('compliance test passed');
    // The counts half of the sentence is unaffected.
    expect(generic.remarks).toContain('14 resources, 1,237 fields, 3,352 lookups');
  });

  it('reports passed when every step passed', async () => {
    const { detailed, generic } = await runFinalizer([
      step('Resolve authentication', 'passed'),
      step('Generate metadata report', 'passed'),
      step('Validate DD metadata', 'passed')
    ]);
    expect(detailed.outcome).toBe('passed');
    expect(generic.remarks).toContain('Data Dictionary compliance test passed');
  });

  it('reports incomplete for a deadline-truncated run with no failure', async () => {
    const { detailed } = await runFinalizer([step('Generate metadata report', 'passed'), step('Replicate and validate', 'incomplete')]);
    expect(detailed.outcome).toBe('incomplete');
  });

  it('lets a real failure outrank an incomplete step, matching the pipeline precedence', async () => {
    const { detailed } = await runFinalizer([step('Validate DD metadata', 'failed'), step('Replicate and validate', 'incomplete')]);
    expect(detailed.outcome).toBe('failed');
  });

  it('does not treat a skipped step as a failure', async () => {
    // DD runs failFast, so steps after a break are skipped. A skip is not a defect, and on a clean
    // run a legitimately skipped step (variations on DD 1.7, no Lookup Resource) must not fail it.
    const { detailed } = await runFinalizer([
      step('Generate metadata report', 'passed'),
      step('Validate DD metadata', 'passed'),
      step('Check variations', 'skipped')
    ]);
    expect(detailed.outcome).toBe('passed');
  });

  it('reports how long the run took, not zero', async () => {
    // Same hardcoded object as the outcome: `duration: 0` shipped on every DD report. On the CDL run
    // the steps summed to 2,463 ms against a reported 0, so anything consuming the field — a trend,
    // a timeout budget, a slow-provider signal — read every run as instantaneous.
    const { detailed } = await runFinalizer([
      step('Resolve authentication', 'passed', { duration: 610 }),
      step('Service check', 'passed', { duration: 444 }),
      step('Generate metadata report', 'passed', { duration: 1359 }),
      step('Validate DD metadata', 'failed', { duration: 50 })
    ]);
    expect(detailed.duration).toBe(2463);
  });

  it('reports a zero duration for a run with no steps, rather than NaN', async () => {
    const { detailed } = await runFinalizer([]);
    expect(detailed.duration).toBe(0);
  });

  it('does not let a step missing its duration poison the total', async () => {
    // `pipelineSteps` reaches the finalizer through an unchecked cast, so the value is not guaranteed
    // to be there at runtime even though the type requires it. One absent number must not turn the
    // whole duration into NaN.
    const steps = [
      step('Generate metadata report', 'passed', { duration: 1000 }),
      { name: 'Validate DD metadata', endorsement: 'dd', status: 'passed' } as unknown as StepResult
    ];
    const { detailed } = await runFinalizer(steps);
    expect(detailed.duration).toBe(1000);
  });

  it('carries the steps through unchanged, so the report stays self-consistent', async () => {
    const { detailed } = await runFinalizer([step('Generate metadata report', 'passed'), step('Validate DD metadata', 'failed')]);
    const statuses = detailed.steps.map((s: { name: string; status: string }) => [s.name, s.status]);
    expect(statuses).toEqual([
      ['Generate metadata report', 'passed'],
      ['Validate DD metadata', 'failed']
    ]);
    // The whole point: the top-level verdict agrees with the steps beneath it.
    expect(detailed.outcome).toBe('failed');
  });
});
