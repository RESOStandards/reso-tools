import { describe, expect, it } from 'vitest';
import type { BreakerState, CircuitBreaker } from '../src/http/resilience/circuit-breaker.js';
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

const sessionWith = (governor: Governor, breaker: CircuitBreaker): ResilienceSession => ({
  governor,
  breaker,
  config: {
    backoff: { baseMs: 100, maxMs: 1000, maxRetries: 3 },
    timeoutMs: 1000,
    defaultRetryWaitMs: 5000,
    maxRetryWaitMs: 60_000
  }
});

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

  it('returns a terminal 4xx unchanged, without retry or a breaker signal', async () => {
    const b = spyBreaker();
    const s = scriptedSend([{ response: res(404) }]);
    const deps = fakeDeps();
    const out = await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), deps);
    expect(out.status).toBe(404);
    expect(s.calls()).toBe(1);
    expect(b.events).toEqual([]);
    expect(deps.waits).toEqual([]);
  });

  it('throws a typed fatal on a 401 and does not touch the breaker', async () => {
    const b = spyBreaker();
    const s = scriptedSend([{ response: res(401) }]);
    try {
      await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), fakeDeps());
      expect.unreachable('401 should have thrown');
    } catch (err) {
      expect(isResilienceError(err)).toBe(true);
      if (isResilienceError(err)) expect(err.resilienceKind).toBe('fatal-auth');
    }
    expect(b.events).toEqual([]);
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

  it('surfaces a Retry-After beyond the ceiling instead of blocking', async () => {
    const b = spyBreaker();
    const s = scriptedSend([{ response: res(429, { 'retry-after': '999999' }) }]);
    try {
      await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), fakeDeps());
      expect.unreachable();
    } catch (err) {
      expect(isResilienceError(err) && err.resilienceKind === 'retry-wait-exceeded').toBe(true);
    }
    expect(b.events).toEqual(['failure:k']);
  });

  it('returns the last 5xx once retries are exhausted (so the consumer can see it)', async () => {
    const b = spyBreaker();
    const s = scriptedSend(Array.from({ length: 4 }, () => ({ response: res(500) })));
    const deps = fakeDeps();
    const out = await resilientSend(s.send, 'GET', 'k', sessionWith(spyGovernor().governor, b.breaker), deps);
    expect(out.status).toBe(500);
    expect(s.calls()).toBe(4);
    expect(b.events).toEqual(['failure:k']);
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
