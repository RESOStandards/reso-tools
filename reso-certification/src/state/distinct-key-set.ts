/**
 * Contract for a set that answers "have I seen this key" over a population too large for a JS Map.
 *
 * Two invariants a caller depends on, and which an implementation must not relax:
 *
 *   1. `has` is PURE. It never records. Two consumers can therefore share one set without the first
 *      starving the second.
 *   2. Once saturated, `has` reports membership for EVERY key. An exhausted set returning false
 *      would let a caller count the same key on every sighting, and the resulting total would
 *      exceed reality. Reporting membership keeps the error in the other direction.
 *
 * `isSaturated` exists so a caller needing exact membership can detect the condition and refuse
 * rather than silently receive the approximation.
 *
 * See the registry reference `references/deduplication.md` for the reasoning.
 */

/** What `add` did, so a caller can act on it rather than inferring from a later `has`. */
export type AddOutcome =
  /** The key was not present and is now tracked. */
  | 'added'
  /** The key was already tracked. For a dedup caller this means "skip the work". */
  | 'present'
  /**
   * The set is saturated and the key was not recorded. `has` will now report true for every key,
   * including this one, which keeps the error in the undercounting direction. A caller that cannot
   * tolerate that should be checking `isSaturated` and refusing.
   */
  | 'refused';

/** Occupancy, for a caller that wants to log or alarm before saturation rather than after. */
export interface DistinctKeySetStats {
  /**
   * Distinct hashes recorded. A LOWER BOUND on distinct keys, never an upper one: a truncated hash
   * means two distinct keys can share a slot, and the second is not recorded. Do not report this as
   * a distinct-key count without saying it is a floor.
   */
  readonly recorded: number;
  /** Slots available. Fixed at construction; this set never grows, so capacity is a promise. */
  readonly capacity: number;
  /** `recorded / capacity`, 0 to 1. */
  readonly loadFactor: number;
  /** Bytes actually reserved, so a caller can account for its own footprint. */
  readonly bytesReserved: number;
  /** Width of the stored hash. Narrower means more keys per byte and more collisions, which undercount. */
  readonly hashBits: number;
  /** True once `add` has started refusing. */
  readonly saturated: boolean;
  /** How many `add` calls were refused. Non-zero means the reported totals are a floor. */
  readonly refused: number;
}

/**
 * The contract.
 *
 * Deliberately narrow. This is membership over opaque keys and nothing else - no iteration, no
 * removal, no values. Iteration over hundreds of millions of keys has no caller, removal breaks the
 * one-directional error guarantee above, and a value would reintroduce the per-entry heap cost this
 * exists to avoid. A caller that needs any of those wants a different structure, not a wider one.
 */
export interface DistinctKeySet {
  /**
   * Has this key been seen?
   *
   * Returns true for every key once saturated - see the header. Pure: calling it never records
   * anything, so two consumers can share one set without the first starving the second. That
   * separation is load-bearing; the legacy service's availability path checks and then marks
   * immediately, and a second consumer reading the same set after it would find everything seen.
   */
  readonly has: (key: string) => boolean;

  /** Record this key. Idempotent. See {@link AddOutcome}. */
  readonly add: (key: string) => AddOutcome;

  /** Occupancy and the honesty flags. */
  readonly stats: () => DistinctKeySetStats;

  /**
   * True once the set can no longer record new keys, after which `has` reports membership for
   * everything. Check this before trusting a count, and before using the set for anything that
   * needs exact membership rather than the undercounting approximation.
   */
  readonly isSaturated: () => boolean;
}

/** How to size it. Every field is optional; the defaults are stated per field. */
export interface DistinctKeySetOptions {
  /**
   * How many distinct keys the caller expects. The set is sized to hold this many at its target
   * load factor, subject to `maxBytes`. Default: 2^24, which is roughly the point a single V8 Map
   * gives up, so the default is "at least do better than the thing this replaces".
   */
  readonly targetDistinctKeys?: number;

  /**
   * Hard ceiling on bytes reserved. The set never exceeds this, even if `targetDistinctKeys` would
   * require more - it sizes down and saturates earlier instead, because saturating is safe and
   * exhausting memory is not.
   */
  readonly maxBytes?: number;

  /**
   * Stored hash width. More bits means fewer collisions and fewer keys per byte. Collisions
   * undercount, so narrowing is a safe trade and widening buys accuracy, not safety. Default: 64.
   */
  readonly hashBits?: 32 | 64;
}
