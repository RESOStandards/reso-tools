import { bytesForDistinctKeys, createHashTable, storedHashOf } from './distinct-key-set-buffer.js';
import type { HashTable } from './distinct-key-set-buffer.js';
import type { AddOutcome, DistinctKeySet, DistinctKeySetStats } from './distinct-key-set.js';

/**
 * A {@link DistinctKeySet} whose memory follows its use.
 *
 * The single-table set is sized once. Sized for the largest run it may meet, it commits most of that
 * memory on a small run too: probing scatters keys uniformly, so nearly every key touches a fresh
 * page until every page is touched. Sized for a small run, it saturates on a large one and turns a
 * counted figure into a floor.
 *
 * This set is a list of tables. It starts with one small table, and when the newest table fills it
 * adds another twice the size, until adding the next would take it past a ceiling given in bytes. A
 * key is hashed once and every table is asked about the same stored hash; a new key goes into the
 * newest table. An existing table is never rehashed or moved, so a key recorded before a doubling is
 * found after it.
 *
 * Only the ceiling saturates. When the newest table is full and the next would cross the ceiling,
 * the contract of {@link DistinctKeySet} holds as it does for one table: `has` is true for every key
 * and `add` returns `'refused'`. The error stays in the undercounting direction.
 *
 * The ceiling is absolute, never a fraction of the machine's memory: an instance cannot know how
 * many sibling runs share the machine. See the registry reference `references/deduplication.md`.
 */

/** The first table holds this many keys: 2^20, about 12 MiB at 64-bit. */
export const DEFAULT_INITIAL_DISTINCT_KEYS = 1 << 20;

export interface SegmentedDistinctKeySetOptions {
  /** Hard ceiling on the bytes reserved by all tables together. Required: the owner of the run decides it. */
  readonly maxBytes: number;
  /** How many keys the first table holds. Each later table holds twice the one before. Default 2^20. */
  readonly initialDistinctKeys?: number;
  /** Stored hash width. Default 64. */
  readonly hashBits?: 32 | 64;
}

export const createSegmentedDistinctKeySet = (options: SegmentedDistinctKeySetOptions): DistinctKeySet => {
  const hashBits = options.hashBits ?? 64;
  const { maxBytes } = options;
  const initialDistinctKeys = Math.max(1, options.initialDistinctKeys ?? DEFAULT_INITIAL_DISTINCT_KEYS);

  // The first table is sized down to the ceiling when the ceiling is smaller than it, so a set always
  // has one table and a tiny budget saturates early instead of failing.
  const segments: HashTable[] = [createHashTable(initialDistinctKeys, maxBytes, hashBits)];

  // Mutable, closure-scoped, never exposed except through `stats`.
  let newestDistinctKeys = initialDistinctKeys;
  let refused = 0;

  const newest = (): HashTable => segments[segments.length - 1] as HashTable;
  const bytesReserved = (): number => segments.reduce((total, segment) => total + segment.bytesReserved, 0);

  /** Whether a table twice the newest one's size still fits under the ceiling. */
  const canGrow = (): boolean => bytesReserved() + bytesForDistinctKeys(newestDistinctKeys * 2, hashBits) <= maxBytes;

  const isSaturated = (): boolean => newest().isFull() && !canGrow();

  const contains = (lo: number, hi: number): boolean => segments.some(segment => segment.contains(lo, hi));

  const has = (key: string): boolean => {
    // Saturated means "cannot rule anything out", which the contract says reads as membership.
    if (isSaturated()) return true;
    const [lo, hi] = storedHashOf(key, hashBits);
    return contains(lo, hi);
  };

  const add = (key: string): AddOutcome => {
    const [lo, hi] = storedHashOf(key, hashBits);
    if (contains(lo, hi)) return 'present';
    if (newest().isFull()) {
      if (!canGrow()) {
        refused++;
        return 'refused';
      }
      newestDistinctKeys *= 2;
      segments.push(createHashTable(newestDistinctKeys, bytesForDistinctKeys(newestDistinctKeys, hashBits), hashBits));
    }
    if (newest().insert(lo, hi)) return 'added';
    // Unreachable: the newest table was just checked or just created. Refusing keeps a fault here an undercount.
    refused++;
    return 'refused';
  };

  const stats = (): DistinctKeySetStats => {
    const recorded = segments.reduce((total, segment) => total + segment.recorded(), 0);
    // What the tables reserved so far can hold. Unlike the single table's, it rises as the set grows.
    const capacity = segments.reduce((total, segment) => total + segment.capacity, 0);
    return {
      recorded,
      capacity,
      loadFactor: capacity === 0 ? 1 : recorded / capacity,
      bytesReserved: bytesReserved(),
      hashBits,
      saturated: isSaturated(),
      refused
    };
  };

  return Object.freeze({ has, add, stats, isSaturated });
};
