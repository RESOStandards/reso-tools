import { describe, expect, it } from 'vitest';

import { bytesForDistinctKeys } from '../src/state/distinct-key-set-buffer.js';
import { DEFAULT_INITIAL_DISTINCT_KEYS, createSegmentedDistinctKeySet } from '../src/state/distinct-key-set-segmented.js';

/**
 * The segmented set grows by adding a table twice the size of the newest, up to a ceiling in bytes. The three things
 * that can go wrong are the three things tested: a key lost across a doubling (it would be counted twice), a total
 * that depends on arrival order, and a ceiling that answers "not seen" when it can no longer know.
 */

const MIB = 1024 * 1024;
const keys = (count: number, prefix = 'k'): ReadonlyArray<string> => Array.from({ length: count }, (_unused, i) => `${prefix}${i}`);

/** A deterministic shuffle, so a failure reproduces. */
const shuffled = (items: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out = [...items];
  let seed = 0x2f6e2b1;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  return out;
};

describe('segmented distinct key set — growth', () => {
  it('still finds every key added before a doubling, after it', () => {
    const set = createSegmentedDistinctKeySet({ maxBytes: 64 * MIB, initialDistinctKeys: 1_000 });
    const firstBytes = set.stats().bytesReserved;
    const all = keys(10_000);
    expect(all.map(key => set.add(key)).every(outcome => outcome === 'added')).toBe(true);

    // 1,000 + 2,000 + 4,000 + 8,000: four tables hold the ten thousand
    expect(set.stats().bytesReserved).toBeGreaterThan(firstBytes);
    expect(set.stats().recorded).toBe(10_000);
    expect(set.isSaturated()).toBe(false);
    expect(all.every(key => set.has(key))).toBe(true);
    expect(all.map(key => set.add(key)).every(outcome => outcome === 'present')).toBe(true);
    expect(set.stats().recorded).toBe(10_000);
    expect(keys(1_000, 'absent').some(key => set.has(key))).toBe(false);
  });

  it('records the same number whatever order the keys arrive in', () => {
    // 32-bit, so some of the 300,000 keys collide: the order must not decide which collisions count.
    const all = keys(300_000);
    const recordedIn = (order: ReadonlyArray<string>): number => {
      const set = createSegmentedDistinctKeySet({ maxBytes: 64 * MIB, initialDistinctKeys: 10_000, hashBits: 32 });
      for (const key of order) set.add(key);
      expect(set.isSaturated()).toBe(false);
      return set.stats().recorded;
    };
    const forward = recordedIn(all);
    expect(forward).toBeLessThanOrEqual(all.length);
    expect(forward).toBeGreaterThan(all.length * 0.99);
    expect(recordedIn([...all].reverse())).toBe(forward);
    expect(recordedIn(shuffled(all))).toBe(forward);
  });

  it('reserves memory as it is used, not for the ceiling', () => {
    const set = createSegmentedDistinctKeySet({ maxBytes: 1024 * MIB });
    for (const key of keys(1_000)) set.add(key);
    expect(set.stats().bytesReserved).toBe(bytesForDistinctKeys(DEFAULT_INITIAL_DISTINCT_KEYS, 64));
    expect(set.stats().bytesReserved).toBeLessThan(16 * MIB);
  });
});

describe('segmented distinct key set — only the ceiling saturates', () => {
  // Room for the first table (1,000 keys) and the second (2,000), not the third (4,000).
  const ceiling = bytesForDistinctKeys(1_000, 64) + bytesForDistinctKeys(2_000, 64);
  const full = () => {
    const set = createSegmentedDistinctKeySet({ maxBytes: ceiling, initialDistinctKeys: 1_000 });
    const outcomes = keys(5_000).map(key => set.add(key));
    return { set, outcomes };
  };

  it('does not saturate when a table fills and another fits', () => {
    const set = createSegmentedDistinctKeySet({ maxBytes: ceiling, initialDistinctKeys: 1_000 });
    const outcomes = keys(1_500).map(key => set.add(key));
    expect(outcomes.every(outcome => outcome === 'added')).toBe(true);
    expect(set.isSaturated()).toBe(false);
    expect(set.has('never-added')).toBe(false);
  });

  it('refuses at the ceiling, counts what it refused, and never reserves past the ceiling', () => {
    const { set, outcomes } = full();
    const added = outcomes.filter(outcome => outcome === 'added').length;
    const refused = outcomes.filter(outcome => outcome === 'refused').length;
    expect(added).toBe(set.stats().capacity);
    expect(added + refused).toBe(5_000);
    expect(refused).toBeGreaterThan(0);
    expect(set.stats().refused).toBe(refused);
    expect(set.stats().recorded).toBe(added);
    expect(set.stats().saturated).toBe(true);
    expect(set.stats().bytesReserved).toBeLessThanOrEqual(ceiling);
    expect(set.add('one-more')).toBe('refused');
  });

  it('answers "seen" for every key once saturated, including one it never saw', () => {
    const { set } = full();
    expect(set.isSaturated()).toBe(true);
    expect(set.has('never-added')).toBe(true);
    // a key it does hold still reads as present, not refused
    expect(set.add('k0')).toBe('present');
  });

  it('sizes its one table down to a ceiling smaller than the first table, and saturates there', () => {
    const set = createSegmentedDistinctKeySet({ maxBytes: 64 });
    const outcomes = keys(20).map(key => set.add(key));
    expect(set.stats().bytesReserved).toBeLessThanOrEqual(64);
    expect(outcomes.filter(outcome => outcome === 'added').length).toBe(set.stats().capacity);
    expect(outcomes.at(-1)).toBe('refused');
    expect(set.has('never-added')).toBe(true);
  });
});
