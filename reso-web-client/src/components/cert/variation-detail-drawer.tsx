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

import { useEffect, useState } from 'react';
import {
  getVariationsReport,
  type VariationItem,
  type VariationProvenance,
  type VariationDraftAction,
  type VariationsReportPayload,
  type VariationsChange,
  type VariationsComment,
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
}

const ACTIONS: ReadonlyArray<ActionDef> = [
  { value: 'ignore', label: 'Ignore', description: 'No canonical mapping written.' },
  { value: 'remove', label: 'Remove', description: 'Canonical entry marks the value as not allowed.' },
  { value: 'accept', label: 'Accept', description: 'Canonical entry adopts the suggested mapping as standard.' },
  { value: 'submit-to-ft', label: 'Submit to FT WG', description: 'Move to Fast Track. No canonical write yet.' },
  { value: 'ft-mapped', label: 'FT Mapped', description: 'Fast Track terminal close (FT admin role required).' },
];

// ── Drawer ───────────────────────────────────────────────────────────

interface VariationDetailDrawerProps {
  readonly item: VariationItem | null;
  readonly onClose: () => void;
}

/** Auto-expand threshold. Few providers → expand all by default so
 *  the common case reads as a single panel. Heavy case (10+) collapses
 *  by default with summary lines visible. */
const AUTO_EXPAND_THRESHOLD = 3;

export const VariationDetailDrawer = ({ item, onClose }: VariationDetailDrawerProps) => {
  const [selectedAction, setSelectedAction] = useState<VariationDraftAction | null>(null);

  // Close on Escape
  useEffect(() => {
    if (!item) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, onClose]);

  // Seed the action picker from existing myDraft (if any) when the
  // drawer opens or the item swaps. Lets the user resume their
  // unsaved draft instead of starting from scratch.
  useEffect(() => {
    if (item) {
      setSelectedAction(item.myDraft?.action ?? null);
    }
  }, [item]);

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
          {item.myDraft ? (
            <span className="text-xs text-gray-500 dark:text-gray-400 mr-auto">
              Draft: {item.myDraft.action} · saved {humanizeTimeAgo(item.myDraft.draftedAt)}
            </span>
          ) : null}
          <button
            type="button"
            disabled
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500 rounded cursor-not-allowed"
            title="Wired in Phase 5"
          >
            Save Draft
          </button>
          <button
            type="button"
            disabled
            className="px-3 py-1.5 text-sm bg-blue-100 text-blue-400 dark:bg-blue-900/20 dark:text-blue-500 rounded cursor-not-allowed"
            title="Wired in Phase 6"
          >
            Submit
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
