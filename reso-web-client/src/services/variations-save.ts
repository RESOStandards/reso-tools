/**
 * Variations Save — builds the payload from draft actions and comments,
 * computes change integrity, and saves to the service.
 *
 * Also handles notification polling for variations report updates.
 */

import {
  saveVariationsReport,
  getVariationsReport,
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
}

// ── Key parsing ──────────────────────────────────────────────────────

/** Parse a variation key back into its component parts. */
const parseKey = (key: string): { resourceName: string; fieldName?: string; lookupValue?: string } => {
  const parts = key.split(':');
  return {
    resourceName: parts[0],
    fieldName: parts[1] || undefined,
    lookupValue: parts[2] || undefined,
  };
};

// ── Change ID computation ────────────────────────────────────────────

/** Compute a SHA-256 changeId for a set of changes + editor info. */
const computeChangeId = async (changes: ReadonlyArray<unknown>, editorInfo: Record<string, unknown>): Promise<string> => {
  const input = JSON.stringify([changes, editorInfo]);
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  // Use SHA-256 (compatible with Electron's BoringSSL)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 15);
};

// ── Build payload ────────────────────────────────────────────────────

/** Build the save payload from draft actions and comments. */
const buildSavePayload = (input: SaveInput, _existingReport: VariationsReportPayload | null, _certRequestId: string): {
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
 * 1. Generate cert request ID
 * 2. Fetch existing report (if any)
 * 3. Build new changes
 * 4. Compute changeId
 * 5. POST to service
 */
export const saveVariationsReview = async (input: SaveInput): Promise<boolean> => {
  const certRequestId = await generateCertRequestId(input.version, input.providerUoi, input.providerUsi, input.recipientUoi);

  // Fetch existing report
  const existingReport = await getVariationsReport(input.version, input.providerUoi, input.providerUsi, input.recipientUoi, certRequestId);

  // Build new changes
  const { changes: newChanges, editorInfo } = buildSavePayload(input, existingReport, certRequestId);

  if (newChanges.length === 0) return false;

  // Compute changeId
  const changeId = await computeChangeId(newChanges, editorInfo as unknown as Record<string, unknown>);

  // Tag changes and editor with changeId
  const taggedChanges = newChanges.map(c => ({ ...c, changeId }));
  const taggedEditor = { ...editorInfo, changeId };

  // Merge with existing
  const existingChanges = existingReport?.changes ?? [];
  const existingEditors = existingReport?.editorInfo ?? [];

  const payload: VariationsReportPayload = {
    description: 'RESO Data Dictionary Change Log',
    version: input.version,
    certificationRequestId: certRequestId,
    providerUoi: input.providerUoi,
    providerUsi: input.providerUsi,
    recipientUoi: input.recipientUoi,
    changes: [...existingChanges, ...taggedChanges],
    editorInfo: [taggedEditor, ...existingEditors],
  };

  return saveVariationsReport(input.version, input.providerUoi, input.providerUsi, input.recipientUoi, certRequestId, payload);
};
