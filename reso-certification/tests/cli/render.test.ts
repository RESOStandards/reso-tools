import { describe, expect, it } from 'vitest';
import { humanizeDuration, collectFailures, collectOptionalUnsupported, runHeaderSummary } from '../../src/cli/render.js';
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
      status: 'failed', endorsement: 'core', duration: 0, steps: [],
      context: {
        resourceReports: [
          {
            resource: 'Property',
            scenarios: [
              { name: 'fetch-by-key', passed: false, assertions: [{ passed: false, description: 'Expected HTTP 200, got 404' }] },
              { name: 'top', passed: true, assertions: [] },
              { name: 'skipped-one', passed: false, skipped: true, assertions: [] },
            ],
          },
        ],
      },
    } as unknown as PipelineResult;

    const f = collectFailures(result);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('Property · fetch-by-key');
    expect(f[0]).toContain('Expected HTTP 200, got 404');
  });

  it('falls back to step-level errors when there are no resource reports', () => {
    const result = {
      status: 'failed', endorsement: 'dd', duration: 0,
      steps: [{ name: 'Service check', status: 'failed', duration: 0, errors: ['OData service did not respond'] }],
      context: {},
    } as unknown as PipelineResult;

    expect(collectFailures(result)).toEqual(['Service check: OData service did not respond']);
  });

  it('excludes optional-test failures from the required failure list', () => {
    const result = {
      status: 'failed', endorsement: 'core', duration: 0, steps: [],
      context: {
        resourceReports: [
          {
            resource: 'Property',
            scenarios: [
              { name: 'fetch-by-key', passed: false, assertions: [{ passed: false, description: 'Expected HTTP 200, got 404' }] },
              { name: 'String: contains()', passed: false, optional: true, assertions: [{ passed: false, description: 'Expected HTTP 200, got 400' }] },
            ],
          },
        ],
      },
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
      status: 'failed', endorsement: 'core', duration: 0, steps: [],
      context: {
        resourceReports: [
          {
            resource: 'Property',
            scenarios: [
              { name: 'fetch-by-key', passed: false, assertions: [{ passed: false, description: 'got 404' }] },
              { name: 'String: contains()', passed: false, optional: true, assertions: [{ passed: false, description: 'got 400' }] },
              { name: 'String: startswith()', passed: false, optional: true, assertions: [{ passed: false, description: 'got 400' }] },
              { name: 'String: endswith()', passed: true, optional: true, assertions: [] },
            ],
          },
        ],
      },
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
      status: 'passed', duration: 0,
      steps: [
        { name: 'Resolve authentication', status: 'passed' },
        { name: 'Run Core scenarios', status: 'passed', counts: { passed: 247, failed: 0, skipped: 84 } },
        { name: 'Write reports', status: 'passed' },
      ],
    } as unknown as PipelineResult;
    expect(runHeaderSummary(result)).toBe('247 passed, 0 failed, 84 skipped');
  });

  it('falls back to the pipeline-step tally when the run failed before scenarios ran', () => {
    const result = {
      status: 'failed', duration: 0,
      steps: [
        { name: 'Resolve authentication', status: 'passed' },
        { name: 'Service check', status: 'failed' },
      ],
    } as unknown as PipelineResult;
    expect(runHeaderSummary(result)).toBe('1 passed, 1 failed');
  });
});
