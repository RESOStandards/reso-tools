import type { AddEditCleanup } from '../test-runner/types.js';

/** "record" or "records", for a count. */
const records = (count: number): string => `${count} record${count === 1 ? '' : 's'}`;

/**
 * What became of the records the run created, in a clause for the step's summary: counts and keys, since the step
 * reaches the provider's own output. Empty when the run created nothing.
 */
export const describeCleanup = (cleanup: AddEditCleanup): string => {
  const sentences = [
    ...(cleanup.removed.length > 0 ? [`Removed the ${records(cleanup.removed.length)} it created.`] : []),
    ...(cleanup.notRemoved.length > 0
      ? [`Could not remove ${cleanup.notRemoved.map(({ key, status }) => `${key} (${status})`).join(', ')}.`]
      : []),
    ...(cleanup.left.length > 0
      ? [`Left ${records(cleanup.left.length)} it created, because delete was not tested: ${cleanup.left.join(', ')}.`]
      : [])
  ];
  return sentences.length > 0 ? `. ${sentences.join(' ')}` : '';
};
