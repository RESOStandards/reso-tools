import { describe, expect, it } from 'vitest';
import { type BreakerState, type CircuitBreaker, createCircuitBreaker } from '../src/http/resilience/circuit-breaker.js';
import { isResilienceError } from '../src/http/resilience/errors.js';
import type { Governor } from '../src/http/resilience/rate-governor.js';
import { resilientSend, type SendDeps } from '../src/http/resilience/resilient-send.js';
import type { ResilienceSession } from '../src/http/resilience/session.js';
import type { ODataResponse } from '../src/types.js';

const res = (status: number, headers: Record<string, string> = {}): ODataResponse => ({
  status,
  headers,
  body: status < 300 ? { value: [] } : null,
  rawBody: ''
});

const spyGovernor = (): { governor: Governor; acquired: string[] } => {
  const acquired: string[] = [];
  return {
    governor: {
      acquire: async (key: string) => {
        acquired.push(key);
      }
    },
    acquired
  };
};

const spyBreaker = (canProceed = true): { breaker: CircuitBreaker; events: string[] } => {
  const events: string[] = [];
  return {
    breaker: {
      canProceed: () => canProceed,
      onSuccess: (key: string) => events.push(`success:${key}`),
      onFailure: (key: string) => events.push(`failure:${key}`),
      stateOf: (): BreakerState => 'closed'
    },
    events
  };
};

type Scripted = { response: ODataResponse } | { throw: unknown };

const scriptedSend = (
  outcomes: readonly Scripted[]
): { send: (signal: AbortSignal) => Promise<ODataResponse>; calls: () => number } => {
  const queue = [...outcomes];
  const state = { calls: 0 };
  return {
    send: async () => {
      state.calls += 1;
      const next = queue.shift();
      if (!next) throw new Error('scripted send exhausted');
      if ('throw' in next) throw next.throw;
      return next.response;
    },
    calls: () => state.calls
  };
};

const fakeDeps = (): SendDeps & { waits: number[] } => {
  const waits: number[] = [];
  return {
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    random: () => 0, // full-jitter backoff collapses to 0 → deterministic
    now: () => 0,
    waits
  };
};

const sessionWith = (
  governor: Governor,
  breaker: CircuitBreaker,
  configOverrides: Partial<ResilienceSession['config']> = {},
  startedAtMs = 0
): ResilienceSession => ({
  governor,
  breaker,
  startedAtMs,
  config: {
    backoff: { baseMs: 100, maxMs: 1000, maxRetries: 3 },
    timeoutMs: 1000,
    defaultRetryWaitMs: 5000,
    maxRetryWaitMs: 60_000,
    ...configOverrides
  }
});

// Deps with a fixed clock reading, for exercising the run deadline deterministically.
const fakeDepsAt = (nowValue: number): SendDeps & { waits: number[] } => {
  const waits: number[] = [];
  return { sleep: async (ms: number) => { waits.push(ms); }, random: () => 0, now: () => nowValue, waits };
};

const networkError = (code: string): Error => Object.assign(new Error('boom'), { code });

describe('resilientSend', () => {
  it('returns a 2xx, paces once, and marks the breaker healthy', async () => {
    const g = spyGovernor();
    const b = spyBreaker();
    const s = scriptedSend([{ response: res(200) }]);
    const deps = fakeDeps();

    const out = await resilientSend(s.send, 'GET', 'k', sessionWith(g.governor, b.breaker), deps);

    expect(out.status).toBe(200);
    expect(g.acquired).toEqual(['k']);
    expect(b.events).toEqual(['success:k']);
    expect(s.calls()).toBe(1);
    expect(deps.waits).toEqual([]);
  });

  it('backs off a 429 by its Retry-After, then returns the retried success', async () => {
    const g = spyGovernor();
    const b = spyBreaker();
    const s = scriptedSend([{ response: res(429, { 'retry-after': '2' }) }, { response: res(200) }]);
    const deps = fakeDeps();

    const out = await resilientSend(s.send, 'GET', 'k', sessionWith(g.governor, b.breaker), deps);

    expect(out.status).toBe(200);
    expect(s.calls()).toBe(2);
    expect(deps.waits).toEqual([2000]); // 2s Retry-After
    expect(b.events).toEqual(['success:k']); // breaker fed once, on the final outcome
    expect(g.acquired).toEqual(['k', 'k']);
  });

  it('uses the default rate-limit wait when a 429 carries no Retry-After', async () => {
    const s = scriptedSend([{ response: res(429) }, { response: res(200) }]);
    const deps = fakeDeps();
    const out = await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, spyBreaker().breaker), deps);
    expect(out.status).toBe(200);
    expect(deps.waits).toEqual([5000]); // defaultRetryWaitMs
  });

  it('returns a terminal 4xx unchanged and marks the endpoint reachable (a response = alive)', async () => {
    const b = spyBreaker();
    const s = scriptedSend([{ response: res(404) }]);
    const deps = fakeDeps();
    const out = await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), deps);
    expect(out.status).toBe(404);
    expect(s.calls()).toBe(1);
    expect(b.events).toEqual(['success:k']); // reachability breaker: any response resets it
    expect(deps.waits).toEqual([]);
  });

  it('throws a typed fatal on a 401 but still marks the endpoint reachable (it answered)', async () => {
    const b = spyBreaker();
    const s = scriptedSend([{ response: res(401) }]);
    try {
      await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), fakeDeps());
      expect.unreachable('401 should have thrown');
    } catch (err) {
      expect(isResilienceError(err)).toBe(true);
      if (isResilienceError(err)) expect(err.resilienceKind).toBe('fatal-auth');
    }
    expect(b.events).toEqual(['success:k']); // the 401 is a response — the auth failure is orthogonal to reachability
  });

  it('retries a network error for a GET up to maxRetries, then throws exhausted', async () => {
    const b = spyBreaker();
    const s = scriptedSend(Array.from({ length: 4 }, () => ({ throw: networkError('ECONNRESET') })));
    const deps = fakeDeps();
    try {
      await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), deps);
      expect.unreachable('exhausted network error should have thrown');
    } catch (err) {
      expect(isResilienceError(err)).toBe(true);
      if (isResilienceError(err)) expect(err.resilienceKind).toBe('exhausted');
    }
    expect(s.calls()).toBe(4); // initial + 3 retries
    expect(deps.waits).toEqual([0, 0, 0]); // 3 backoff sleeps
    expect(b.events).toEqual(['failure:k']); // one health failure at the end
  });

  it('does NOT retry a mutation on an ambiguous network error', async () => {
    const b = spyBreaker();
    const s = scriptedSend([{ throw: networkError('ETIMEDOUT') }]);
    try {
      await resilientSend(s.send, 'POST', 'k', sessionWith(spyGovernor().governor, b.breaker), fakeDeps());
      expect.unreachable();
    } catch (err) {
      expect(isResilienceError(err) && err.resilienceKind === 'exhausted').toBe(true);
    }
    expect(s.calls()).toBe(1);
    expect(b.events).toEqual(['failure:k']);
  });

  it('fails fast when the circuit is open (no send, no pacing)', async () => {
    const g = spyGovernor();
    const s = scriptedSend([{ response: res(200) }]);
    try {
      await resilientSend(s.send, 'GET', 'k', sessionWith(g.governor, spyBreaker(false).breaker), fakeDeps());
      expect.unreachable();
    } catch (err) {
      expect(isResilienceError(err) && err.resilienceKind === 'circuit-open').toBe(true);
    }
    expect(s.calls()).toBe(0);
    expect(g.acquired).toEqual([]);
  });

  it('surfaces a Retry-After beyond the ceiling instead of blocking (still a live response)', async () => {
    const b = spyBreaker();
    const s = scriptedSend([{ response: res(429, { 'retry-after': '999999' }) }]);
    try {
      await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), fakeDeps());
      expect.unreachable();
    } catch (err) {
      expect(isResilienceError(err) && err.resilienceKind === 'retry-wait-exceeded').toBe(true);
    }
    expect(b.events).toEqual(['success:k']); // the 429 is a response — reachable; we just won't hold that long
  });

  it('returns the last 5xx once retries are exhausted, marking the endpoint reachable (not a breaker failure)', async () => {
    const b = spyBreaker();
    const s = scriptedSend(Array.from({ length: 4 }, () => ({ response: res(500) })));
    const deps = fakeDeps();
    const out = await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), deps);
    expect(out.status).toBe(500);
    expect(s.calls()).toBe(4);
    expect(b.events).toEqual(['success:k']); // a 5xx is "responding, but erroring" — reachable, so it must not trip the breaker
    expect(deps.waits).toEqual([0, 0, 0]);
  });

  it('retries a mutation on a 503 (server proved it did not process it)', async () => {
    const s = scriptedSend([{ response: res(503, { 'retry-after': '1' }) }, { response: res(200) }]);
    const deps = fakeDeps();
    const out = await resilientSend(s.send, 'POST', 'k', sessionWith(spyGovernor().governor, spyBreaker().breaker), deps);
    expect(out.status).toBe(200);
    expect(deps.waits).toEqual([1000]);
  });
});

describe('resilientSend with a retryableStatuses allowlist (retry only when the server says come back)', () => {
  const allowlist = { retryableStatuses: [429, 503] as const };

  it('retries a 429 (listed)', async () => {
    const s = scriptedSend([{ response: res(429, { 'retry-after': '1' }) }, { response: res(200) }]);
    const deps = fakeDeps();
    const out = await resilientSend(
      s.send, 'GET', 'k', sessionWith(spyGovernor().governor, spyBreaker().breaker, allowlist), deps
    );
    expect(out.status).toBe(200);
    expect(s.calls()).toBe(2);
  });

  it('retries a 503 (listed)', async () => {
    const s = scriptedSend([{ response: res(503, { 'retry-after': '1' }) }, { response: res(200) }]);
    const deps = fakeDeps();
    const out = await resilientSend(
      s.send, 'GET', 'k', sessionWith(spyGovernor().governor, spyBreaker().breaker, allowlist), deps
    );
    expect(out.status).toBe(200);
    expect(s.calls()).toBe(2);
  });

  it('does NOT retry a 500 (not listed) — returns it on the first attempt', async () => {
    const s = scriptedSend([{ response: res(500) }]);
    const deps = fakeDeps();
    const out = await resilientSend(
      s.send, 'GET', 'k', sessionWith(spyGovernor().governor, spyBreaker().breaker, allowlist), deps
    );
    expect(out.status).toBe(500);
    expect(s.calls()).toBe(1); // no retry
    expect(deps.waits).toEqual([]);
  });

  it('does NOT retry a network drop (no status can be in the allowlist) — throws exhausted on the first attempt', async () => {
    const s = scriptedSend([{ throw: networkError('ECONNRESET') }]);
    try {
      await resilientSend(
        s.send, 'GET', 'k', sessionWith(spyGovernor().governor, spyBreaker().breaker, allowlist), fakeDeps()
      );
      expect.unreachable('an unlisted network drop should not retry');
    } catch (err) {
      expect(isResilienceError(err) && err.resilienceKind === 'exhausted').toBe(true);
    }
    expect(s.calls()).toBe(1); // no retry
  });

  it('without an allowlist, a 500 still retries (default behavior preserved)', async () => {
    const s = scriptedSend([{ response: res(500) }, { response: res(200) }]);
    const out = await resilientSend(
      s.send, 'GET', 'k', sessionWith(spyGovernor().governor, spyBreaker().breaker), fakeDeps()
    );
    expect(out.status).toBe(200);
    expect(s.calls()).toBe(2); // retried
  });
});

describe('resilientSend total run deadline (totalTimeoutMs)', () => {
  it('fails fast with deadline-exceeded, without sending, once the run budget is spent', async () => {
    const s = scriptedSend([{ response: res(200) }]);
    // budget 1000ms from start=0; the clock already reads 1500 → past the deadline.
    const session = sessionWith(spyGovernor().governor, spyBreaker().breaker, { totalTimeoutMs: 1000 }, 0);
    try {
      await resilientSend(s.send, 'GET', 'k', session, fakeDepsAt(1500));
      expect.unreachable('a spent budget should fail fast');
    } catch (err) {
      expect(isResilienceError(err) && err.resilienceKind === 'deadline-exceeded').toBe(true);
    }
    expect(s.calls()).toBe(0); // never issued
  });

  it('proceeds normally while the run budget remains', async () => {
    const s = scriptedSend([{ response: res(200) }]);
    const session = sessionWith(spyGovernor().governor, spyBreaker().breaker, { totalTimeoutMs: 1000 }, 0);
    const out = await resilientSend(s.send, 'GET', 'k', session, fakeDepsAt(500)); // within budget
    expect(out.status).toBe(200);
    expect(s.calls()).toBe(1);
  });

  it('refuses to wait out a retry it cannot afford (a 429 wait longer than the remaining budget)', async () => {
    // A 429 asks for a 5s wait, but only 1s of run budget remains → do not sleep, stop instead.
    const s = scriptedSend([{ response: res(429, { 'retry-after': '5' }) }, { response: res(200) }]);
    const deps = fakeDepsAt(0);
    const session = sessionWith(spyGovernor().governor, spyBreaker().breaker, { totalTimeoutMs: 1000 }, 0);
    try {
      await resilientSend(s.send, 'GET', 'k', session, deps);
      expect.unreachable('an unaffordable retry wait should stop the run');
    } catch (err) {
      expect(isResilienceError(err) && err.resilienceKind === 'deadline-exceeded').toBe(true);
    }
    expect(s.calls()).toBe(1); // sent once, then stopped rather than sleeping 5s
    expect(deps.waits).toEqual([]); // never slept
  });

  it('has no deadline when totalTimeoutMs is unset (default) — a far-future clock still proceeds', async () => {
    const s = scriptedSend([{ response: res(200) }]);
    const out = await resilientSend(
      s.send, 'GET', 'k', sessionWith(spyGovernor().governor, spyBreaker().breaker), fakeDepsAt(9_999_999)
    );
    expect(out.status).toBe(200);
  });
});

describe('resilientSend breaker feeding is reachability, not error rate', () => {
  const allowlist = { retryableStatuses: [429, 503] as const }; // keeps each request to one attempt

  // for...of over a fixed-length array: sequential awaits without leaking a loop counter.
  const runN = async (n: number, once: () => Promise<void>): Promise<void> => {
    for (const _ of Array.from({ length: n })) await once();
  };

  it('never opens the breaker on repeated 5xx responses (the endpoint is reachable, just erroring)', async () => {
    const breaker = createCircuitBreaker(); // default threshold 5
    const g = spyGovernor();
    await runN(10, async () => {
      const s = scriptedSend([{ response: res(500) }]);
      await resilientSend(s.send, 'GET', 'k', sessionWith(g.governor, breaker, allowlist), fakeDeps());
    });
    expect(breaker.stateOf('k')).toBe('closed');
    expect(breaker.canProceed('k')).toBe(true);
  });

  it('opens the breaker after threshold consecutive transport deaths (no response)', async () => {
    const breaker = createCircuitBreaker(); // default threshold 5
    const g = spyGovernor();
    await runN(5, async () => {
      const s = scriptedSend([{ throw: networkError('ECONNRESET') }]);
      await resilientSend(s.send, 'GET', 'k', sessionWith(g.governor, breaker, allowlist), fakeDeps()).catch(() => {});
    });
    expect(breaker.stateOf('k')).toBe('open');
  });

  it('a single reachable response resets the consecutive transport-death count', async () => {
    const breaker = createCircuitBreaker(); // default threshold 5
    const g = spyGovernor();
    const death = async () => {
      const s = scriptedSend([{ throw: networkError('ECONNRESET') }]);
      await resilientSend(s.send, 'GET', 'k', sessionWith(g.governor, breaker, allowlist), fakeDeps()).catch(() => {});
    };
    await runN(4, death); // one below threshold
    const alive = scriptedSend([{ response: res(500) }]); // a 5xx still proves reachability → resets
    await resilientSend(alive.send, 'GET', 'k', sessionWith(g.governor, breaker, allowlist), fakeDeps());
    await runN(4, death); // 4 more deaths — count restarted, so still closed
    expect(breaker.stateOf('k')).toBe('closed');
  });
});
