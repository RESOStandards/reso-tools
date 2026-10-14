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
  /**
   * When set, restricts retries to failures whose HTTP status is in this list — a
   * response-status allowlist layered on top of the method-aware retry decision. A
   * failure with no status (a network drop or timeout) is therefore never retried
   * when this is set. Omit for the default: retry every retryable failure the method
   * permits. A caller that wants "retry only when the server told us to come back"
   * (429 / 503) passes `[429, 503]`.
   */
  readonly retryableStatuses?: ReadonlyArray<number>;
  /**
   * Wall-clock budget for the WHOLE run (all requests sharing this session), in ms.
   * Once it is spent, a request fails fast with `deadline-exceeded` rather than issuing
   * or waiting further — the client's own equivalent of a job-scheduler kill, so a
   * direct consumer caught in a 429 flood gets a graceful stop instead of an unbounded
   * hang. Omit for no total cap (the per-request `timeoutMs` still bounds each request).
   */
  readonly totalTimeoutMs?: number;
}

export interface ResolvedResilienceConfig {
  readonly backoff: BackoffConfig;
  readonly timeoutMs: number;
  readonly defaultRetryWaitMs: number;
  readonly maxRetryWaitMs: number;
  /** Response-status retry allowlist; undefined = retry every retryable failure the method permits. */
  readonly retryableStatuses?: ReadonlyArray<number>;
  /** Wall-clock budget for the whole run in ms; undefined = no total cap. */
  readonly totalTimeoutMs?: number;
}

export interface ResilienceSession {
  readonly governor: Governor;
  readonly breaker: CircuitBreaker;
  readonly config: ResolvedResilienceConfig;
  /** Wall-clock ms when the run began; with `config.totalTimeoutMs` it bounds the whole run. */
  readonly startedAtMs: number;
}

/**
 * Builds a resilience session. `governor`/`breaker` may be supplied pre-built
 * (tests inject fake-clock or spy instances); otherwise they are created from the
 * config with real deps.
 */
export const createResilienceSession = (
  config: ResilienceConfig = {},
  parts?: { readonly governor?: Governor; readonly breaker?: CircuitBreaker; readonly now?: () => number }
): ResilienceSession => ({
  governor: parts?.governor ?? createGovernor(config.governor),
  breaker: parts?.breaker ?? createCircuitBreaker(config.breaker),
  startedAtMs: parts?.now?.() ?? Date.now(),
  config: {
    backoff: config.backoff ?? DEFAULT_BACKOFF,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultRetryWaitMs: config.defaultRetryWaitMs ?? DEFAULT_RETRY_WAIT_MS,
    maxRetryWaitMs: config.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS,
    retryableStatuses: config.retryableStatuses,
    totalTimeoutMs: config.totalTimeoutMs
  }
});
