import type { AddOutcome, DistinctKeySet, DistinctKeySetOptions, DistinctKeySetStats } from './distinct-key-set.js';

/**
 * ArrayBuffer-backed open-addressed implementation of {@link DistinctKeySet}.
 *
 * One `Uint32Array`. Each slot is two consecutive words holding the halves of a 64-bit hash, or one
 * word at 32-bit width. Both words zero means empty, which is why the table needs no initialization
 * pass and no occupancy bitmap. Linear probing, step 1.
 *
 * Four things not to change without reading the registry reference first:
 *
 *   1. `Math.imul` for every multiply. A plain `*` overflows the 53-bit mantissa and silently drops
 *      the low bits, which are the ones that mix.
 *   2. The two accumulators use different seeds, multipliers and rotations. If one became a function
 *      of the other, the output would be 64 bits wide carrying 32 bits of entropy.
 *   3. Slot count is exact, not rounded to a power of two.
 *   4. No growth, no deletion, no iteration, no stored values. Saturating is the designed response
 *      to running out.
 *
 * See the registry reference `references/deduplication.md` for the reasoning.
 */

/** Slots hold two 32-bit words. Both zero means empty, so the table is zero-initialized for free. */
const WORDS_PER_SLOT_64 = 2;
const WORDS_PER_SLOT_32 = 1;

/**
 * Open addressing degrades sharply as a table fills: probe length grows as roughly 1/(1-load), so
 * 0.7 costs about three probes in the worst case while 0.9 costs ten. 0.7 is the usual engineering
 * point and it is what the capacity arithmetic in the contract documentation assumes.
 */
const TARGET_LOAD_FACTOR = 0.7;

/** 2^24, the point a single V8 Map gives up. The floor for "at least beat what this replaces". */
const DEFAULT_TARGET_DISTINCT_KEYS = 1 << 24;

/**
 * Default ceiling: 64 MiB, an absolute number rather than a fraction of system memory.
 *
 * A fraction looks adaptive and is wrong, because an instance cannot know how many siblings exist.
 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Two independent 32-bit hashes of a string, returned as a pair.
 *
 * A murmur3-style multiply-rotate-xor mix per character, run twice with different seeds and
 * different constants so the two words are not correlated - concatenating one hash with a rotation
 * of itself would give 64 bits of width over 32 bits of entropy, and the collision rate would stay
 * that of the narrower hash while the memory cost doubled.
 */
const hashPair = (key: string): readonly [number, number] => {
  // Local mutable state inside a closure: scoped to this call and never leaked.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0xcc9e2d51);
    h1 = (h1 << 15) | (h1 >>> 17);
    h2 = Math.imul(h2 ^ c, 0x1b873593);
    h2 = (h2 << 13) | (h2 >>> 19);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h1 = (h1 ^ (h1 >>> 13)) >>> 0;
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35);
  h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  return [h1, h2];
};

/**
 * Create a distinct-key set backed by one ArrayBuffer.
 *
 * Sizing is EXACT: slots = ceil(targetDistinctKeys / 0.7), capped to fit `maxBytes`. Not rounded up
 * to a power of two.
 */
export const createBufferDistinctKeySet = (options: DistinctKeySetOptions = {}): DistinctKeySet => {
  const hashBits = options.hashBits ?? 64;
  const wordsPerSlot = hashBits === 64 ? WORDS_PER_SLOT_64 : WORDS_PER_SLOT_32;
  const target = Math.max(1, options.targetDistinctKeys ?? DEFAULT_TARGET_DISTINCT_KEYS);
  const maxBytes = Math.max(wordsPerSlot * 4, options.maxBytes ?? DEFAULT_MAX_BYTES);

  const wantedSlots = Math.ceil(target / TARGET_LOAD_FACTOR);
  const affordableSlots = Math.max(1, Math.floor(maxBytes / (wordsPerSlot * 4)));
  const slots = Math.min(wantedSlots, affordableSlots);
  // At least one, so a degenerately small budget saturates on the first add rather than reporting a
  // capacity of zero and a load factor that divides by it.
  const maxRecorded = Math.max(1, Math.floor(slots * TARGET_LOAD_FACTOR));

  const words = new Uint32Array(new ArrayBuffer(slots * wordsPerSlot * 4));
  const bytesReserved = words.byteLength;

  // Counters. Mutable, closure-scoped, never exposed except through `stats`.
  let recorded = 0;
  let refused = 0;

  /**
   * Both words zero marks an empty slot, so a key whose hash is all zeros would be invisible.
   * Forcing it to 1 makes that one key collide with the key that genuinely hashes to 1 - a single
   * collision in 2^64, which undercounts, which is the safe direction. The alternative is a
   * parallel occupancy bitmap for one key in eighteen quintillion.
   */
  const nonZero = (lo: number, hi: number): readonly [number, number] => (lo === 0 && hi === 0 ? [1, 0] : [lo, hi]);

  /** Slot index, or -1 when absent. Pure. */
  const find = (lo: number, hi: number): number => {
    let i = lo % slots;
    for (let probe = 0; probe < slots; probe++) {
      const at = i * wordsPerSlot;
      const sLo = words[at] as number;
      const sHi = wordsPerSlot === 2 ? (words[at + 1] as number) : 0;
      if (sLo === 0 && sHi === 0) return -1;
      if (sLo === lo && sHi === hi) return i;
      i = i + 1 === slots ? 0 : i + 1;
    }
    return -1;
  };

  const isSaturated = (): boolean => recorded >= maxRecorded;

  const has = (key: string): boolean => {
    // Saturated means "cannot rule anything out", and the contract says that reads as membership.
    // Returning false here would let a caller count the same record on every sighting, which is the
    // one direction that must never happen.
    if (isSaturated()) return true;
    const [h1, h2] = hashPair(key);
    const [lo, hi] = wordsPerSlot === 2 ? nonZero(h1, h2) : nonZero(h1, 0);
    return find(lo, hi) !== -1;
  };

  const add = (key: string): AddOutcome => {
    const [h1, h2] = hashPair(key);
    const [lo, hi] = wordsPerSlot === 2 ? nonZero(h1, h2) : nonZero(h1, 0);
    if (find(lo, hi) !== -1) return 'present';
    if (recorded >= maxRecorded) {
      refused++;
      return 'refused';
    }
    let i = lo % slots;
    for (let probe = 0; probe < slots; probe++) {
      const at = i * wordsPerSlot;
      if ((words[at] as number) === 0 && (wordsPerSlot === 1 || (words[at + 1] as number) === 0)) {
        words[at] = lo;
        if (wordsPerSlot === 2) words[at + 1] = hi;
        recorded++;
        return 'added';
      }
      i = i + 1 === slots ? 0 : i + 1;
    }
    // Unreachable while recorded < maxRecorded < slots, but a silent wrong answer here would be a
    // phantom duplicate, so it refuses rather than falling through.
    refused++;
    return 'refused';
  };

  const stats = (): DistinctKeySetStats => ({
    recorded,
    capacity: maxRecorded,
    loadFactor: maxRecorded === 0 ? 1 : recorded / maxRecorded,
    bytesReserved,
    hashBits,
    saturated: isSaturated(),
    refused
  });

  return Object.freeze({ has, add, stats, isSaturated });
};
