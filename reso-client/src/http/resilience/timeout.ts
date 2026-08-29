/**
 * Per-request timeout via AbortController.
 *
 * The legacy client had no timeout — a server that connects but never responds
 * hangs the whole run forever. `withTimeout` races the request against a deadline;
 * on expiry it aborts the underlying fetch (freeing the socket) and the promise
 * rejects with an AbortError, which the classifier treats as a retryable `timeout`.
 *
 * The setTimeout here is a genuine deadline, not a synchronization hack — it is the
 * timeout mechanism itself, and it is always cleared once the request settles.
 */

/**
 * Runs `fn` with an abort signal that fires after `timeoutMs`. A non-finite or
 * non-positive `timeoutMs` disables the timeout (the signal never fires) so callers
 * can turn it off. The timer is always cleared in `finally`, so no timer lingers
 * after the request settles.
 */
export const withTimeout = async <T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fn(new AbortController().signal);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};
