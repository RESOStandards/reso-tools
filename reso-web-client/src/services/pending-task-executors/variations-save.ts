/**
 * Executor for the 'variations-save' pending-task type.
 *
 * The renderer enqueues a task with a SaveVariationsPayload; the
 * executor runs in the background and calls saveVariationsReview
 * against the services API. On success/failure the queue updates
 * task status so the UI can flash the result.
 *
 * Must be idempotent — the queue may re-fire a task that completed
 * server-side without the client seeing the response (e.g. on app
 * relaunch with an unresolved 'in-flight' row). The server-side
 * save path is already keyed by certificationRequestId and tagged
 * by changeId, so re-submitting the same payload is safe.
 */

import { saveVariationsReview } from '../variations-save.js';
import { registerExecutor } from '../pending-tasks.js';

export const VARIATIONS_SAVE_TASK_TYPE = 'variations-save';

/**
 * Payload schema for the executor. Mirrors saveVariationsReview's
 * SaveInput shape — duplicated here so the queue payload stays
 * stable as a JSON blob even if the SaveInput type evolves.
 */
export interface VariationsSavePayload {
  readonly version: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly actions: ReadonlyArray<{ readonly key: string; readonly status: 'pending' | 'ignored' | 'fast-track' | 'remove' }>;
  readonly comments: ReadonlyArray<{ readonly variationKey: string; readonly from: string; readonly to: string; readonly message: string; readonly timestamp: string; readonly attachments?: ReadonlyArray<{ readonly displayText: string; readonly url: string }> }>;
  readonly userName: string;
  readonly userEmail: string;
  readonly finalize?: boolean;
}

const isPayload = (value: unknown): value is VariationsSavePayload => {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.version === 'string'
    && typeof o.providerUoi === 'string'
    && typeof o.providerUsi === 'string'
    && typeof o.recipientUoi === 'string'
    && Array.isArray(o.actions)
    && Array.isArray(o.comments);
};

const execute = async (payload: unknown): Promise<void> => {
  if (!isPayload(payload)) {
    throw new Error('variations-save: invalid payload shape');
  }
  const success = await saveVariationsReview(payload);
  if (!success) {
    throw new Error('variations-save: server returned non-success');
  }
};

/** Register at module load — call from app entry once. */
export const registerVariationsSaveExecutor = (): void => {
  registerExecutor(VARIATIONS_SAVE_TASK_TYPE, execute);
};
