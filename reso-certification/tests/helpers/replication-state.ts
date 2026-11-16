// @ts-expect-error — legacy CJS, no type declarations
import certUtilsCommon from '../../src/legacy/common.js';
import type { DistinctKeySet } from '../../src/state/distinct-key-set.js';
import { createRecordKeySet } from '../../src/state/record-key-set.js';

const { createReplicationStateServiceInstance } = certUtilsCommon as {
  createReplicationStateServiceInstance: (options: { readonly recordKeySet: DistinctKeySet }) => unknown;
};

/**
 * One run's replication state for a test, with the record set a run is given. The state does not build its own set,
 * so a test that calls the legacy `replicate()` or `scorePayload` directly creates the state here, as `dd.ts` and
 * the replicate command do for a real run.
 */
export const newReplicationState = <T = unknown>(): T => createReplicationStateServiceInstance({ recordKeySet: createRecordKeySet() }) as T;
