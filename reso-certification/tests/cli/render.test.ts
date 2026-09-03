import { describe, expect, it } from 'vitest';
import { humanizeDuration, collectFailures } from '../../src/cli/render.js';
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
});
