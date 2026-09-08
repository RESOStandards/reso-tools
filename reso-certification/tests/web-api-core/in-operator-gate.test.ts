import { describe, expect, it } from 'vitest';
import { isInOperatorSkippedForVersion } from '../../src/web-api-core/test-runner.js';
import { scenariosForVersion } from '../../src/web-api-core/scenarios.js';

// Real catalog scenarios — the `in`-operator scenario and a non-gated filter scenario.
const scenarios = scenariosForVersion('2.1.0');
const inOp = scenarios.find((s) => s.category === 'in-operator');
const filter = scenarios.find((s) => s.category === 'filter');

describe('isInOperatorSkippedForVersion — the `in` operator 4.01 gate (fail-closed)', () => {
  it('the catalog actually has an in-operator scenario to gate', () => {
    expect(inOp).toBeDefined();
    expect(filter).toBeDefined();
  });

  it('runs (NOT skipped) only when the server positively advertises OData 4.01', () => {
    expect(isInOperatorSkippedForVersion(inOp!, '4.01')).toBe(false);
  });

  it('SKIPS on OData 4.0', () => {
    expect(isInOperatorSkippedForVersion(inOp!, '4.0')).toBe(true);
  });

  it('SKIPS on an unknown/undefined version — fail-closed (the regression this fixes)', () => {
    expect(isInOperatorSkippedForVersion(inOp!, undefined)).toBe(true);
    expect(isInOperatorSkippedForVersion(inOp!, '')).toBe(true);
  });

  it('never gates a non-in-operator scenario', () => {
    expect(isInOperatorSkippedForVersion(filter!, undefined)).toBe(false);
    expect(isInOperatorSkippedForVersion(filter!, '4.01')).toBe(false);
    expect(isInOperatorSkippedForVersion(filter!, '4.0')).toBe(false);
  });
});
