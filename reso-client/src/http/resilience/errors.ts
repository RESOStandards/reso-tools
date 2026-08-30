/**
 * Failure classification for the resilient request path.
 *
 * Every failed request — an HTTP error response or a thrown transport error —
 * is classified into the single category that drives the recovery decision, so
 * the retry and circuit-breaker logic key off one taxonomy instead of scattered
 * status checks. This widens the legacy client's HTTP-vs-transport split into
 * the distinctions that actually matter for recovery.
 */

/** The recovery-relevant category of a request failure. */
export type FailureKind =
  | 'terminal-4xx' // client error the server won't reconsider (400/403/404/409/422/501…) — do not retry
  | 'throttle-429' // rate limited — wait (Retry-After / backoff) and retry
  | 'transient-5xx' // server-side transient (500/502/503/504…) — retry with backoff
  | 'network' // fetch threw before a response (DNS/reset/refused/broken pipe) — usually transient, retry
  | 'timeout' // the request's own AbortController fired — no response in time, retry
  | 'fatal-auth'; // authentication failed and a token refresh cannot fix it (401) — stop, never retry

/** A classified failure carrying whatever detail the retry / breaker / report layers need. */
export interface FailureClassification {
  readonly kind: FailureKind;
  /** Whether the retry loop should re-attempt this failure (in principle — method-safety is decided by the caller). */
  readonly retryable: boolean;
  /** Whether this failure should stop the whole run (fatal), rather than just this request (terminal / unit-level). */
  readonly fatal: boolean;
  /** HTTP status, when the failure came from a response. */
  readonly status?: number;
  /** Transport error code (ECONNRESET, ETIMEDOUT, ENOTFOUND…), when the failure came from a thrown error. */
  readonly code?: string;
  readonly message: string;
}

const httpFailure = (
  kind: FailureKind,
  retryable: boolean,
  fatal: boolean,
  status: number,
  label: string
): FailureClassification => ({ kind, retryable, fatal, status, message: `HTTP ${status} ${label}` });

/**
 * Classifies an HTTP error status. Intended for responses with `status >= 400`
 * (call `classifyResponse` to guard on `status`). A 401 reaching here is treated
 * as fatal because the caller's token-refresh retry has already been exhausted.
 *
 * 401 is fatal (not authenticated — the whole run is doomed); 403 is terminal
 * (authenticated but forbidden for this request — skip the unit, keep going).
 * 501 Not Implemented is terminal even though it is a 5xx.
 */
export const classifyStatus = (status: number): FailureClassification => {
  if (status === 429) return httpFailure('throttle-429', true, false, status, 'Too Many Requests');
  if (status === 401) return httpFailure('fatal-auth', false, true, status, 'Unauthorized');
  if (status === 403) return httpFailure('terminal-4xx', false, false, status, 'Forbidden');
  if (status === 501) return httpFailure('terminal-4xx', false, false, status, 'Not Implemented');
  if (status >= 500) return httpFailure('transient-5xx', true, false, status, 'Server Error');
  return httpFailure('terminal-4xx', false, false, status, 'Client Error');
};

/** Classifies a response: `null` when it is not an error (`status < 400`), otherwise a classification. */
export const classifyResponse = (response: { readonly status: number }): FailureClassification | null =>
  response.status >= 400 ? classifyStatus(response.status) : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Extracts name / code / message from a thrown value WITHOUT spreading it.
 *
 * A `{...err}` spread copies only enumerable own properties, so `Error.message`,
 * `Error.stack`, and `err.code` (all non-enumerable) are silently lost — the exact
 * detail (e.g. `ECONNRESET`) the retry layer needs. `fetch`/undici also nest the
 * transport code under `err.cause.code`, so both locations are checked.
 */
const extractErrorFields = (err: unknown): { name?: string; code?: string; message: string } => {
  if (err instanceof Error) {
    const ownCode = (err as { code?: unknown }).code;
    const cause = (err as { cause?: unknown }).cause;
    const causeCode = isRecord(cause) ? cause.code : undefined;
    const code =
      typeof ownCode === 'string' ? ownCode : typeof causeCode === 'string' ? causeCode : undefined;
    return { name: err.name, code, message: err.message || err.name };
  }
  if (typeof err === 'string') return { message: err };
  return { message: 'Unknown error' };
};

/**
 * Classifies a thrown transport error. An `AbortError` (our timeout) is `timeout`;
 * anything else that threw before a response is `network`. Both are retryable in
 * principle — the caller applies method-safety (a mutation must not be retried on
 * an ambiguous timeout/drop where it may already have landed).
 */
export const classifyThrown = (err: unknown): FailureClassification => {
  const { name, code, message } = extractErrorFields(err);
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR') {
    return { kind: 'timeout', retryable: true, fatal: false, code, message: message || 'Request timed out' };
  }
  return { kind: 'network', retryable: true, fatal: false, code, message: message || 'Network error' };
};

/** The kind of an unrecoverable failure the resilient send surfaces by throwing. */
export type ResilienceErrorKind =
  | 'fatal-auth'
  | 'exhausted'
  | 'circuit-open'
  | 'retry-wait-exceeded'
  | 'deadline-exceeded'; // the run's total-timeout budget is spent — stop rather than wait/retry further

/**
 * A thrown error the resilient send could not recover from. It is a plain `Error`
 * with marker fields rather than a subclass (this codebase does not use classes),
 * so consumers narrow with `isResilienceError` and branch on `resilienceKind`.
 */
export interface ResilienceError extends Error {
  readonly resilienceKind: ResilienceErrorKind;
  readonly classification?: FailureClassification;
}

export const resilienceError = (
  resilienceKind: ResilienceErrorKind,
  message: string,
  classification?: FailureClassification
): ResilienceError => Object.assign(new Error(message), { resilienceKind, classification });

export const isResilienceError = (err: unknown): err is ResilienceError =>
  err instanceof Error && typeof (err as { resilienceKind?: unknown }).resilienceKind === 'string';
