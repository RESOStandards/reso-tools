import { describe, expect, it } from 'vitest';
import { type BreakerDeps, createCircuitBreaker } from '../src/http/resilience/circuit-breaker.js';

const fakeClock = (): BreakerDeps & { advance: (ms: number) => void } => {
  const state = { now: 0 };
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    }
  };
};

describe('createCircuitBreaker', () => {
  it('starts closed and admits requests', () => {
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 1000 }, fakeClock());
    expect(b.stateOf('k')).toBe('closed');
    expect(b.canProceed('k')).toBe(true);
  });

  it('opens after threshold consecutive failures, then fails fast', () => {
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 1000 }, fakeClock());
    b.onFailure('k');
    b.onFailure('k');
    expect(b.stateOf('k')).toBe('closed');
    b.onFailure('k'); // 3rd consecutive → open
    expect(b.stateOf('k')).toBe('open');
    expect(b.canProceed('k')).toBe(false);
  });

  it('resets the counter on success (consecutive, not cumulative — the legacy bug)', () => {
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 1000 }, fakeClock());
    b.onFailure('k');
    b.onFailure('k');
    b.onSuccess('k'); // reset
    b.onFailure('k');
    b.onFailure('k'); // only 2 consecutive since the success
    expect(b.stateOf('k')).toBe('closed');
    expect(b.canProceed('k')).toBe(true);
  });

  it('half-opens after the cooldown to admit a probe', () => {
    const clock = fakeClock();
    const b = createCircuitBreaker({ threshold: 1, cooldownMs: 1000 }, clock);
    b.onFailure('k'); // open at t=0
    expect(b.canProceed('k')).toBe(false);
    clock.advance(1000);
    expect(b.canProceed('k')).toBe(true);
    expect(b.stateOf('k')).toBe('half-open');
  });

  it('closes on a successful probe', () => {
    const clock = fakeClock();
    const b = createCircuitBreaker({ threshold: 1, cooldownMs: 1000 }, clock);
    b.onFailure('k');
    clock.advance(1000);
    b.canProceed('k'); // → half-open
    b.onSuccess('k'); // probe succeeded
    expect(b.stateOf('k')).toBe('closed');
    expect(b.canProceed('k')).toBe(true);
  });

  it('re-opens on a failed probe with a fresh cooldown', () => {
    const clock = fakeClock();
    const b = createCircuitBreaker({ threshold: 1, cooldownMs: 1000 }, clock);
    b.onFailure('k'); // open at t=0
    clock.advance(1000);
    b.canProceed('k'); // → half-open at t=1000
    b.onFailure('k'); // probe failed → re-open, openedAt=1000
    expect(b.stateOf('k')).toBe('open');
    expect(b.canProceed('k')).toBe(false); // still within the fresh cooldown
    clock.advance(1000);
    expect(b.canProceed('k')).toBe(true); // half-open again at t=2000
  });

  it('keys breakers independently', () => {
    const b = createCircuitBreaker({ threshold: 1, cooldownMs: 1000 }, fakeClock());
    b.onFailure('A');
    expect(b.canProceed('A')).toBe(false);
    expect(b.canProceed('B')).toBe(true);
  });
});
