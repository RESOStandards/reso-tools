/**
 * The resilient send — orchestrates one logical request end to end:
 *
 *   circuit check → governor (pace) → timeout(send) → classify →
 *     success        → feed breaker, return the response
 *     terminal 4xx   → return the response (the consumer inspects it; not a health signal)
 *     fatal auth     → throw (never retry; stop the run)
 *     health failure → retry (Retry-After for throttles, backoff for transients),
 *                      or, once exhausted, return the response / throw exhausted
 *
 * The breaker is fed once per LOGICAL request (its final outcome), not per retry,
 * so it tracks host/resource health across requests rather than within one. Sleep,
 * jitter, and clock are injectable so tests run instantly and deterministically.
 */

import type { ODataResponse } from '../../types.js';
import { backoffMs, shouldRetry } from './backoff.js';
import { type FailureClassification, classifyResponse, classifyThrown, resilienceError } from './errors.js';
import { parseRetryAfterMs } from './retry-after.js';
import type { ResilienceSession } from './session.js';
import { withTimeout } from './timeout.js';

export interface SendDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly now: () => number;
}

const realSendDeps: SendDeps = {
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: () => Date.now()
};

type Attempt = { readonly response: ODataResponse } | { readonly thrown: FailureClassification };

export const resilientSend = async (
  send: (signal: AbortSignal) => Promise<ODataResponse>,
  method: string,
  key: string,
  session: ResilienceSession,
  deps: SendDeps = realSendDeps
): Promise<ODataResponse> => {
  const { governor, breaker, config } = session;

  const attempt = async (retriesUsed: number): Promise<ODataResponse> => {
    if (!breaker.canProceed(key)) {
      throw resilienceError('circuit-open', `Circuit open for ${key}; failing fast.`);
    }
    await governor.acquire(key);

    const outcome: Attempt = await (async () => {
      try {
        return { response: await withTimeout(config.timeoutMs, send) };
      } catch (err) {
        return { thrown: classifyThrown(err) };
      }
    })();

    // ── A response came back ──
    if ('response' in outcome) {
      const { response } = outcome;
      const classification = classifyResponse(response);

      if (classification === null) {
        breaker.onSuccess(key);
        return response;
      }
      if (classification.kind === 'fatal-auth') {
        throw resilienceError('fatal-auth', classification.message, classification);
      }
      if (classification.kind === 'terminal-4xx') {
        return response; // a client error the consumer inspects — not retried, not a health signal
      }

      // health-relevant response failure (throttle-429 / transient-5xx)
      const canRetry = shouldRetry(classification, method) && retriesUsed < config.backoff.maxRetries;
      if (!canRetry) {
        breaker.onFailure(key);
        return response; // exhausted — surface the 429/5xx for the consumer to judge
      }
      const retryAfterMs = parseRetryAfterMs(response.headers['retry-after'], deps.now());
      if (retryAfterMs !== null && retryAfterMs > config.maxRetryWaitMs) {
        breaker.onFailure(key);
        throw resilienceError(
          'retry-wait-exceeded',
          `Retry-After exceeds the ${config.maxRetryWaitMs}ms ceiling.`,
          classification
        );
      }
      const fallback =
        classification.kind === 'throttle-429'
          ? config.defaultRetryWaitMs // rate-limit windows are long; a short backoff just re-trips
          : backoffMs(retriesUsed, config.backoff, deps.random);
      await deps.sleep(retryAfterMs ?? fallback);
      return attempt(retriesUsed + 1);
    }

    // ── The request threw (network / timeout) — no response ──
    const classification = outcome.thrown;
    const canRetry = shouldRetry(classification, method) && retriesUsed < config.backoff.maxRetries;
    if (!canRetry) {
      breaker.onFailure(key);
      throw resilienceError('exhausted', classification.message, classification);
    }
    await deps.sleep(backoffMs(retriesUsed, config.backoff, deps.random));
    return attempt(retriesUsed + 1);
  };

  return attempt(0);
};
