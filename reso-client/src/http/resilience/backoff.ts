/**
 * Exponential backoff with full jitter, and the method-aware retry decision.
 *
 * Backoff is the fallback wait when a failure carries no usable Retry-After.
 * The retry decision layers method safety on top of the failure classification:
 * an idempotent request can always be retried on a retryable failure, but a
 * non-idempotent one (POST/PATCH) must only be retried when the server
 * demonstrably did NOT process it — otherwise a timeout or ambiguous 5xx could
 * cause a duplicate create/update.
 */

import type { FailureClassification } from './errors.js';

export interface BackoffConfig {
  /** Backoff step for the first retry; doubles each attempt. */
  readonly baseMs: number;
  /** Ceiling for a single backoff wait. */
  readonly maxMs: number;
  /** Maximum retries beyond the initial attempt. */
  readonly maxRetries: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 500, maxMs: 30_000, maxRetries: 5 };

/**
 * Full-jitter exponential backoff: a random value in `[0, min(maxMs, baseMs * 2^attempt))`.
 * `attempt` is 0-based (0 = the wait before the first retry). Full jitter (rather
 * than fixed or equal jitter) is what keeps many parallel fetchers from resyncing
 * into a thundering herd. `random` is injectable for deterministic tests.
 */
export const backoffMs = (
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random
): number => {
  const ceiling = Math.min(config.maxMs, config.baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
};

/** Methods whose repetition is safe by HTTP semantics even when a failure is ambiguous. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/** Statuses that prove the server did NOT act on the request, so even a mutation is safe to retry. */
const NOT_PROCESSED_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/**
 * Whether to retry a failure, given the request method.
 *
 * - Non-retryable failures (terminal-4xx, fatal-auth): never.
 * - Idempotent methods: retry any retryable failure — repetition is safe.
 * - Non-idempotent methods (POST/PATCH): retry only when the failure proves the
 *   request was not processed (429 Too Many Requests, 503 Service Unavailable).
 *   Never on a timeout, a network drop, or an ambiguous 5xx (500/502/504), where
 *   the mutation may already have landed.
 */
export const shouldRetry = (classification: FailureClassification, method: string): boolean => {
  if (!classification.retryable) return false;
  if (IDEMPOTENT_METHODS.has(method.toUpperCase())) return true;
  return classification.status !== undefined && NOT_PROCESSED_STATUSES.has(classification.status);
};
