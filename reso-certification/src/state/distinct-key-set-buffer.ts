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
export const hashPair = (key: string): readonly [number, number] => {
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
 * Both words zero marks an empty slot, so a key whose hash is all zeros would be invisible.
 * Forcing it to 1 makes that one key collide with the key that genuinely hashes to 1 - a single
 * collision in 2^64, which undercounts, which is the safe direction. The alternative is a
 * parallel occupancy bitmap for one key in eighteen quintillion.
 */
const nonZero = (lo: number, hi: number): readonly [number, number] => (lo === 0 && hi === 0 ? [1, 0] : [lo, hi]);

/**
 * The words a table stores for a key, from the key's one hash. Exported so a set made of several
 * tables hashes a key once and asks each table about the same words.
 */
export const storedHashOf = (key: string, hashBits: 32 | 64): readonly [number, number] => {
  const [h1, h2] = hashPair(key);
  return hashBits === 64 ? nonZero(h1, h2) : nonZero(h1, 0);
};

/**
 * One open-addressed table over stored hashes, with no opinion about saturation: it reports when it
 * is full and refuses an insert then, and what "full" means to a caller is the caller's decision.
 * {@link createBufferDistinctKeySet} is one table with the saturation contract on top; the segmented
 * set is several.
 */
export interface HashTable {
  /** Is this stored hash in the table? Pure. */
  readonly contains: (lo: number, hi: number) => boolean;
  /** Record a stored hash that is NOT already in the table. False when the table is full. */
  readonly insert: (lo: number, hi: number) => boolean;
  /** True once the table holds as many hashes as its load factor allows. */
  readonly isFull: () => boolean;
  readonly recorded: () => number;
  /** How many hashes the table holds at its load factor. Fixed at construction. */
  readonly capacity: number;
  readonly bytesReserved: number;
}

/** How many bytes a table for this many keys reserves, before any ceiling is applied. */
export const bytesForDistinctKeys = (targetDistinctKeys: number, hashBits: 32 | 64): number =>
  Math.ceil(Math.max(1, targetDistinctKeys) / TARGET_LOAD_FACTOR) * (hashBits === 64 ? WORDS_PER_SLOT_64 : WORDS_PER_SLOT_32) * 4;

/**
 * Create one table backed by one ArrayBuffer.
 *
 * Sizing is EXACT: slots = ceil(targetDistinctKeys / 0.7), capped to fit `maxBytes`. Not rounded up
 * to a power of two.
 */
export const createHashTable = (targetDistinctKeys: number, maxBytes: number, hashBits: 32 | 64): HashTable => {
  const wordsPerSlot = hashBits === 64 ? WORDS_PER_SLOT_64 : WORDS_PER_SLOT_32;
  const target = Math.max(1, targetDistinctKeys);
  const ceiling = Math.max(wordsPerSlot * 4, maxBytes);

  const wantedSlots = Math.ceil(target / TARGET_LOAD_FACTOR);
  const affordableSlots = Math.max(1, Math.floor(ceiling / (wordsPerSlot * 4)));
  const slots = Math.min(wantedSlots, affordableSlots);
  // At least one, so a degenerately small budget saturates on the first add rather than reporting a
  // capacity of zero and a load factor that divides by it.
  const maxRecorded = Math.max(1, Math.floor(slots * TARGET_LOAD_FACTOR));

  const words = new Uint32Array(new ArrayBuffer(slots * wordsPerSlot * 4));

  // Mutable, closure-scoped, never exposed except through `recorded`.
  let recorded = 0;

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

  const isFull = (): boolean => recorded >= maxRecorded;

  const insert = (lo: number, hi: number): boolean => {
    if (isFull()) return false;
    let i = lo % slots;
    for (let probe = 0; probe < slots; probe++) {
      const at = i * wordsPerSlot;
      if ((words[at] as number) === 0 && (wordsPerSlot === 1 || (words[at + 1] as number) === 0)) {
        words[at] = lo;
        if (wordsPerSlot === 2) words[at + 1] = hi;
        recorded++;
        return true;
      }
      i = i + 1 === slots ? 0 : i + 1;
    }
    // Unreachable while recorded < maxRecorded < slots, but a silent wrong answer here would be a
    // phantom duplicate, so it refuses rather than falling through.
    return false;
  };

  return Object.freeze({
    contains: (lo: number, hi: number): boolean => find(lo, hi) !== -1,
    insert,
    isFull,
    recorded: (): number => recorded,
    capacity: maxRecorded,
    bytesReserved: words.byteLength
  });
};

/**
 * Create a distinct-key set backed by one ArrayBuffer: one table, which saturates when it is full.
 */
export const createBufferDistinctKeySet = (options: DistinctKeySetOptions = {}): DistinctKeySet => {
  const hashBits = options.hashBits ?? 64;
  const table = createHashTable(
    options.targetDistinctKeys ?? DEFAULT_TARGET_DISTINCT_KEYS,
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    hashBits
  );

  // Mutable, closure-scoped, never exposed except through `stats`.
  let refused = 0;

  const isSaturated = (): boolean => table.isFull();

  const has = (key: string): boolean => {
    // Saturated means "cannot rule anything out", and the contract says that reads as membership.
    // Returning false here would let a caller count the same record on every sighting, which is the
    // one direction that must never happen.
    if (isSaturated()) return true;
    const [lo, hi] = storedHashOf(key, hashBits);
    return table.contains(lo, hi);
  };

  const add = (key: string): AddOutcome => {
    const [lo, hi] = storedHashOf(key, hashBits);
    if (table.contains(lo, hi)) return 'present';
    if (table.insert(lo, hi)) return 'added';
    refused++;
    return 'refused';
  };

  const stats = (): DistinctKeySetStats => ({
    recorded: table.recorded(),
    capacity: table.capacity,
    loadFactor: table.capacity === 0 ? 1 : table.recorded() / table.capacity,
    bytesReserved: table.bytesReserved,
    hashBits,
    saturated: isSaturated(),
    refused
  });

  return Object.freeze({ has, add, stats, isSaturated });
};
