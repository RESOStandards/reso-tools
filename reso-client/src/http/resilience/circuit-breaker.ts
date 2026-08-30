/**
 * Per-key circuit breaker.
 *
 * Keyed by `host|resource` (same as the governor), so one unreachable resource
 * trips only its own breaker, not the whole host. After `threshold` CONSECUTIVE
 * failures the breaker opens and requests fail fast; after `cooldownMs` it
 * half-opens to admit a single probe, which closes it on success or re-opens it
 * on failure.
 *
 * The counter is CONSECUTIVE (reset on any success) — the legacy client's was
 * cumulative, so a handful of scattered blips over a long healthy run would kill
 * it. The breaker tracks REACHABILITY, so the caller (see resilient-send) feeds it
 * that way: any HTTP response — 2xx, 4xx, or 5xx — is a success (the endpoint
 * answered), and ONLY a transport death with no response (a network drop or a
 * timeout that exhausts retries) is a failure. A server that responds with errors
 * is reachable and must not trip the breaker.
 *
 * `now` is injectable so cooldown transitions are deterministic in tests.
 */

export interface BreakerConfig {
  /** Consecutive health-relevant failures that trip the breaker open. */
  readonly threshold: number;
  /** How long the breaker stays open before admitting a probe. */
  readonly cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 5, cooldownMs: 30_000 };

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerDeps {
  readonly now: () => number;
}

const realBreakerDeps: BreakerDeps = { now: () => Date.now() };

export interface CircuitBreaker {
  /** Whether a request to `key` may proceed now; transitions open→half-open once the cooldown elapses. */
  canProceed(key: string): boolean;
  onSuccess(key: string): void;
  onFailure(key: string): void;
  stateOf(key: string): BreakerState;
}

interface Entry {
  failures: number;
  state: BreakerState;
  openedAtMs: number;
}

export const createCircuitBreaker = (
  config: BreakerConfig = DEFAULT_BREAKER,
  deps: BreakerDeps = realBreakerDeps
): CircuitBreaker => {
  const entries = new Map<string, Entry>();

  const entryFor = (key: string): Entry => {
    const existing = entries.get(key);
    if (existing) return existing;
    const fresh: Entry = { failures: 0, state: 'closed', openedAtMs: 0 };
    entries.set(key, fresh);
    return fresh;
  };

  const canProceed = (key: string): boolean => {
    const entry = entryFor(key);
    if (entry.state === 'open') {
      if (deps.now() - entry.openedAtMs >= config.cooldownMs) {
        entry.state = 'half-open'; // admit a single probe
        return true;
      }
      return false;
    }
    return true; // closed, or half-open (probe in flight)
  };

  const onSuccess = (key: string): void => {
    const entry = entryFor(key);
    entry.failures = 0;
    entry.state = 'closed';
  };

  const onFailure = (key: string): void => {
    const entry = entryFor(key);
    entry.failures += 1;
    if (entry.state === 'half-open' || entry.failures >= config.threshold) {
      entry.state = 'open';
      entry.openedAtMs = deps.now();
    }
  };

  const stateOf = (key: string): BreakerState => entryFor(key).state;

  return { canProceed, onSuccess, onFailure, stateOf };
};
