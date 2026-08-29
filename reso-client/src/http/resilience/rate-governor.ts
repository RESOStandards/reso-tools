/**
 * Per-key token-bucket rate governor.
 *
 * One shared budget per key (the caller keys by `host|resource`): `acquire` waits
 * until a token is available, then consumes it, so the aggregate request rate never
 * exceeds the configured rate no matter how many callers draw from the same key —
 * a single fetcher today, parallel fetchers later. Acquires for a key are serialized
 * through a promise chain so token accounting is never interleaved (correct under
 * concurrency without a thread lock — see the single-threaded model).
 *
 * A freshly-seen key starts with a full bucket, so an isolated/first request is not
 * penalized; only sustained traffic beyond the rate waits. Clock and sleep are
 * injectable so tests run instantly with no real waits.
 */

export interface GovernorConfig {
  /** Sustained rate in requests per second. `0` disables the governor (no pacing). */
  readonly ratePerSec: number;
  /** Bucket capacity — how many requests may burst before pacing engages. */
  readonly burst: number;
}

/** RESO-safe default: ~1 req/sec, no burst beyond the first. */
export const DEFAULT_GOVERNOR: GovernorConfig = { ratePerSec: 1, burst: 1 };

export interface GovernorDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const realDeps: GovernorDeps = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
};

export interface Governor {
  /** Waits until a token is available for `key`, then consumes it. */
  acquire(key: string): Promise<void>;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  /** Tail of the serialize-acquires promise chain for this key. */
  tail: Promise<void>;
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  // The executor runs synchronously, so `resolve` is assigned before this returns.
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

export const createGovernor = (
  config: GovernorConfig = DEFAULT_GOVERNOR,
  deps: GovernorDeps = realDeps
): Governor => {
  const buckets = new Map<string, Bucket>();

  const bucketFor = (key: string): Bucket => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const fresh: Bucket = { tokens: config.burst, lastRefillMs: deps.now(), tail: Promise.resolve() };
    buckets.set(key, fresh);
    return fresh;
  };

  const refill = (bucket: Bucket): void => {
    const now = deps.now();
    const gained = ((now - bucket.lastRefillMs) / 1000) * config.ratePerSec;
    bucket.tokens = Math.min(config.burst, bucket.tokens + gained);
    bucket.lastRefillMs = now;
  };

  const acquire = async (key: string): Promise<void> => {
    if (config.ratePerSec <= 0) return; // disabled — no pacing
    const bucket = bucketFor(key);
    const previous = bucket.tail;
    const gate = deferred();
    bucket.tail = gate.promise;
    await previous; // serialize acquires for this key
    try {
      refill(bucket);
      if (bucket.tokens < 1) {
        const waitMs = ((1 - bucket.tokens) / config.ratePerSec) * 1000;
        await deps.sleep(waitMs);
        refill(bucket);
      }
      bucket.tokens -= 1;
    } finally {
      gate.resolve();
    }
  };

  return { acquire };
};
