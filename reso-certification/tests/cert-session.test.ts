import { DEFAULT_BREAKER, createResilienceSession } from '@reso-standards/reso-client';
import { describe, expect, it } from 'vitest';
import { createCertSession } from '../src/test-runner/requester.js';

/**
 * Regression guard for the adversarial-review finding (#273): the run-shared circuit
 * breaker at its default threshold false-failed scenarios the server actually handles.
 * Once a burst of 5xx/timeouts on one resource opened the breaker, every later request
 * on that key short-circuited with `circuit-open` and was recorded as FAILED; on a
 * path-prefixed service root the collapsed `host|<segment>` key blocked other resources
 * too. Cert now configures the breaker inert. These tests lock that.
 */
describe('createCertSession — cert resilience configuration', () => {
  // The single key every resource collapses onto behind a path-prefixed service root
  // (host/odata/Property, host/odata/Member, …) — the worst case the breaker would harm.
  const COLLAPSED_KEY = 'host|odata';

  it('never opens the circuit breaker, so a burst on one resource cannot false-fail later scenarios or block other resources', () => {
    const { breaker } = createCertSession();

    // Ten times the default threshold — well past anything a real run could produce.
    Array.from({ length: DEFAULT_BREAKER.threshold * 10 }).forEach(() => breaker.onFailure(COLLAPSED_KEY));

    expect(breaker.stateOf(COLLAPSED_KEY)).toBe('closed');
    expect(breaker.canProceed(COLLAPSED_KEY)).toBe(true);
  });

  it('is non-vacuous: the SDK-default session WOULD open on the same burst (that is the regression this guards)', () => {
    const { breaker } = createResilienceSession();

    Array.from({ length: DEFAULT_BREAKER.threshold }).forEach(() => breaker.onFailure(COLLAPSED_KEY));

    expect(breaker.stateOf(COLLAPSED_KEY)).toBe('open');
    expect(breaker.canProceed(COLLAPSED_KEY)).toBe(false);
  });

  it('does not retry ("record the result and move on"), unlike the SDK default of five', () => {
    // A re-send in cert only risks a block (5xx is the server's verdict; 429 wants pacing,
    // not a retry) or balloons the run (a re-sent 15-min timeout). One request per scenario.
    expect(createCertSession().config.backoff.maxRetries).toBe(0);
  });

  it('keeps a 15-minute per-request timeout — the one retained protection, declared explicitly', () => {
    // Stated independently of the source constant so an accidental change to cert's own
    // timeout (or a regression to inheriting a shorter SDK default) turns this red rather
    // than silently timing out a legitimately slow paged read as a false FAIL.
    expect(createCertSession().config.timeoutMs).toBe(15 * 60_000);
  });
});
