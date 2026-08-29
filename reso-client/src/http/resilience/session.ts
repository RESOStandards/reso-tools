/**
 * The resilience session — the injected, per-run service that holds the
 * cross-call state (rate governors + circuit breakers, keyed per host|resource)
 * and the resolved config. One session is created per run and shared by every
 * request, so the per-call client model stays untouched while pacing and breaker
 * state persist across requests (and, later, across parallel fetchers).
 */

import { type BackoffConfig, DEFAULT_BACKOFF } from './backoff.js';
import { type BreakerConfig, type CircuitBreaker, createCircuitBreaker } from './circuit-breaker.js';
import { type Governor, type GovernorConfig, createGovernor } from './rate-governor.js';

/** Per-request timeout: 15 min, long enough to tolerate legitimately slow pages. */
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Fallback wait when a 429/503 carries no usable Retry-After: 15 min. */
export const DEFAULT_RETRY_WAIT_MS = 15 * 60_000;
/** Ceiling: a Retry-After beyond this surfaces rather than blocking the run: 90 min. */
export const MAX_RETRY_WAIT_MS = 90 * 60_000;

export interface ResilienceConfig {
  readonly governor?: GovernorConfig;
  readonly breaker?: BreakerConfig;
  readonly backoff?: BackoffConfig;
  readonly timeoutMs?: number;
  readonly defaultRetryWaitMs?: number;
  readonly maxRetryWaitMs?: number;
}

export interface ResolvedResilienceConfig {
  readonly backoff: BackoffConfig;
  readonly timeoutMs: number;
  readonly defaultRetryWaitMs: number;
  readonly maxRetryWaitMs: number;
}

export interface ResilienceSession {
  readonly governor: Governor;
  readonly breaker: CircuitBreaker;
  readonly config: ResolvedResilienceConfig;
}

/**
 * Builds a resilience session. `governor`/`breaker` may be supplied pre-built
 * (tests inject fake-clock or spy instances); otherwise they are created from the
 * config with real deps.
 */
export const createResilienceSession = (
  config: ResilienceConfig = {},
  parts?: { readonly governor?: Governor; readonly breaker?: CircuitBreaker }
): ResilienceSession => ({
  governor: parts?.governor ?? createGovernor(config.governor),
  breaker: parts?.breaker ?? createCircuitBreaker(config.breaker),
  config: {
    backoff: config.backoff ?? DEFAULT_BACKOFF,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultRetryWaitMs: config.defaultRetryWaitMs ?? DEFAULT_RETRY_WAIT_MS,
    maxRetryWaitMs: config.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS
  }
});
