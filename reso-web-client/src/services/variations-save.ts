/**
 * Variations Save — builds the payload from draft actions and comments,
 * computes change integrity, and saves to the service.
 *
 * Also handles notification polling for variations report updates.
 */

import {
  saveVariationsReport,
  generateCertRequestId,
  type VariationsReportPayload,
  type VariationsEditorInfo,
  type VariationsChange,
} from './variations-service';

// ── Types ────────────────────────────────────────────────────────────

type ActionStatus = 'pending' | 'ignored' | 'fast-track' | 'remove';

interface DraftAction {
  readonly key: string;
  readonly status: ActionStatus;
}

interface DraftComment {
  readonly variationKey: string;
  readonly timestamp: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly attachments?: ReadonlyArray<{ readonly displayText: string; readonly url: string }>;
}

interface SaveInput {
  readonly version: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly actions: ReadonlyArray<DraftAction>;
  readonly comments: ReadonlyArray<DraftComment>;
  readonly userName: string;
  readonly userEmail: string;
  /**
   * Admin-only finalize flag. When true, the backend flips the
   * endorsement to 'resolved' and notifies the provider. Pending
   * action/comment deltas are saved in the same call.
   */
  readonly finalize?: boolean;
}

// ── Key parsing ──────────────────────────────────────────────────────

/**
 * Parse a variation key back into its component parts.
 *
 * Splits on the first two `:` only — anything past the second `:`
 * is the lookup value. Lookup values can legitimately contain `:`
 * (some RESO standards do), so naive split-on-all would corrupt
 * them. Mirrors the backend's `parseVariationKey` semantics.
 */
const parseKey = (key: string): { resourceName: string; fieldName?: string; lookupValue?: string } => {
  const firstColon = key.indexOf(':');
  if (firstColon === -1) return { resourceName: key };
  const secondColon = key.indexOf(':', firstColon + 1);
  if (secondColon === -1) {
    return {
      resourceName: key.slice(0, firstColon),
      fieldName: key.slice(firstColon + 1) || undefined,
    };
  }
  return {
    resourceName: key.slice(0, firstColon),
    fieldName: key.slice(firstColon + 1, secondColon) || undefined,
    lookupValue: key.slice(secondColon + 1) || undefined,
  };
};

// ── Build payload ────────────────────────────────────────────────────

/** Build the save payload from draft actions and comments. */
const buildSavePayload = (input: SaveInput): {
  changes: ReadonlyArray<VariationsChange>;
  editorInfo: VariationsEditorInfo;
} => {
  const changes: VariationsChange[] = [];

  // Convert draft actions to changes
  for (const action of input.actions) {
    const { resourceName, fieldName, lookupValue } = parseKey(action.key);

    const change: Record<string, unknown> = { resourceName };
    if (fieldName) change.fieldName = fieldName;
    if (lookupValue) change.lookupValue = lookupValue;

    if (action.status === 'ignored') {
      change.ignore = true;
      change.flaggedForFastTrack = false;
    } else if (action.status === 'fast-track') {
      change.flaggedForFastTrack = true;
      change.ignore = false;
    } else if (action.status === 'remove') {
      change.remove = true;
    }

    // Attach any comments for this variation
    const relatedComments = input.comments.filter(c => c.variationKey === action.key);
    if (relatedComments.length > 0) {
      change.conversations = relatedComments.map(c => ({
        timestamp: c.timestamp,
        from: c.from,
        to: c.to,
        message: c.message,
        ...(c.attachments ? { attachments: c.attachments } : {}),
      }));
    }

    changes.push(change as unknown as VariationsChange);
  }

  // Add comments that aren't attached to an action
  const actionKeys = new Set(input.actions.map(a => a.key));
  const standaloneComments = input.comments.filter(c => !actionKeys.has(c.variationKey));

  for (const comment of standaloneComments) {
    const { resourceName, fieldName, lookupValue } = parseKey(comment.variationKey);
    changes.push({
      resourceName,
      fieldName,
      lookupValue,
      conversations: [{
        timestamp: comment.timestamp,
        from: comment.from,
        to: comment.to,
        message: comment.message,
        ...(comment.attachments ? { attachments: comment.attachments } : {}),
      }],
    } as VariationsChange);
  }

  const editorInfo: VariationsEditorInfo = {
    displayName: input.userName,
    editedOn: new Date().toISOString(),
    email: input.userEmail,
    providerUoi: input.providerUoi,
    username: input.userName,
  };

  return { changes, editorInfo };
};

// ── Save ─────────────────────────────────────────────────────────────

/**
 * Save the variations report with draft actions and comments.
 *
 * Sends only the new deltas — the backend reads the existing report
 * from S3, merges past changes + new changes, computes the changeId,
 * and writes the merged shape back. The frontend no longer fetches
 * or merges history.
 *
 * 1. Generate cert request ID
 * 2. Build new changes (untagged — backend tags them with a computed
 *    changeId)
 * 3. POST deltas
 *
 * On success the backend returns 200 with the persisted data; 304
 * means the same payload was already saved (idempotent re-submit),
 * treated as success here since the server-side state matches what we
 * intended to write.
 */
export const saveVariationsReview = async (input: SaveInput): Promise<boolean> => {
  const certRequestId = await generateCertRequestId(input.version, input.providerUoi, input.providerUsi, input.recipientUoi);

  const { changes: newChanges, editorInfo } = buildSavePayload(input);

  // Finalize is allowed with zero new changes — admin closing out a
  // review that has no further edits should still flip the
  // endorsement to 'resolved' and fire the resolved notification.
  if (newChanges.length === 0 && !input.finalize) return false;

  const payload: VariationsReportPayload = {
    description: 'RESO Data Dictionary Change Log',
    version: input.version,
    certificationRequestId: certRequestId,
    providerUoi: input.providerUoi,
    providerUsi: input.providerUsi,
    recipientUoi: input.recipientUoi,
    changes: newChanges,
    editorInfo: [editorInfo],
    ...(input.finalize ? { finalize: true } : {}),
  };

  return saveVariationsReport(input.version, input.providerUoi, input.providerUsi, input.recipientUoi, certRequestId, payload);
};
