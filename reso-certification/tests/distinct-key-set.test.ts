import { describe, expect, it } from 'vitest';

import { createBufferDistinctKeySet } from '../src/state/distinct-key-set-buffer.js';

/**
 * Contract tests for the ArrayBuffer-backed distinct-key set.
 *
 * The set exists to answer "have I counted this one already" over a population too large for a V8
 * Map, and every lossy thing it does has to fail by UNDERCOUNTING. Overcounting is the one outcome
 * that can never happen, because certification numbers are what the industry makes decisions on and
 * a provider must never be credited with data they did not serve.
 *
 * So the tests that matter here are the ones that exercise the lossy paths, not the happy path. The
 * saturation block below is the point of this file: a structure that refuses work is easy to write
 * and easy to get backwards, and "returns true for a key it has never seen" is correct behavior
 * that looks exactly like a bug. It is pinned so nobody fixes it.
 */

describe('distinct key set — membership', () => {
  it('reports a key absent until it is added', () => {
    const set = createBufferDistinctKeySet({ targetDistinctKeys: 1_000 });
    expect(set.has('a')).toBe(false);
    expect(set.add('a')).toBe('added');
    expect(set.has('a')).toBe(true);
  });

  it('reports a repeat add as present rather than adding twice', () => {
    const set = createBufferDistinctKeySet({ targetDistinctKeys: 1_000 });
    expect(set.add('a')).toBe('added');
    expect(set.add('a')).toBe('present');
    expect(set.stats().recorded).toBe(1);
  });

  it('keeps distinct keys distinct', () => {
    const set = createBufferDistinctKeySet({ targetDistinctKeys: 1_000 });
    set.add('a');
    expect(set.has('b')).toBe(false);
    expect(set.add('b')).toBe('added');
    expect(set.stats().recorded).toBe(2);
  });

  it('never records anything on a lookup, so two consumers can share one set', () => {
    // This is the property whose ABSENCE rules out reusing the replication state service for error
    // dedup: its availability path checks and marks in the same breath, so a second consumer
    // reading after it finds every record already seen and silently counts nothing.
    const set = createBufferDistinctKeySet({ targetDistinctKeys: 100 });
    set.has('x');
    set.has('x');
    set.has('x');
    expect(set.stats().recorded).toBe(0);
  });
});

describe('distinct key set — saturation fails toward undercounting', () => {
  const tiny = (): ReturnType<typeof createBufferDistinctKeySet> => createBufferDistinctKeySet({ targetDistinctKeys: 8, maxBytes: 64 });

  it('refuses exactly at capacity rather than overwriting or growing', () => {
    const set = tiny();
    const capacity = set.stats().capacity;
    const outcomes = Array.from({ length: capacity + 5 }, (_unused, i) => set.add(`k${i}`));
    expect(outcomes.slice(0, capacity)).toEqual(Array.from({ length: capacity }, () => 'added'));
    expect(outcomes.slice(capacity)).toEqual(Array.from({ length: 5 }, () => 'refused'));
  });

  it('reports membership for a key it has never seen once saturated', () => {
    // Deliberate, and the opposite of what an exhausted container usually means. Returning false
    // would let a caller count the same record on every sighting, and the total would exceed
    // reality. Assuming "seen" undercounts instead. Do not "fix" this.
    const set = tiny();
    const capacity = set.stats().capacity;
    Array.from({ length: capacity }, (_unused, i) => set.add(`k${i}`));
    expect(set.isSaturated()).toBe(true);
    expect(set.has('never-added-anywhere')).toBe(true);
  });

  it('counts its refusals, so a caller can tell a complete total from a floor', () => {
    const set = tiny();
    const capacity = set.stats().capacity;
    Array.from({ length: capacity + 3 }, (_unused, i) => set.add(`k${i}`));
    expect(set.stats().refused).toBeGreaterThan(0);
    expect(set.stats().saturated).toBe(true);
  });
});

describe('distinct key set — sizing and hashing', () => {
  it('honors maxBytes even when the target would need more', () => {
    const set = createBufferDistinctKeySet({ targetDistinctKeys: 10_000_000, maxBytes: 4_096 });
    expect(set.stats().bytesReserved).toBeLessThanOrEqual(4_096);
  });

  it('records a realistic composed-key population without a single false duplicate', () => {
    // The shape error dedup actually uses: class | fieldValueId | recordKey. A false 'present' here
    // would mean a hash collision, which drops a real violation. At 64 bits over this population
    // the expected number of collisions is ~1e-8, so any shortfall indicates a bad mixing function
    // rather than bad luck — the failure mode that looks fine in a small test and breaks at scale.
    const n = 200_000;
    const set = createBufferDistinctKeySet({ targetDistinctKeys: n });
    const outcomes = Array.from({ length: n }, (_unused, i) => set.add(`${i % 8}|${i % 580}|MBR${80_000_000 + i}`));
    expect(outcomes.filter(o => o === 'added')).toHaveLength(n);
    expect(outcomes.filter(o => o !== 'added')).toHaveLength(0);
    expect(set.stats().recorded).toBe(n);
  });

  it('stores a narrower hash when asked, and still dedupes', () => {
    const set = createBufferDistinctKeySet({ targetDistinctKeys: 1_000, hashBits: 32 });
    expect(set.stats().hashBits).toBe(32);
    expect(set.add('a')).toBe('added');
    expect(set.add('a')).toBe('present');
  });

  it('sizes the table exactly, without rounding up to a power of two', () => {
    // The load factor is 0.7, restated here rather than imported: if someone changes it, this test
    // should fail and make them look at the memory consequence, not silently follow along.
    const n = 1_000_000;
    const set = createBufferDistinctKeySet({ targetDistinctKeys: n, maxBytes: 1_000_000_000 });
    const exactSlots = Math.ceil(n / 0.7);
    expect(set.stats().bytesReserved).toBe(exactSlots * 8);

    // A power-of-two table would need 2^21 slots for the same population. Rounding there wastes
    // 31.9% of the allocation, which is the regression this pins.
    expect(set.stats().bytesReserved).toBeLessThan(2 ** 21 * 8);
  });

  it('never exceeds maxBytes, and saturates earlier instead', () => {
    const set = createBufferDistinctKeySet({ targetDistinctKeys: 10_000_000, maxBytes: 8_192 });
    expect(set.stats().bytesReserved).toBeLessThanOrEqual(8_192);
    expect(set.stats().capacity).toBeGreaterThan(0);
  });
});

describe('distinct key set - hash quality canaries', () => {
  // These do not test the hash directly - it is not exported - they test the behavior that a broken
  // hash would destroy. The specific break they are built to catch is using `*` instead of
  // `Math.imul`: JS numbers carry a 53-bit mantissa, so a 32-bit multiply overflowing into a double
  // silently loses the low bits, which are the ones doing the mixing. Measured on 300,000 sequential
  // keys at 32-bit width, that mistake produced 4,333 collisions where the correct multiply produced
  // 13 - a 333x regression that looks fine on a thousand keys.

  const sequential = (n: number): ReadonlyArray<string> =>
    Array.from({ length: n }, (_unused, i) => `MUST be advertised\u0000Property\u0000City\u0000Indianapolis\u0000MBR${80_000_000 + i}`);

  it('keeps near-identical keys apart at 64 bits', () => {
    // Sequential keys differing only in trailing digits are the worst case for a weak mixer.
    const keys = sequential(200_000);
    const set = createBufferDistinctKeySet({ targetDistinctKeys: keys.length });
    const outcomes = keys.map(k => set.add(k));
    expect(outcomes.filter(o => o !== 'added')).toHaveLength(0);
  });

  it('holds collisions near the theoretical floor at 32 bits', () => {
    // n^2/2m predicts ~10 collisions for 300k keys over 2^32. The bound is deliberately loose
    // enough not to be flaky and tight enough to catch a mixing regression two orders of magnitude
    // out; the broken-multiply version lands at 4,333.
    const keys = sequential(300_000);
    const set = createBufferDistinctKeySet({ targetDistinctKeys: keys.length, hashBits: 32 });
    const collisions = keys.map(k => set.add(k)).filter(o => o === 'present').length;
    expect(collisions).toBeLessThan(200);
  });

  it('produces the same total regardless of insertion order', () => {
    // Order independence is what makes the undercount a property of the key set rather than of
    // timing. If a collided key could be counted on a later sighting, the same data would total
    // differently depending on fetch sequence.
    const keys = sequential(150_000);
    const forward = createBufferDistinctKeySet({ targetDistinctKeys: keys.length, hashBits: 32 });
    const reverse = createBufferDistinctKeySet({ targetDistinctKeys: keys.length, hashBits: 32 });
    for (const k of keys) forward.add(k);
    for (const k of [...keys].reverse()) reverse.add(k);
    expect(forward.stats().recorded).toBe(reverse.stats().recorded);
  });

  it('keeps a collided key collided, rather than healing on a later sighting', () => {
    // Find a genuine collision at a narrow width, then re-offer that key. It must stay 'present'.
    const keys = sequential(400_000);
    const set = createBufferDistinctKeySet({ targetDistinctKeys: keys.length, hashBits: 32 });
    const collided = keys.find(k => set.add(k) === 'present');
    if (collided === undefined) {
      // No collision occurred at this population, so there is nothing to assert. Say so rather than
      // passing silently on a test that exercised nothing.
      expect(set.stats().recorded).toBe(keys.length);
      return;
    }
    expect(set.add(collided)).toBe('present');
    expect(set.add(collided)).toBe('present');
  });
});
