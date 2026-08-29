import { describe, expect, it } from 'vitest';
import { createGovernor, type GovernorDeps } from '../src/http/resilience/rate-governor.js';

/** A fake clock whose `sleep` advances virtual time and resolves instantly — no real waits. */
const fakeClock = (): GovernorDeps & { elapsed: () => number } => {
  const state = { now: 0 };
  return {
    now: () => state.now,
    sleep: async (ms: number) => {
      state.now += ms;
    },
    elapsed: () => state.now
  };
};

describe('createGovernor', () => {
  it('does not pace when disabled (ratePerSec 0)', async () => {
    const clock = fakeClock();
    const gov = createGovernor({ ratePerSec: 0, burst: 1 }, clock);
    await gov.acquire('k');
    await gov.acquire('k');
    await gov.acquire('k');
    expect(clock.elapsed()).toBe(0);
  });

  it('lets an isolated/first request through immediately (bucket starts full)', async () => {
    const clock = fakeClock();
    const gov = createGovernor({ ratePerSec: 1, burst: 1 }, clock);
    await gov.acquire('k');
    expect(clock.elapsed()).toBe(0);
  });

  it('paces sustained requests to the configured rate', async () => {
    const clock = fakeClock();
    const gov = createGovernor({ ratePerSec: 1, burst: 1 }, clock);
    await gov.acquire('k'); // immediate
    await gov.acquire('k'); // +1000
    await gov.acquire('k'); // +1000
    expect(clock.elapsed()).toBe(2000);
  });

  it('keys buckets independently — one key does not pace another', async () => {
    const clock = fakeClock();
    const gov = createGovernor({ ratePerSec: 1, burst: 1 }, clock);
    await gov.acquire('A'); // immediate
    await gov.acquire('A'); // +1000
    const before = clock.elapsed();
    await gov.acquire('B'); // fresh bucket → immediate
    expect(clock.elapsed()).toBe(before);
  });

  it('serializes concurrent acquires on one key (shared budget, parallelism-safe)', async () => {
    const clock = fakeClock();
    const gov = createGovernor({ ratePerSec: 1, burst: 1 }, clock);
    // Five acquires fired without awaiting each — they must queue and space out.
    await Promise.all([0, 1, 2, 3, 4].map(() => gov.acquire('k')));
    expect(clock.elapsed()).toBe(4000); // first immediate, then 4 × 1000ms
  });

  it('allows a burst up to capacity before pacing engages', async () => {
    const clock = fakeClock();
    const gov = createGovernor({ ratePerSec: 1, burst: 3 }, clock);
    await gov.acquire('k'); // 3 → 2
    await gov.acquire('k'); // 2 → 1
    await gov.acquire('k'); // 1 → 0
    expect(clock.elapsed()).toBe(0);
    await gov.acquire('k'); // 0 → wait 1000
    expect(clock.elapsed()).toBe(1000);
  });
});
