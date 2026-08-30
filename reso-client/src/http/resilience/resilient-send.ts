/**
 * The resilient send — orchestrates one logical request end to end:
 *
 *   circuit check → governor (pace) → timeout(send) → classify →
 *     success        → mark reachable, return the response
 *     terminal 4xx   → mark reachable, return the response (the consumer inspects it)
 *     fatal auth     → mark reachable, throw (never retry; stop the run)
 *     health failure → retry (Retry-After for throttles, backoff for transients),
 *                      or, once exhausted, mark reachable and return the response
 *     transport death→ retry, or once exhausted mark UNREACHABLE and throw exhausted
 *
 * The breaker tracks REACHABILITY, not error rate: any HTTP response — a 5xx
 * included — proves the endpoint answered, so it resets the breaker; only a network
 * drop or timeout (no response) counts against it. A server that merely errors on a
 * request therefore never trips the breaker, which matters both for replication (one
 * bad row can't halt the rest) and for certification (a 5xx is a result to record).
 * Sleep, jitter, and clock are injectable so tests run instantly and deterministically.
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

  // A status allowlist (when configured) further gates the method-aware retry decision:
  // only failures whose status is listed may retry. A failure with no status — a network
  // drop or a timeout — is therefore never retried under an allowlist. Undefined = no
  // restriction (retry every retryable failure the method permits).
  const statusAllowsRetry = (classification: FailureClassification): boolean =>
    config.retryableStatuses === undefined ||
    (classification.status !== undefined && config.retryableStatuses.includes(classification.status));

  // The run's absolute wall-clock deadline (or undefined for no total cap). Once now is at
  // or past it, we stop rather than issue another request or wait out another retry.
  const deadlineMs =
    config.totalTimeoutMs !== undefined ? session.startedAtMs + config.totalTimeoutMs : undefined;
  const pastDeadline = (now: number): boolean => deadlineMs !== undefined && now >= deadlineMs;
  const wouldOverrunDeadline = (waitMs: number, now: number): boolean =>
    deadlineMs !== undefined && now + waitMs >= deadlineMs;

  const attempt = async (retriesUsed: number): Promise<ODataResponse> => {
    if (pastDeadline(deps.now())) {
      throw resilienceError('deadline-exceeded', `Total run timeout of ${config.totalTimeoutMs}ms exceeded.`);
    }
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

    // ── A response came back — the endpoint is reachable, so the breaker is healthy
    // regardless of status. A 5xx means "responding, but erroring", not "unreachable":
    // only a transport death (below) counts against the breaker. ──
    if ('response' in outcome) {
      const { response } = outcome;
      const classification = classifyResponse(response);

      if (classification === null) {
        breaker.onSuccess(key);
        return response;
      }
      if (classification.kind === 'fatal-auth') {
        breaker.onSuccess(key); // the server answered (401) — reachable; the auth failure is orthogonal
        throw resilienceError('fatal-auth', classification.message, classification);
      }
      if (classification.kind === 'terminal-4xx') {
        breaker.onSuccess(key);
        return response; // a client error the consumer inspects — not retried
      }

      // health-relevant response failure (throttle-429 / transient-5xx)
      const canRetry =
        shouldRetry(classification, method) &&
        statusAllowsRetry(classification) &&
        retriesUsed < config.backoff.maxRetries;
      if (!canRetry) {
        breaker.onSuccess(key); // the server responded (429/5xx) — reachable, just erroring
        return response; // exhausted or not retryable — surface the 429/5xx for the consumer to judge
      }
      const retryAfterMs = parseRetryAfterMs(response.headers['retry-after'], deps.now());
      if (retryAfterMs !== null && retryAfterMs > config.maxRetryWaitMs) {
        breaker.onSuccess(key); // still a live response — the wait is just too long to hold open
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
      const waitMs = retryAfterMs ?? fallback;
      if (wouldOverrunDeadline(waitMs, deps.now())) {
        breaker.onSuccess(key); // reachable — we just can't afford to wait out the retry
        throw resilienceError('deadline-exceeded', `Total run timeout would be exceeded by a ${waitMs}ms wait.`);
      }
      await deps.sleep(waitMs);
      return attempt(retriesUsed + 1);
    }

    // ── The request threw (network / timeout) — no response ──
    const classification = outcome.thrown;
    // A thrown failure has no HTTP status, so an allowlist (which lists statuses) never
    // admits it — a caller that restricts retries to specific statuses does not retry
    // network drops or timeouts.
    const canRetry =
      shouldRetry(classification, method) &&
      statusAllowsRetry(classification) &&
      retriesUsed < config.backoff.maxRetries;
    if (!canRetry) {
      breaker.onFailure(key);
      throw resilienceError('exhausted', classification.message, classification);
    }
    const waitMs = backoffMs(retriesUsed, config.backoff, deps.random);
    if (wouldOverrunDeadline(waitMs, deps.now())) {
      breaker.onFailure(key); // no response, and we're out of budget to keep trying
      throw resilienceError('deadline-exceeded', `Total run timeout would be exceeded by a ${waitMs}ms wait.`);
    }
    await deps.sleep(waitMs);
    return attempt(retriesUsed + 1);
  };

  return attempt(0);
};
