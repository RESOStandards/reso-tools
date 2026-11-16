import { createSegmentedDistinctKeySet } from './distinct-key-set-segmented.js';
import type { DistinctKeySet } from './distinct-key-set.js';

/**
 * The set a replication run uses to count each record once.
 *
 * The caller that owns the run creates it and hands it to the run's replication state
 * (`createReplicationStateServiceInstance({ recordKeySet })`); the state never builds one, because how much memory a
 * run may take is not something the state can know.
 */

/**
 * The default ceiling on the set's memory: 1 GiB, room for at least 47 million records. The set reserves memory as
 * it fills (about 12 MiB to start), so a small run does not pay for the ceiling.
 *
 * It is an absolute number on purpose. A caller that owns a whole container can raise it; a caller running several
 * runs on one machine should divide its own budget between them.
 */
export const DEFAULT_RECORD_DEDUPLICATION_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Create the record set for one run. `maxBytes` is the ceiling on its memory; when the run reaches it, records the
 * set cannot place are skipped and the availability report marks its totals as a floor.
 */
export const createRecordKeySet = (maxBytes: number = DEFAULT_RECORD_DEDUPLICATION_MAX_BYTES): DistinctKeySet => {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`The record deduplication ceiling must be a positive number of bytes; received ${String(maxBytes)}.`);
  }
  return createSegmentedDistinctKeySet({ maxBytes });
};
