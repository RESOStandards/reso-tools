import { describe, expect, it } from 'vitest';
import { type BackoffConfig, backoffMs, shouldRetry } from '../src/http/resilience/backoff.js';
import type { FailureClassification } from '../src/http/resilience/errors.js';

const cls = (
  over: Partial<FailureClassification> & Pick<FailureClassification, 'kind' | 'retryable'>
): FailureClassification => ({ fatal: false, message: 'x', ...over });

describe('backoffMs', () => {
  const cfg: BackoffConfig = { baseMs: 100, maxMs: 1000, maxRetries: 5 };

  it('is zero when the jitter roll is zero', () => {
    expect(backoffMs(0, cfg, () => 0)).toBe(0);
  });

  it('grows exponentially from baseMs and is capped at maxMs', () => {
    expect(backoffMs(0, cfg, () => 0.9999)).toBeLessThanOrEqual(100);
    expect(backoffMs(3, cfg, () => 0.9999)).toBeLessThanOrEqual(800); // 100 * 2^3 = 800 < cap
    expect(backoffMs(10, cfg, () => 0.9999)).toBeLessThanOrEqual(1000); // capped at maxMs
  });

  it('stays within [0, ceiling) for any jitter roll', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const v = backoffMs(2, cfg, () => r); // ceiling = min(1000, 100 * 4) = 400
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(400);
    }
  });
});

describe('shouldRetry', () => {
  it('never retries non-retryable failures', () => {
    expect(shouldRetry(cls({ kind: 'terminal-4xx', retryable: false, status: 404 }), 'GET')).toBe(false);
    expect(shouldRetry(cls({ kind: 'fatal-auth', retryable: false, fatal: true, status: 401 }), 'GET')).toBe(false);
  });

  it('retries any retryable failure for idempotent methods', () => {
    for (const m of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(shouldRetry(cls({ kind: 'network', retryable: true }), m)).toBe(true);
      expect(shouldRetry(cls({ kind: 'timeout', retryable: true }), m)).toBe(true);
      expect(shouldRetry(cls({ kind: 'transient-5xx', retryable: true, status: 500 }), m)).toBe(true);
    }
  });

  it('retries a mutation only when the server proved it did not process it (429/503)', () => {
    expect(shouldRetry(cls({ kind: 'throttle-429', retryable: true, status: 429 }), 'POST')).toBe(true);
    expect(shouldRetry(cls({ kind: 'transient-5xx', retryable: true, status: 503 }), 'PATCH')).toBe(true);
  });

  it('does NOT retry a mutation on an ambiguous failure (timeout / network / 500 / 502)', () => {
    expect(shouldRetry(cls({ kind: 'transient-5xx', retryable: true, status: 500 }), 'POST')).toBe(false);
    expect(shouldRetry(cls({ kind: 'transient-5xx', retryable: true, status: 502 }), 'POST')).toBe(false);
    expect(shouldRetry(cls({ kind: 'network', retryable: true }), 'POST')).toBe(false);
    expect(shouldRetry(cls({ kind: 'timeout', retryable: true }), 'PATCH')).toBe(false);
  });
});
