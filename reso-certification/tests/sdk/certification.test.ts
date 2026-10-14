/**
 * Certification eligibility: whether a finished run can be endorsed.
 *
 * The behavior these pin is one a run can get wrong silently, which is why they exist. Before this
 * mechanism, `deriveStatus` ignored `skipped` entirely, so a Data Dictionary run whose reference
 * metadata failed to load reported `outcome: "passed"` having validated no metadata at all. A rule
 * nobody ever watches fail is not a rule, so each test below drives the failing direction.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addEditValidForCertification } from '../../src/sdk/add-edit.js';
import { CERTIFIABLE, allOf, everyStepPassed, notCertifiable } from '../../src/sdk/certification.js';
import { coreValidForCertification } from '../../src/sdk/core.js';
import { ddValidForCertification, runVariations } from '../../src/sdk/dd.js';
import { entityEventValidForCertification } from '../../src/sdk/entity-event.js';
import { createPipeline } from '../../src/sdk/pipeline.js';
import { createDetailedReportGenerator } from '../../src/sdk/reports.js';
import type { DDConfig, EntityEventConfig, PipelineResult, PipelineStep, StepResult, StepStatus } from '../../src/sdk/types.js';

const step = (name: string, status: StepStatus, summary?: string): StepResult => ({
  name,
  endorsement: 'dd',
  status,
  duration: 1,
  ...(summary ? { summary } : {})
});

const reasonsOf = (verdict: ReturnType<typeof everyStepPassed>): ReadonlyArray<string> => (verdict.valid ? [] : verdict.reasons);

describe('everyStepPassed', () => {
  it('is valid when every step passed', () => {
    expect(everyStepPassed([step('a', 'passed'), step('b', 'passed')])).toEqual(CERTIFIABLE);
  });

  // The whole reason this function exists. A skipped step verified nothing, so a run carrying one
  // cannot be certified on its strength.
  it('is NOT valid when a step was skipped, and names the step', () => {
    const verdict = everyStepPassed([step('a', 'passed'), step('Check variations', 'skipped', 'Variations not checked')]);

    expect(verdict.valid).toBe(false);
    expect(reasonsOf(verdict)).toHaveLength(1);
    expect(reasonsOf(verdict)[0]).toContain('Check variations');
    expect(reasonsOf(verdict)[0]).toContain('skipped');
    // The summary travels too, so a reader learns WHY it was skipped from the verdict alone.
    expect(reasonsOf(verdict)[0]).toContain('Variations not checked');
  });

  it('is NOT valid for a failed or incomplete step', () => {
    expect(everyStepPassed([step('a', 'failed')]).valid).toBe(false);
    expect(everyStepPassed([step('a', 'incomplete')]).valid).toBe(false);
  });

  it('reports every step that did not pass, not just the first', () => {
    const verdict = everyStepPassed([step('a', 'failed'), step('b', 'passed'), step('c', 'skipped')]);
    expect(reasonsOf(verdict)).toHaveLength(2);
  });

  // An empty pipeline is vacuously all-passing. Recorded rather than asserted as desirable: no
  // endorsement declares zero steps, and if one ever did this is what it would get.
  it('is valid for an empty step list', () => {
    expect(everyStepPassed([])).toEqual(CERTIFIABLE);
  });
});

describe('notCertifiable', () => {
  // A refusal with no reason produces a report that says not-certifiable and leaves the reader to
  // reverse-engineer why. Remove this and that becomes constructible.
  it('refuses to build a verdict with no reasons', () => {
    expect(() => notCertifiable([])).toThrow(/at least one reason/);
  });
});

describe('allOf', () => {
  it('keeps every reason rather than short-circuiting on the first', () => {
    const verdict = allOf(notCertifiable(['first']), CERTIFIABLE, notCertifiable(['second', 'third']));
    expect(verdict.valid).toBe(false);
    expect(reasonsOf(verdict)).toEqual(['first', 'second', 'third']);
  });

  it('is valid when every condition holds', () => {
    expect(allOf(CERTIFIABLE, CERTIFIABLE)).toEqual(CERTIFIABLE);
  });
});

describe('the Data Dictionary rule', () => {
  const ddSteps = (variationsStatus: StepStatus): ReadonlyArray<StepResult> => [
    step('Resolve authentication', 'passed'),
    step('Service check', 'passed'),
    step('Generate metadata report', 'passed'),
    step('Validate DD metadata', 'passed'),
    step('Check variations', variationsStatus),
    step('Replicate and validate', 'passed'),
    step('Write reports', 'passed')
  ];

  it('is valid when every step passed', () => {
    expect(ddValidForCertification(ddSteps('passed'))).toEqual(CERTIFIABLE);
  });

  // The case the --skip-variations flag produces, and the one this change was built for.
  it('is NOT valid when the variations check was skipped', () => {
    const verdict = ddValidForCertification(ddSteps('skipped'));
    expect(verdict.valid).toBe(false);
    expect(reasonsOf(verdict).join(' ')).toContain('Check variations');
  });

  // The live hole found while writing this: getReferenceMetadata returns null rather than throwing
  // when its JSON cannot be loaded, so `Validate DD metadata` returns 'skipped' — and a run that
  // validated no metadata whatsoever was reported as passed.
  it('is NOT valid when DD metadata validation was skipped for want of reference metadata', () => {
    const verdict = ddValidForCertification([
      step('Resolve authentication', 'passed'),
      step('Generate metadata report', 'passed'),
      step('Validate DD metadata', 'skipped', 'No DD reference metadata for version 2.1'),
      step('Check variations', 'passed'),
      step('Write reports', 'passed')
    ]);

    expect(verdict.valid).toBe(false);
    expect(reasonsOf(verdict).join(' ')).toContain('Validate DD metadata');
  });
});

describe('the Web API Core rule', () => {
  // Core routinely reports large skip counts — "219 passed, 0 failed, 112 skipped" — but those are
  // SCENARIO-level and live in the step's counts while the step itself passes. Remove this and a
  // rule written against the wrong level would mark every ordinary Core run ineligible.
  it('is valid when scenarios were skipped inside a step that passed', () => {
    const scenariosStep: StepResult = {
      name: 'Run Core scenarios',
      endorsement: 'core',
      status: 'passed',
      duration: 1,
      counts: { passed: 219, failed: 0, skipped: 112 }
    };

    expect(coreValidForCertification([step('Resolve authentication', 'passed'), scenariosStep])).toEqual(CERTIFIABLE);
  });
});

describe('the EntityEvent rule', () => {
  const config = (mode: 'observe' | 'full'): EntityEventConfig =>
    ({
      endorsement: 'entity-event',
      mode,
      server: { url: 'https://example.org', auth: { mode: 'bearer', token: 't' } }
    }) as EntityEventConfig;

  it('is valid for a full run in which every step passed', () => {
    const steps = [step('Fetch metadata', 'passed'), step('Generate payloads', 'passed'), step('Run EntityEvent scenarios', 'passed')];
    expect(entityEventValidForCertification(config('full'))(steps)).toEqual(CERTIFIABLE);
  });

  /**
   * The case that ruled out expressing this as a per-endorsement "are skips allowed" flag.
   *
   * In observe mode `generatePayloads` is OMITTED from the pipeline rather than skipped, so it
   * produces no StepResult at all and every recorded step passes. A step-list rule alone sees a
   * complete, clean run. An observe-only run exercises no writes, so certifying it certifies
   * nothing — and a flag reading "EntityEvent allows skips: yes" would have let it through.
   */
  it('is NOT valid in observe mode even though every recorded step passed', () => {
    const steps = [step('Fetch metadata', 'passed'), step('Run EntityEvent scenarios', 'passed')];
    const verdict = entityEventValidForCertification(config('observe'))(steps);

    expect(verdict.valid).toBe(false);
    expect(reasonsOf(verdict).join(' ')).toContain('observe mode');
  });
});

describe('the Add/Edit rule', () => {
  it('is valid when every step passed and NOT valid when one was skipped', () => {
    expect(addEditValidForCertification([step('Run Add/Edit scenarios', 'passed')])).toEqual(CERTIFIABLE);
    expect(addEditValidForCertification([step('Run Add/Edit scenarios', 'skipped')]).valid).toBe(false);
  });
});

describe('the pipeline carries the verdict', () => {
  const passing: PipelineStep = { name: 'ok', run: async ctx => ({ context: ctx }) };
  const failing: PipelineStep = { name: 'boom', run: async ctx => ({ context: ctx, status: 'failed' as const }) };
  const never: PipelineStep = { name: 'never-runs', run: async ctx => ({ context: ctx }) };

  it('returns a valid verdict for a clean run', async () => {
    const result = await createPipeline('test', [passing], everyStepPassed).run({});
    expect(result.certification).toEqual(CERTIFIABLE);
  });

  /**
   * The runner marks every step after a fail-fast break as `skipped`, so this also pins that an
   * ineligible verdict names the step that never ran — not only the one that failed.
   */
  it('returns an invalid verdict naming both the failed step and the one it stopped', async () => {
    const result = await createPipeline('test', [failing, never], everyStepPassed).run({});

    expect(result.status).toBe('failed');
    expect(result.certification.valid).toBe(false);
    const reasons = result.certification.valid ? [] : result.certification.reasons;
    expect(reasons.join(' ')).toContain('boom');
    expect(reasons.join(' ')).toContain('never-runs');
  });

  // The endorsement's own rule is consulted, not a rule the runner holds.
  it('uses the rule it was given, not a default', async () => {
    const alwaysRefuses = () => notCertifiable(['this endorsement never certifies']);
    const result = await createPipeline('test', [passing], alwaysRefuses).run({});

    expect(result.status).toBe('passed');
    expect(result.certification.valid).toBe(false);
  });
});

describe('the variations step', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Rebuilt WITHOUT the key, rather than assigning undefined over it.
    //
    // On the real process.env, assigning undefined coerces the value to the STRING "undefined",
    // which is truthy, so resolveServicesUrl would accept it and the absent case would go untested.
    // That hazard does not bite here, because the line below replaces process.env with a plain
    // object and assignment on a plain object really does yield undefined — verified, not assumed.
    // The destructuring is used anyway so the test does not depend on that distinction holding:
    // someone later narrowing this to an assignment on the real env would reintroduce the hazard.
    const { RESO_SERVICES_URL, ...withoutServicesUrl } = origEnv;
    void RESO_SERVICES_URL;
    process.env = withoutServicesUrl;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  const ctx = { serverUrl: 'https://example.org', outputPath: '/tmp/none', version: '2.1' as const };
  const config = (overrides: Partial<DDConfig> = {}): DDConfig =>
    ({
      endorsement: 'dd',
      version: '2.1',
      server: { url: 'https://example.org', auth: { mode: 'bearer', token: 't' } },
      ...overrides
    }) as DDConfig;

  it('is skipped, not omitted, when --skip-variations was passed', async () => {
    const output = await runVariations(config({ runVariations: false })).run!(ctx, () => {});

    expect(output.status).toBe('skipped');
    // The run must be visibly ineligible, so the summary has to say the step did not check anything.
    expect(output.summary).toContain('not eligible for certification');
  });

  /**
   * The invariant worth guarding hardest. If an absent RESO_SERVICES_URL were treated as a skip,
   * a misconfigured machine would quietly stop checking variations and report a run that looked
   * complete. Skipping is only ever an operator's deliberate act; absence still throws.
   */
  it('still throws when RESO_SERVICES_URL is absent and no flag was passed', async () => {
    await expect(runVariations(config()).run!(ctx, () => {})).rejects.toThrow(/RESO_SERVICES_URL is not set/);
  });

  it('throws rather than skipping even when the flag was explicitly set to true', async () => {
    await expect(runVariations(config({ runVariations: true })).run!(ctx, () => {})).rejects.toThrow(/RESO_SERVICES_URL is not set/);
  });
});

describe('the detailed report', () => {
  const result = (certification: PipelineResult['certification']): PipelineResult => ({
    status: 'passed',
    endorsement: 'dd',
    steps: [step('Check variations', 'skipped')],
    context: {},
    duration: 1,
    certification
  });

  it('carries the verdict and its reasons', () => {
    const generator = createDetailedReportGenerator('Data Dictionary', '2.1', () => 'remarks');
    const report = generator.generate(result(notCertifiable(['Check variations: skipped'])));

    expect(report.certification).toEqual({ valid: false, reasons: ['Check variations: skipped'] });
  });

  /**
   * report.json's key set is pinned elsewhere as the Cert API compatible shape. The verdict lives
   * on the detailed report precisely so that contract is not widened on the assumption that the
   * backend's ingestion tolerates unknown keys. Remove this and the field could migrate there
   * unnoticed.
   */
  it('is where the verdict lives, keeping report.json’s shape untouched', () => {
    const generator = createDetailedReportGenerator('Data Dictionary', '2.1', () => 'remarks');
    const report = generator.generate(result(CERTIFIABLE));

    expect(Object.keys(report)).toContain('certification');
  });
});
