import { DEFAULT_BREAKER, createResilienceSession } from '@reso-standards/reso-client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CERT_TOTAL_TIMEOUT_MS, createCertSession } from '../src/test-runner/requester.js';

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

  it('retries only the "come back later" statuses (429/503), at most twice', () => {
    // Every other failure is a verdict to record and move on: a 500/502/504 re-sent gets the
    // same answer and risks a duplicate-query block; a network/timeout is re-sent into the same
    // wall. Two retries (down from the SDK default of five) caps the wait. The SDK's allowlist
    // behavior — 429/503 retry, others do not — is covered in reso-client's resilient-send tests.
    const { config } = createCertSession();
    expect(config.backoff.maxRetries).toBe(2);
    expect(config.retryableStatuses).toEqual([429, 503]);
  });

  it('keeps a 15-minute per-request timeout — the one retained protection, declared explicitly', () => {
    // Stated independently of the source constant so an accidental change to cert's own
    // timeout (or a regression to inheriting a shorter SDK default) turns this red rather
    // than silently timing out a legitimately slow paged read as a false FAIL.
    expect(createCertSession().config.timeoutMs).toBe(15 * 60_000);
  });

  it('bounds the whole run with a total-timeout budget (a generous default), overridable per run', () => {
    // The client-side total cap is what lets a run stop gracefully (partial report) on a 429
    // flood instead of hanging; the runtime passes a value under its scheduler's own kill.
    expect(createCertSession().config.totalTimeoutMs).toBe(DEFAULT_CERT_TOTAL_TIMEOUT_MS);
    expect(createCertSession(10 * 60_000).config.totalTimeoutMs).toBe(10 * 60_000);
  });
});
