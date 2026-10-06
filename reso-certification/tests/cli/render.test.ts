import { describe, expect, it, vi } from 'vitest';
import { collectFailures, collectOptionalUnsupported, humanizeDuration, printRunSummary, runHeaderSummary } from '../../src/cli/render.js';
import type { PipelineResult } from '../../src/sdk/types.js';

describe('humanizeDuration', () => {
  it('formats ms / seconds / minutes (matching the run-total format)', () => {
    expect(humanizeDuration(888)).toBe('888ms');
    expect(humanizeDuration(1557)).toBe('1.6s');
    expect(humanizeDuration(60000)).toBe('1m00s');
    expect(humanizeDuration(204985)).toBe('3m25s');
    expect(humanizeDuration(211287)).toBe('3m31s');
  });
});

describe('collectFailures', () => {
  it('extracts failed scenarios + assertion messages from resource reports', () => {
    const result = {
      status: 'failed',
      endorsement: 'core',
      duration: 0,
      steps: [],
      context: {
        resourceReports: [
          {
            resource: 'Property',
            scenarios: [
              { name: 'fetch-by-key', passed: false, assertions: [{ passed: false, description: 'Expected HTTP 200, got 404' }] },
              { name: 'top', passed: true, assertions: [] },
              { name: 'skipped-one', passed: false, skipped: true, assertions: [] }
            ]
          }
        ]
      }
    } as unknown as PipelineResult;

    const f = collectFailures(result);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('Property · fetch-by-key');
    expect(f[0]).toContain('Expected HTTP 200, got 404');
  });

  it('falls back to step-level errors when there are no resource reports', () => {
    const result = {
      status: 'failed',
      endorsement: 'dd',
      duration: 0,
      steps: [{ name: 'Service check', status: 'failed', duration: 0, errors: ['OData service did not respond'] }],
      context: {}
    } as unknown as PipelineResult;

    expect(collectFailures(result)).toEqual(['Service check: OData service did not respond']);
  });

  it('excludes optional-test failures from the required failure list', () => {
    const result = {
      status: 'failed',
      endorsement: 'core',
      duration: 0,
      steps: [],
      context: {
        resourceReports: [
          {
            resource: 'Property',
            scenarios: [
              { name: 'fetch-by-key', passed: false, assertions: [{ passed: false, description: 'Expected HTTP 200, got 404' }] },
              {
                name: 'String: contains()',
                passed: false,
                optional: true,
                assertions: [{ passed: false, description: 'Expected HTTP 200, got 400' }]
              }
            ]
          }
        ]
      }
    } as unknown as PipelineResult;

    const required = collectFailures(result);
    expect(required).toHaveLength(1);
    expect(required[0]).toContain('fetch-by-key');
    expect(required.join('\n')).not.toContain('contains()'); // an optional failure is never a "real" failure
  });
});

describe('collectOptionalUnsupported', () => {
  it('collects only optional-test failures, into their own list', () => {
    const result = {
      status: 'failed',
      endorsement: 'core',
      duration: 0,
      steps: [],
      context: {
        resourceReports: [
          {
            resource: 'Property',
            scenarios: [
              { name: 'fetch-by-key', passed: false, assertions: [{ passed: false, description: 'got 404' }] },
              { name: 'String: contains()', passed: false, optional: true, assertions: [{ passed: false, description: 'got 400' }] },
              { name: 'String: startswith()', passed: false, optional: true, assertions: [{ passed: false, description: 'got 400' }] },
              { name: 'String: endswith()', passed: true, optional: true, assertions: [] }
            ]
          }
        ]
      }
    } as unknown as PipelineResult;

    const optional = collectOptionalUnsupported(result);
    expect(optional).toHaveLength(2); // the two failed optionals; the passing one and the required one are excluded
    expect(optional.join('\n')).toContain('String: contains()');
    expect(optional.join('\n')).toContain('String: startswith()');
    expect(optional.join('\n')).not.toContain('fetch-by-key');
  });
});

describe('runHeaderSummary', () => {
  it('shows the scenario tally (passed/failed/skipped) from the scenario step, not the pipeline-step count', () => {
    const result = {
      status: 'passed',
      duration: 0,
      steps: [
        { name: 'Resolve authentication', status: 'passed' },
        { name: 'Run Core scenarios', status: 'passed', counts: { passed: 247, failed: 0, skipped: 84 } },
        { name: 'Write reports', status: 'passed' }
      ]
    } as unknown as PipelineResult;
    expect(runHeaderSummary(result)).toBe('247 passed, 0 failed, 84 skipped');
  });

  it('falls back to the pipeline-step tally when the run failed before scenarios ran', () => {
    const result = {
      status: 'failed',
      duration: 0,
      steps: [
        { name: 'Resolve authentication', status: 'passed' },
        { name: 'Service check', status: 'failed' }
      ]
    } as unknown as PipelineResult;
    expect(runHeaderSummary(result)).toBe('1 passed, 1 failed');
  });
});

describe('runHeaderSummary — the step-tally fallback', () => {
  const ddResult = (variationsStatus: string): PipelineResult =>
    ({
      status: 'passed',
      duration: 0,
      steps: [
        { name: 'Resolve authentication', status: 'passed' },
        { name: 'Generate metadata report', status: 'passed' },
        { name: 'Check variations', status: variationsStatus },
        { name: 'Write reports', status: 'passed' }
      ]
    }) as unknown as PipelineResult;

  /**
   * The Data Dictionary has no scenario-running step, so it takes the step-tally branch. That branch
   * counted only passed and failed, which meant a run with a skipped step printed "3 passed,
   * 0 failed" — a terminal and a continuous-integration log that said nothing about the step which
   * never ran.
   */
  it('counts skipped steps, so a skipped step is visible in the header', () => {
    expect(runHeaderSummary(ddResult('skipped'))).toBe('3 passed, 0 failed, 1 skipped');
  });

  it('says nothing about skips when there are none, leaving an ordinary run unchanged', () => {
    expect(runHeaderSummary(ddResult('passed'))).toBe('4 passed, 0 failed');
  });
});

describe('printRunSummary — certification', () => {
  const resultWith = (certification: PipelineResult['certification']): PipelineResult =>
    ({ status: 'passed', endorsement: 'dd', duration: 0, steps: [], context: {}, certification }) as unknown as PipelineResult;

  const captured = (result: PipelineResult): string => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    printRunSummary(result, 'default' as never);
    spy.mockRestore();
    return lines.join('\n');
  };

  // The case the whole mechanism exists for: the run PASSED, so nothing else in this summary would
  // say a word about it.
  it('reports ineligibility on a passing run, with the reason', () => {
    const out = captured(resultWith({ valid: false, reasons: ['Check variations: skipped – requested with --skip-variations'] }));

    expect(out).toContain('Not eligible for certification (1)');
    expect(out).toContain('Check variations: skipped');
  });

  it('says nothing when the run is eligible', () => {
    expect(captured(resultWith({ valid: true }))).not.toContain('Not eligible');
  });
});
