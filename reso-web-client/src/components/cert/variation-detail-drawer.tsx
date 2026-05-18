/**
 * Variations Review detail drawer — slide-in panel for one item.
 * Phase 4 of the items-screen rewrite (#150).
 *
 * Layout:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ Header  identity · pill · count · age   ✕  │
 *   ├────────────────────────────────────────────┤
 *   │ Decision (radio: ignore | remove | accept  │
 *   │           | submit-to-ft | ft-mapped)      │
 *   │                                            │
 *   │ Provenance (N orgs, collapsible accordion) │
 *   │   ▸ Provider A · USI · Recipient           │
 *   │       Lazy-fetches variations-report.json  │
 *   │       on first expand → conversation       │
 *   │   ▸ Provider B · USI · Recipient           │
 *   ├────────────────────────────────────────────┤
 *   │ Footer  draft chip · [Save Draft] [Submit] │
 *   └────────────────────────────────────────────┘
 *
 * Phase 4 ships the shell + read-only conversation view. Save Draft
 * (Phase 5) and Submit (Phase 6) buttons render as disabled
 * placeholders.
 */

import { useEffect, useRef, useState } from 'react';
import {
  getVariationsReport,
  saveDraft,
  deleteDraft,
  submitVariationDecisions,
  type VariationItem,
  type VariationItemStatus,
  type VariationProvenance,
  type VariationDraftAction,
  type VariationsReportPayload,
  type VariationsChange,
  type VariationsComment,
  type SubmitVariationDecisionsResult,
} from '../../services/variations-service';
import { ballWithWhom, humanizeTimeAgo } from './variation-items-table';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Pull `version` and `certRequestId` off the encoded endorsementId.
 *
 * Format (see backend handler):
 *   {recipientUoi}-{providerUoi}-{providerUsi}-data-dictionary-{ddVersion}-{certRequestId}
 *
 * The `-data-dictionary-` separator is the only safely-splittable
 * delimiter (UOIs can contain dashes, certRequestId is a UUID with
 * dashes, but `data-dictionary` is a literal endorsement name we
 * control). We need the right-side suffix to call the S3 fetch
 * endpoint — the left-side IDs are already on the provenance entry.
 */
const parseEndorsementIdSuffix = (
  endorsementId: string
): { version: string; certRequestId: string } | null => {
  const marker = '-data-dictionary-';
  const idx = endorsementId.lastIndexOf(marker);
  if (idx < 0) return null;
  const suffix = endorsementId.slice(idx + marker.length);
  // DD versions are like "1.7" / "2.0" / "2.1" — no dashes.
  const firstDash = suffix.indexOf('-');
  if (firstDash < 0) return null;
  return {
    version: suffix.slice(0, firstDash),
    certRequestId: suffix.slice(firstDash + 1),
  };
};

const matchesVariation = (change: VariationsChange, item: VariationItem): boolean =>
  change.resourceName === item.resourceName &&
  (change.fieldName ?? '') === (item.fieldName ?? '') &&
  (change.lookupValue ?? '') === (item.lookupValue ?? '');

interface ActionDef {
  readonly value: VariationDraftAction;
  readonly label: string;
  readonly description: string;
  /** Whether this action requires a `VariationMapping` target on
   *  Save. The autosave path skips actions that need a mapping
   *  until the mapping picker lands (Phase 5+). Save Draft button
   *  surfaces the same constraint inline. */
  readonly requiresMapping: boolean;
}

const ACTIONS: ReadonlyArray<ActionDef> = [
  { value: 'ignore',       label: 'Ignore',          description: 'No canonical mapping written.', requiresMapping: false },
  { value: 'remove',       label: 'Remove',          description: 'Canonical entry marks the value as not allowed.', requiresMapping: false },
  { value: 'accept',       label: 'Accept',          description: 'Canonical entry adopts the suggested mapping as standard.', requiresMapping: true },
  { value: 'submit-to-ft', label: 'Submit to FT WG', description: 'Move to Fast Track. No canonical write yet.', requiresMapping: false },
  { value: 'ft-mapped',    label: 'FT Mapped',       description: 'Fast Track terminal close (FT admin role required).', requiresMapping: true },
];

const actionDef = (action: VariationDraftAction): ActionDef | undefined =>
  ACTIONS.find(a => a.value === action);

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'mapping-required';

/** Submit state machine. Mirrors the per-item branches the server
 *  returns on `POST /v2/certification/save-variation-decisions` —
 *  applied / stale / noop / rejected. */
type SubmitState = 'idle' | 'submitting' | 'applied' | 'stale' | 'noop' | 'rejected' | 'error';

interface DriftSnapshot {
  readonly status: VariationItemStatus;
  readonly lastUpdatedAt: string;
}

/** Debounce window for autosave-on-action-change. Short enough that a
 *  user committed to a decision sees their draft persisted quickly,
 *  long enough to skip transient picks while comparing actions. */
const AUTOSAVE_DEBOUNCE_MS = 500;

// ── Drawer ───────────────────────────────────────────────────────────

interface VariationDetailDrawerProps {
  readonly item: VariationItem | null;
  readonly onClose: () => void;
  /** Called after a successful saveDraft / deleteDraft so the
   *  parent can keep its items[] and selectedItem in sync (the row
   *  chip + drawer header reflect the new draft state without a
   *  full refetch). */
  readonly onItemUpdated?: (item: VariationItem) => void;
}

/** Auto-expand threshold. Few providers → expand all by default so
 *  the common case reads as a single panel. Heavy case (10+) collapses
 *  by default with summary lines visible. */
const AUTO_EXPAND_THRESHOLD = 3;

export const VariationDetailDrawer = ({ item, onClose, onItemUpdated }: VariationDetailDrawerProps) => {
  const [selectedAction, setSelectedAction] = useState<VariationDraftAction | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [submitResult, setSubmitResult] = useState<SubmitVariationDecisionsResult | null>(null);
  const [drift, setDrift] = useState<DriftSnapshot | null>(null);
  /** Snapshot of the item's pool state at drawer-open time. Drift is
   *  any change in `status` or `lastUpdatedAt` since this point — i.e.
   *  someone else's activity on the item while the user was drafting. */
  const openedSnapshotRef = useRef<DriftSnapshot | null>(null);
  /** Tracks whether the current selectedAction matches what was last
   *  successfully saved. Suppresses the autosave when the user is
   *  just resuming an existing draft. */
  const lastSavedActionRef = useRef<VariationDraftAction | null>(null);

  // Close on Escape
  useEffect(() => {
    if (!item) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, onClose]);

  // Seed local state from the item whenever the drawer opens or
  // swaps to a different item. Captures the drift-detection
  // snapshot at the same point.
  useEffect(() => {
    if (!item) return;
    setSelectedAction(item.myDraft?.action ?? null);
    setSaveState('idle');
    setSaveError(null);
    setSubmitState('idle');
    setSubmitResult(null);
    setDrift(null);
    openedSnapshotRef.current = {
      status: item.status,
      lastUpdatedAt: item.lastUpdatedAt,
    };
    lastSavedActionRef.current = item.myDraft?.action ?? null;
  }, [item?.variationKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave-on-action-change. Debounced so transient picks don't
  // hit the server. Actions that need a mapping target are skipped
  // (the Save Draft button surfaces the requirement inline; mapping
  // picker is a follow-up).
  useEffect(() => {
    if (!item || selectedAction === null) return;
    if (selectedAction === lastSavedActionRef.current) return;
    const def = actionDef(selectedAction);
    if (def?.requiresMapping) {
      setSaveState('mapping-required');
      setSaveError(null);
      return;
    }
    const timer = setTimeout(() => {
      void runSave(selectedAction);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAction, item?.variationKey]);

  const runSave = async (action: VariationDraftAction) => {
    if (!item) return;
    setSaveState('saving');
    setSaveError(null);
    try {
      const result = await saveDraft({
        variationKey: item.variationKey,
        action,
      });
      if (!result) {
        setSaveState('error');
        setSaveError('Save failed. Check that the action’s requirements are met.');
        return;
      }
      setSaveState('saved');
      lastSavedActionRef.current = action;
      // Drift check against the snapshot captured at drawer-open.
      const snap = openedSnapshotRef.current;
      if (snap && (result.status !== snap.status || result.lastUpdatedAt !== snap.lastUpdatedAt)) {
        setDrift({ status: result.status, lastUpdatedAt: result.lastUpdatedAt });
      }
      // Propagate the new state up so the row chip + drawer header
      // re-render without a full refetch.
      if (onItemUpdated) {
        onItemUpdated({
          ...item,
          myDraft: result.myDraft,
          otherDrafts: result.otherDrafts,
          status: result.status,
          lastUpdatedAt: result.lastUpdatedAt,
        });
      }
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    }
  };

  const runSubmit = async () => {
    if (!item || !selectedAction) return;
    const def = actionDef(selectedAction);
    if (def?.requiresMapping) return; // button is already disabled in this case
    setSubmitState('submitting');
    setSubmitResult(null);
    try {
      const result = await submitVariationDecisions([{
        variationKey: item.variationKey,
        action: selectedAction,
      }]);
      if (!result) {
        setSubmitState('error');
        return;
      }
      setSubmitResult(result);
      if (result.applied.length > 0) {
        setSubmitState('applied');
        const a = result.applied[0];
        // Propagate the resolved state so the row chip drops out of
        // the "in review" filter and the drawer header updates.
        if (onItemUpdated) {
          const next: VariationItem = {
            ...item,
            status: 'resolved',
            outcome: a.outcome,
            otherDrafts: item.otherDrafts,
          };
          // Drop myDraft — server cleared the processed draft.
          delete (next as { myDraft?: unknown }).myDraft;
          onItemUpdated(next);
        }
        lastSavedActionRef.current = null;
      } else if (result.stale.length > 0) {
        setSubmitState('stale');
      } else if (result.noop.length > 0) {
        setSubmitState('noop');
      } else if (result.rejected.length > 0) {
        setSubmitState('rejected');
      } else {
        setSubmitState('error');
      }
    } catch (err) {
      setSubmitState('error');
      console.error('runSubmit failed', err);
    }
  };

  const runDiscard = async () => {
    if (!item || !item.myDraft) return;
    setSaveState('saving');
    setSaveError(null);
    try {
      const ok = await deleteDraft(item.variationKey);
      if (!ok) {
        setSaveState('error');
        setSaveError('Discard failed.');
        return;
      }
      setSelectedAction(null);
      setSaveState('idle');
      lastSavedActionRef.current = null;
      if (onItemUpdated) {
        const { myDraft: _drop, ...rest } = item;
        onItemUpdated({ ...rest, otherDrafts: item.otherDrafts });
      }
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Discard failed.');
    }
  };

  if (!item) return null;

  const pill = ballWithWhom(item);
  const orgCount = item.provenance.length;
  const defaultExpanded = orgCount <= AUTO_EXPAND_THRESHOLD;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/10 z-30"
        onClick={onClose}
        onKeyDown={e => e.key === 'Escape' && onClose()}
        role="button"
        tabIndex={-1}
        aria-label="Close drawer"
      />
      <div
        className="fixed top-0 right-0 h-full w-[560px] bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 shadow-xl z-40 flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Variation detail"
      >
        {/* Header */}
        <div className="border-b border-gray-200 dark:border-gray-700 px-5 py-4 flex items-start justify-between shrink-0">
          <div className="min-w-0 flex-1 mr-4">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
              Variation
            </div>
            <div
              className="font-mono text-sm text-gray-800 dark:text-gray-200 truncate"
              title={[item.resourceName, item.fieldName, item.lookupValue].filter(Boolean).join(' · ')}
            >
              {item.resourceName}
              {item.fieldName ? <span className="text-gray-400 dark:text-gray-500"> · </span> : null}
              {item.fieldName}
              {item.lookupValue ? <span className="text-gray-400 dark:text-gray-500"> · </span> : null}
              {item.lookupValue}
            </div>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${pill.className}`}>
                {pill.label}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {orgCount} org{orgCount === 1 ? '' : 's'} · {humanizeTimeAgo(item.lastUpdatedAt)}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-2xl leading-none cursor-pointer shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Content (scrolls) */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 min-h-0">
          {/* Submit result banner — one outcome line per response
              branch from the save-variation-decisions endpoint. */}
          {submitState === 'applied' && submitResult && submitResult.applied[0] && (
            <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 rounded px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200">
              <span className="font-medium">Submitted.</span>
              {submitResult.applied[0].outcome && (
                <> Outcome: <span className="font-mono">{submitResult.applied[0].outcome}</span>.</>
              )}
              {submitResult.rollupNotificationsFanOutTo.length > 0 && (
                <> Notifications sent to {submitResult.rollupNotificationsFanOutTo.length} provider{submitResult.rollupNotificationsFanOutTo.length === 1 ? '' : 's'}.</>
              )}
            </div>
          )}
          {submitState === 'stale' && submitResult && submitResult.stale[0] && (
            <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              <span className="font-medium">Already resolved.</span>
              {' '}{submitResult.stale[0].resolvedBy} resolved this {humanizeTimeAgo(submitResult.stale[0].resolvedAt)}
              {submitResult.stale[0].currentOutcome && (
                <> as <span className="font-mono">{submitResult.stale[0].currentOutcome}</span></>
              )}
              . Your draft was cleared.
            </div>
          )}
          {submitState === 'noop' && submitResult && submitResult.noop[0] && (
            <div className="bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-xs text-gray-700 dark:text-gray-300">
              <span className="font-medium">No-op:</span> {submitResult.noop[0].reason}
            </div>
          )}
          {submitState === 'rejected' && submitResult && submitResult.rejected[0] && (
            <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900 rounded px-3 py-2 text-xs text-rose-900 dark:text-rose-200">
              <span className="font-medium">Rejected:</span> {submitResult.rejected[0].reason}. Your draft is preserved.
            </div>
          )}
          {submitState === 'error' && (
            <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900 rounded px-3 py-2 text-xs text-rose-900 dark:text-rose-200">
              <span className="font-medium">Submit failed.</span> Try again — your draft is preserved.
            </div>
          )}

          {/* Drift banner — fires when status or lastUpdatedAt
              changed between drawer-open and the latest save response.
              Means someone else acted on this item while the user was
              drafting; the drawer is showing fresh state but the user
              should know their context changed. */}
          {drift && openedSnapshotRef.current && (
            <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              <span className="font-medium">This item changed while you were drafting.</span>
              {drift.status !== openedSnapshotRef.current.status && (
                <> Status moved from <span className="font-mono">{openedSnapshotRef.current.status}</span> to <span className="font-mono">{drift.status}</span>.</>
              )}
              {' '}Your draft is preserved.
            </div>
          )}

          {/* Decision (action picker) */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
              Decision
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              {ACTIONS.map(a => (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => setSelectedAction(a.value)}
                  className={`text-left px-3 py-2 rounded border text-sm transition-colors cursor-pointer ${
                    selectedAction === a.value
                      ? 'bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-700'
                      : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/40'
                  }`}
                >
                  <div className="font-medium text-gray-800 dark:text-gray-200">{a.label}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{a.description}</div>
                </button>
              ))}
            </div>
          </section>

          {/* Provenance */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
              Provenance ({orgCount})
            </div>
            <div className="space-y-2">
              {item.provenance.map((p, i) => (
                <ProvenanceSection
                  key={`${p.providerUoi}-${p.providerUsi}-${p.recipientUoi}-${i}`}
                  provenance={p}
                  item={item}
                  defaultExpanded={defaultExpanded}
                />
              ))}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 flex items-center justify-end gap-2 shrink-0 bg-gray-50 dark:bg-gray-900/40">
          {/* Left-aligned save-state / draft indicator. */}
          <span className="text-xs mr-auto min-w-0 truncate">
            {saveState === 'saving' && (
              <span className="text-gray-500 dark:text-gray-400">Saving draft…</span>
            )}
            {saveState === 'saved' && item.myDraft && (
              <span className="text-emerald-700 dark:text-emerald-300">
                Draft saved · {item.myDraft.action} · {humanizeTimeAgo(item.myDraft.draftedAt)}
              </span>
            )}
            {saveState === 'error' && (
              <span className="text-rose-600 dark:text-rose-400">{saveError ?? 'Save failed.'}</span>
            )}
            {saveState === 'mapping-required' && selectedAction && (
              <span className="text-amber-700 dark:text-amber-300">
                Action “{actionDef(selectedAction)?.label}” needs a mapping target (picker coming).
              </span>
            )}
            {saveState === 'idle' && item.myDraft && (
              <span className="text-gray-500 dark:text-gray-400">
                Draft: {item.myDraft.action} · {humanizeTimeAgo(item.myDraft.draftedAt)}
              </span>
            )}
          </span>

          {item.myDraft && (
            <button
              type="button"
              onClick={() => { void runDiscard(); }}
              disabled={saveState === 'saving'}
              className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              Discard draft
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              if (selectedAction) void runSave(selectedAction);
            }}
            disabled={
              !selectedAction ||
              saveState === 'saving' ||
              saveState === 'mapping-required'
            }
            className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-gray-100 dark:disabled:hover:bg-gray-700"
          >
            Save Draft
          </button>

          <button
            type="button"
            onClick={() => { void runSubmit(); }}
            disabled={
              !selectedAction ||
              saveState === 'mapping-required' ||
              submitState === 'submitting' ||
              submitState === 'applied' ||
              item.status === 'resolved'
            }
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-600"
            title={
              item.status === 'resolved'
                ? 'Item is already resolved'
                : submitState === 'applied'
                  ? 'Submitted'
                  : !selectedAction
                    ? 'Select an action first'
                    : 'Submit this decision to canonical'
            }
          >
            {submitState === 'submitting' ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </>
  );
};

// ── Provenance section (accordion) ───────────────────────────────────

interface ProvenanceSectionProps {
  readonly provenance: VariationProvenance;
  readonly item: VariationItem;
  readonly defaultExpanded: boolean;
}

const ProvenanceSection = ({ provenance, item, defaultExpanded }: ProvenanceSectionProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [report, setReport] = useState<VariationsReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-fetch the S3 report when the section is first expanded.
  // Cached per drawer-open session — collapse → re-expand doesn't
  // refetch (the `report` state persists).
  useEffect(() => {
    if (!expanded || report || loading) return;
    const ids = parseEndorsementIdSuffix(provenance.endorsementId);
    if (!ids) {
      setError(`Cannot parse endorsementId: ${provenance.endorsementId}`);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await getVariationsReport(
          ids.version,
          provenance.providerUoi,
          provenance.providerUsi,
          provenance.recipientUoi,
          ids.certRequestId
        );
        if (cancelled) return;
        if (!result) {
          setError('Report not found in S3 for this provenance.');
        } else {
          setReport(result);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [expanded, report, loading, provenance]);

  // Filter the report's changes to ones matching this variation,
  // then flatten their conversations.
  const matchingChanges = report?.changes.filter(c => matchesVariation(c, item)) ?? [];
  const conversations: ReadonlyArray<VariationsComment> = matchingChanges.flatMap(
    c => c.conversations ?? []
  );

  const submitter = provenance.submittedByDisplayName ?? provenance.submittedByProviderUoi;
  const lastEditor = provenance.lastEditorDisplayName ?? provenance.lastEditorUoi;
  const isLastEditFresh =
    provenance.lastUpdatedAt && provenance.lastUpdatedAt !== provenance.submittedAt;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded">
      <button
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40"
        aria-expanded={expanded}
      >
        <span className="text-gray-400 dark:text-gray-500 w-3 text-center font-mono">
          {expanded ? '−' : '+'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate text-gray-800 dark:text-gray-200">
            {submitter}
            <span className="text-gray-400 dark:text-gray-500 mx-1">·</span>
            <span className="font-mono text-xs text-gray-600 dark:text-gray-400">{provenance.providerUsi}</span>
            <span className="text-gray-400 dark:text-gray-500 mx-1">→</span>
            <span className="font-mono text-xs text-gray-600 dark:text-gray-400">{provenance.recipientUoi}</span>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {provenance.requestedAction
              ? <>Requested: <span className="font-medium">{provenance.requestedAction}</span></>
              : 'No requested action'}
            <span className="mx-1.5">·</span>
            Submitted {humanizeTimeAgo(provenance.submittedAt)}
            {lastEditor && isLastEditFresh ? (
              <>
                <span className="mx-1.5">·</span>
                Last edit by {lastEditor} {humanizeTimeAgo(provenance.lastUpdatedAt ?? '')}
              </>
            ) : null}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 px-3 py-2">
          {loading && (
            <div className="text-xs text-gray-500 dark:text-gray-400">Loading conversation…</div>
          )}
          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>
          )}
          {report && conversations.length === 0 && !loading && !error && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              No conversation on this variation yet.
            </div>
          )}
          {report && conversations.length > 0 && (
            <ul className="space-y-2">
              {conversations.map((c, i) => (
                <li key={`${c.timestamp}-${i}`} className="text-xs">
                  <div className="text-gray-500 dark:text-gray-400">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{c.from}</span>
                    <span className="mx-1.5">·</span>
                    <span title={new Date(c.timestamp).toLocaleString()}>
                      {humanizeTimeAgo(c.timestamp)}
                    </span>
                  </div>
                  <div className="mt-0.5 whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                    {c.message}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
