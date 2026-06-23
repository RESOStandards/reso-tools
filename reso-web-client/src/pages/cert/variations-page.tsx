/**
 * Variations Review Dashboard — lists all active reviews and allows
 * drilling into individual review detail.
 *
 * Two levels:
 * 1. Review list — cards showing each active review with lifecycle stats
 * 2. Review detail — the full card-per-variation view (imported from VariationsReviewDetail)
 *
 * Provider view: their own reviews + items where others' reviews affect same data elements
 * Admin view: all active reviews across all providers
 *
 * Data loading:
 * - From route state (navigated from a job's "Review Variations" button)
 * - From the service (fetched on mount for the review list)
 * - Persisted in localStorage for refresh survival
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useBlocker, useNavigate } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SearchInput, FilterPill } from '../../components/metadata/shared';
import { downloadVariationsCsv } from '../../services/variations-csv-export';
import { buildVariationKey } from '@reso-standards/reso-client';
import { enqueueTask, subscribeToTasks } from '../../services/pending-tasks';
import { VARIATIONS_SAVE_TASK_TYPE, type VariationsSavePayload } from '../../services/pending-task-executors/variations-save';
import { type BlendedVariation, type BlendedSuggestion, type BlendedVariationsReport } from '../../services/variations-blender';
import { searchLocks, createLock, deleteLock, variationsLockResourceId, listVariationItems, type LockRecord, type VariationItem } from '../../services/variations-service';
import { useNotifications } from '../../hooks/use-notifications';
import { markVariationsReviewSubmitted } from '../../services/job-manager';
import { useJobs } from '../../hooks/use-jobs';
import { VariationComments, type VariationComment } from '../../components/cert/variation-comments';
import { useAuth } from '../../hooks/use-auth';
import { useOrganizationNames } from '../../hooks/use-organization-names';

// ── Types ────────────────────────────────────────────────────────────

type VariationFilter = 'all' | 'fields' | 'lookups' | 'resources' | 'expansions';
type ActionStatus = 'pending' | 'ignored' | 'fast-track' | 'remove';

// ── Constants ────────────────────────────────────────────────────────

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

const FILTER_TABS: ReadonlyArray<{ key: VariationFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'fields', label: 'Fields' },
  { key: 'lookups', label: 'Lookups' },
  { key: 'resources', label: 'Resources' },
  { key: 'expansions', label: 'Expansions' },
];

const variationKey = (v: BlendedVariation): string =>
  buildVariationKey(v.resourceName, v.fieldName, v.lookupValue);

/** Render a relative time like "2m ago" / "1h ago" from a Unix-second timestamp. */
const formatTimeSince = (unixSeconds: number): string => {
  const diffSec = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
};

/** Segments that make up a variation path: resource, field, lookup. Undefined slots are skipped. */
interface PathPart {
  readonly text: string;
  readonly changed: boolean;
}

const sourceSegments = (v: BlendedVariation): ReadonlyArray<string | undefined> =>
  [v.resourceName, v.fieldName, v.lookupValue];

const targetSegments = (s: BlendedSuggestion): ReadonlyArray<string | undefined> =>
  [s.suggestedResourceName, s.suggestedFieldName, s.suggestedLookupValue ?? s.suggestedLegacyODataValue];

/** Compare segment-by-segment and mark which ones differ. */
const diffSegments = (src: ReadonlyArray<string | undefined>, tgt: ReadonlyArray<string | undefined>): { source: ReadonlyArray<PathPart>; target: ReadonlyArray<PathPart> } => {
  const source: PathPart[] = [];
  const target: PathPart[] = [];
  const max = Math.max(src.length, tgt.length);
  for (let i = 0; i < max; i++) {
    const s = src[i];
    const t = tgt[i];
    if (s != null) source.push({ text: s, changed: s !== t });
    if (t != null) target.push({ text: t, changed: s !== t });
  }
  return { source, target };
};

interface StrategyMeta {
  readonly label: string;
  readonly color: string;
  /** Plain-language explanation surfaced as a `title` tooltip on the chip. */
  readonly description: string;
}

const STRATEGY_LABELS: Readonly<Record<string, StrategyMeta>> = {
  'Substring': {
    label: 'Substring Match',
    color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    description: 'The local name contains the standard name (or vice versa) — likely the same concept with extra prefix or suffix.',
  },
  'Edit Distance': {
    label: 'Edit Distance',
    color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    description: 'The local name is within a few character edits of a standard name — likely a typo or minor variant.',
  },
  'Fast Track': {
    label: 'Fast Track',
    color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    description: 'Pre-approved by the DD workgroup as a future-standard candidate. Flagging for Fast Track sends it to expedited review.',
  },
  'Admin Review': {
    label: 'Admin Review',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    description: 'Requires a RESO admin to evaluate before the suggested mapping can be accepted.',
  },
  'Suggestion': {
    label: 'Suggestion',
    color: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    description: 'A general suggestion from the variations service — not categorized into one of the structured strategies.',
  },
  'Policy': {
    label: 'Policy',
    color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    description: 'Matches a RESO policy rule — typically blocks certification until resolved.',
  },
};

/** Resolve strategy metadata with a sensible fallback for unknown strategy names. */
const getStrategyMeta = (strategy: string): StrategyMeta =>
  STRATEGY_LABELS[strategy] ?? {
    label: strategy,
    color: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    description: `Strategy: ${strategy}`,
  };

// ── Draft localStorage ───────────────────────────────────────────────

const DRAFT_KEY_PREFIX = 'variations-draft:';

const loadDraft = (reportId: string): Map<string, ActionStatus> => {
  try {
    const raw = localStorage.getItem(`${DRAFT_KEY_PREFIX}${reportId}`);
    if (!raw) return new Map();
    return new Map(JSON.parse(raw) as ReadonlyArray<[string, ActionStatus]>);
  } catch { return new Map(); }
};

const saveDraft = (reportId: string, actions: Map<string, ActionStatus>): void => {
  if (actions.size === 0) localStorage.removeItem(`${DRAFT_KEY_PREFIX}${reportId}`);
  else localStorage.setItem(`${DRAFT_KEY_PREFIX}${reportId}`, JSON.stringify([...actions.entries()]));
};

const clearDraft = (reportId: string): void => localStorage.removeItem(`${DRAFT_KEY_PREFIX}${reportId}`);

// ── Main Component ───────────────────────────────────────────────────

/**
 * Adapt cross-provider pool items into the BlendedVariationsReport shape
 * that ReviewDetailView renders. The pool is keyed per-item (with N
 * providers in `provenance[]`) while the legacy report was keyed
 * per-report-tuple — so the top-level provider/recipient/version fields
 * are intentionally left undefined on the adapted report. Downstream
 * code that depends on them (lock model, save handler) treats undefined
 * as "no per-tuple context" and degrades to no-op. Cross-provider lock
 * + save semantics are wired in the next slice (see #150 + #208).
 */
export const adaptPoolItemsToReport = (items: ReadonlyArray<VariationItem>): BlendedVariationsReport => {
  // #203: render only items still in review (service status 'pending'). Resolved items
  // (ignored/accepted/removed/ft-mapped) belong in general search/history, not this queue. An item
  // the viewer ignores *this session* stays 'pending' on the service until Submit (its staged state
  // is the draft-actions overlay), so it remains visible here, then drops on the next mount once
  // resolved. Both `variations` and `counts` derive from this filtered set, so they stay in sync.
  const variations: BlendedVariation[] = items
    .filter(item => item.status === 'pending')
    .map(item => {
    const elementType: BlendedVariation['type'] = item.lookupValue
      ? 'lookup'
      : item.fieldName
        ? 'field'
        : 'resource';
    const suggestions: ReadonlyArray<BlendedSuggestion> = item.mapping
      ? [{
          suggestedResourceName: item.mapping.suggestedResourceName,
          suggestedFieldName: item.mapping.suggestedFieldName,
          suggestedLookupValue: item.mapping.suggestedStandardLookupValue,
          suggestedLegacyODataValue: item.mapping.suggestedLegacyODataValue,
          suggestedRelatedResourceName: item.mapping.suggestedRelatedResourceName,
          suggestedRelatedFieldName: item.mapping.suggestedRelatedFieldName,
          suggestedRelatedLookupValue: item.mapping.suggestedRelatedLookupValue,
          strategy: 'Suggestion',
        }]
      : [];
    // First provenance entry drives the per-row provider/recipient
    // labels for the legacy row renderer. Cross-org awareness (the
    // "+N others" indicator) layers on in a later slice.
    const firstProv = item.provenance[0];
    return {
      resourceName: item.resourceName,
      fieldName: item.fieldName,
      lookupValue: item.lookupValue,
      suggestions,
      ignored: item.outcome === 'ignored',
      source: 'blended',
      type: elementType,
      providerUoi: firstProv?.providerUoi,
      providerUsi: firstProv?.providerUsi,
      recipientUoi: firstProv?.recipientUoi,
    };
  });
  const counts = {
    resources: variations.filter(v => v.type === 'resource').length,
    fields: variations.filter(v => v.type === 'field').length,
    lookups: variations.filter(v => v.type === 'lookup').length,
    expansions: variations.filter(v => v.type === 'expansion').length,
    complexTypes: variations.filter(v => v.type === 'complexType').length,
    total: variations.length,
    ignored: variations.filter(v => v.ignored).length,
    fastTrack: 0,
    adminReview: 0,
  };
  return {
    description: 'Variations review (cross-provider pool)',
    version: '',
    generatedOn: new Date().toISOString(),
    fuzziness: 0,
    variations,
    counts,
  };
};

export const VariationsPage = () => {
  const navigate = useNavigate();
  const { isAuthenticated, isAdmin, user, isHydrating: authHydrating } = useAuth();

  const [report, setReport] = useState<BlendedVariationsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Pool-fed fetch. Viewer scope is applied server-side from the auth
  // context (provider sees their own slice; admin sees the full pool).
  // #203: status is filtered to in-review ('pending') so resolved items don't surface here and so
  // pagination returns in-review rows rather than a first page of resolved ones; the adapter also
  // re-filters defensively. The remaining filters (endorsement, element, age) layer on in a later slice.
  useEffect(() => {
    if (authHydrating) return;
    if (!isAuthenticated) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const page = await listVariationItems({ status: 'pending' });
        if (cancelled) return;
        setReport(adaptPoolItemsToReport(page.items));
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load variations');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, authHydrating]);

  if (loading) {
    return (
      <div className={`${PAGE_CONTAINER} py-12 text-center`}>
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 mr-2" />
        <span className="text-sm text-gray-500 dark:text-gray-400">Loading variations...</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={`${PAGE_CONTAINER} py-6`}>
        <div className="p-4 rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20">
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-1">Couldn't load variations</h2>
          <p className="text-sm text-amber-800 dark:text-amber-300">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className={`${PAGE_CONTAINER} py-12 text-center`}>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {isAuthenticated ? 'No variations to review.' : 'Sign in to view variations.'}
        </p>
      </div>
    );
  }

  return <ReviewDetailView report={report} onBack={() => navigate('/cert/variations')} user={user} isAdmin={isAdmin} />;
};


// ── Review Detail View ───────────────────────────────────────────────

const ReviewDetailView = ({ report, onBack, user, isAdmin, jobId }: {
  readonly report: BlendedVariationsReport;
  readonly onBack: () => void;
  readonly user: { readonly username: string; readonly email: string; readonly fullName: string } | null;
  readonly isAdmin: boolean;
  /** Local job ID — set by VariationsPage when navigating from a job card. Used to mark the job as having submitted variations after a successful save. */
  readonly jobId?: string;
}) => {
  const navigate = useNavigate();
  const { lookup: lookupOrg, lookupSystem } = useOrganizationNames();
  const { isHydrating: authHydrating } = useAuth();
  const reportId = `${report.version}`;

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<VariationFilter>('all');
  const [actions, setActions] = useState<Map<string, ActionStatus>>(() => loadDraft(reportId));
  const [draftComments, setDraftComments] = useState<Map<string, ReadonlyArray<VariationComment>>>(new Map());
  const [saving, setSaving] = useState(false);
  const [staleNotification, setStaleNotification] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Whether this report has been submitted before (drives CTA label and
  // the first-time instruction line). Read reactively via useJobs so the
  // CTA flips from "Submit Review" → "Save Changes" right after the
  // first successful submit, without a page reload.
  const { jobs } = useJobs();
  const job = jobId ? jobs.find(j => j.id === jobId) : undefined;
  const hasSubmitted = !!job?.variationsReviewSubmittedAt;

  // Watch for VARIATIONS_REPORT notifications that indicate someone else updated this report
  const { notifications } = useNotifications();
  useEffect(() => {
    const hasUpdate = notifications.some(n =>
      n.notificationType === 'VARIATIONS_REPORT_SAVED' || n.notificationType === 'VARIATIONS_REPORT'
    );
    if (hasUpdate) setStaleNotification(true);
  }, [notifications]);

  // Lock management — claim on first mutation, hold until submit.
  //
  // Model:
  //   - Default state is read-only viewing. No lock is created on mount.
  //   - The first action (toggle / comment) attempts createLock. Success
  //     promotes us to editor; 409 means someone else is already editing.
  //   - Lock holds until handleSave completes (or Discard clears it).
  //   - Server-side TTL handles abandoned sessions; we never release on
  //     unmount, matching the legacy "until they submit" behavior.
  //   - Polling every 30s detects when another user takes the lock (we
  //     transition to read-only) or releases it (we become claimable
  //     again on next action). Replace with sockets when available.
  const [lockHolder, setLockHolder] = useState<LockRecord | null>(null);
  const [lockLoading, setLockLoading] = useState(true);
  const lockHolderRef = useRef<LockRecord | null>(null);

  const lockResourceId = report.providerUoi && report.providerUsi && report.recipientUoi
    ? variationsLockResourceId(report.version, report.providerUoi, report.providerUsi, report.recipientUoi)
    : null;

  const refetchLocks = useCallback(async () => {
    if (!lockResourceId || !report.providerUoi) return;
    const existing = await searchLocks(lockResourceId, report.providerUoi);
    const active = existing
      .filter(l => l.lockUnixTimestampTTL * 1000 > Date.now())
      .sort((a, b) => b.lockUnixTimestamp - a.lockUnixTimestamp)[0]
      ?? null;
    lockHolderRef.current = active;
    setLockHolder(active);
  }, [lockResourceId, report.providerUoi]);

  useEffect(() => {
    if (!lockResourceId) { setLockLoading(false); return; }
    let cancelled = false;
    refetchLocks().finally(() => { if (!cancelled) setLockLoading(false); });
    const id = setInterval(refetchLocks, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [lockResourceId, refetchLocks]);

  const isLockedByMe = !!lockHolder && !!user && lockHolder.username === user.username;
  const isLockedByOther = !!lockHolder && !isLockedByMe;
  const isReadOnly = isLockedByOther;

  /**
   * Claim the lock if we don't already hold it. Returns true if the caller
   * may proceed with a mutation, false if blocked. Reads the current lock
   * via ref so the closure is not stale across polls.
   */
  const ensureMyLock = useCallback(async (): Promise<boolean> => {
    if (!lockResourceId || !report.providerUoi || !user) return false;
    const current = lockHolderRef.current;
    if (current && current.username === user.username) return true;
    if (current && current.username !== user.username) return false;
    const result = await createLock({
      resourceId: lockResourceId,
      providerUoi: report.providerUoi,
      username: user.username,
      displayName: user.fullName,
      email: user.email,
    });
    // Refetch regardless: on success this confirms our hold; on 409 it
    // surfaces who beat us so the UI flips to read-only.
    await refetchLocks();
    return !!result;
  }, [lockResourceId, report.providerUoi, user, refetchLocks]);

  const releaseMyLock = useCallback(async () => {
    if (!lockResourceId || !report.providerUoi) return;
    if (!isLockedByMe) return;
    await deleteLock(lockResourceId, report.providerUoi);
    await refetchLocks();
  }, [lockResourceId, report.providerUoi, isLockedByMe, refetchLocks]);

  useEffect(() => { saveDraft(reportId, actions); }, [actions, reportId]);

  // Hydrate prior decisions from the backend variations report on mount,
  // so reopening a page that's already been triaged shows the user's
  // earlier Ignore / Fast Track / Remove choices instead of starting
  // blank. The hydrated map is also our dirty baseline — `isDirty`
  // becomes "current actions diverge from what's saved", not "user has
  // touched anything", so the Submit/Save Changes button only enables
  // when there are actually new changes to send.
  const hydratedActionsRef = useRef<Map<string, ActionStatus>>(new Map());
  const [hydratedKey, setHydratedKey] = useState(0);
  // Saved conversations from the backend variations report, keyed by
  // variationKey. Slice 1: empty stub — populated in Slice 2 from
  // VariationItem.provenance[].lastEditor* + per-record S3 fetch.
  const savedConversations = useMemo(() => new Map<string, ReadonlyArray<VariationComment>>(), []);

  useEffect(() => {
    // Slice 1 stub: hydration from a per-report saved report is no longer
    // valid because the dashboard reads from the cross-provider pool, not
    // a single per-tuple report. Per-user draft hydration (from
    // `VariationItem.myDraft`) gets wired in Slice 2 when the interactive
    // layer moves to the new saveDraft / submitVariationDecisions
    // endpoints. Until then this effect is intentionally a no-op so
    // existing actions Map stays empty and the table renders blank chips.
  }, [report.version, report.providerUoi, report.providerUsi, report.recipientUoi, authHydrating]);

  /**
   * Count of unsaved deltas — actions whose status differs from the
   * hydrated baseline, plus a +1 per draft-only comment thread.
   * Renamed from a boolean to a number so the "X unsaved" badge in
   * the header reads accurately (previously it showed `actions.size`,
   * which double-counted prior saved actions on a re-edit).
   */
  const unsavedCount = useMemo(() => {
    const baseline = hydratedActionsRef.current;
    let count = 0;
    for (const [k, v] of actions) {
      if (baseline.get(k) !== v) count += 1;
    }
    // Action keys that were dropped (in baseline, missing from current map).
    for (const k of baseline.keys()) {
      if (!actions.has(k)) count += 1;
    }
    count += draftComments.size;
    return count;
    // hydratedKey forces recompute when the baseline arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, draftComments, hydratedKey]);
  const isDirty = unsavedCount > 0;

  // Block navigation when there are unsaved edits. Without resolving
  // the blocker (proceed/reset), nav clicks silently no-op and the
  // user gets stuck. Confirm with the user, then either proceed or
  // cancel the navigation.
  const blocker = useBlocker(isDirty && !saving);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const ok = window.confirm('You have unsaved variations review changes. Leave the page and discard them?');
    if (ok) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  const filtered = useMemo(() => {
    let items = report.variations;
    if (filter !== 'all') {
      const typeMap: Record<string, string> = { fields: 'field', lookups: 'lookup', resources: 'resource', expansions: 'expansion' };
      items = items.filter(v => v.type === typeMap[filter]);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(v =>
        v.resourceName.toLowerCase().includes(q) ||
        (v.fieldName?.toLowerCase().includes(q) ?? false) ||
        (v.lookupValue?.toLowerCase().includes(q) ?? false) ||
        v.suggestions.some(s =>
          (s.suggestedFieldName?.toLowerCase().includes(q) ?? false) ||
          (s.suggestedLookupValue?.toLowerCase().includes(q) ?? false) ||
          (s.suggestedLegacyODataValue?.toLowerCase().includes(q) ?? false)
        )
      );
    }
    return items;
  }, [report, filter, search]);

  const filterCounts = useMemo(() => ({
    all: report.variations.length,
    fields: report.counts.fields,
    lookups: report.counts.lookups,
    resources: report.counts.resources,
    expansions: report.counts.expansions,
  }), [report]);

  const addComment = useCallback(async (key: string, comment: VariationComment) => {
    const ok = await ensureMyLock();
    if (!ok) return;
    setDraftComments(prev => {
      const next = new Map(prev);
      next.set(key, [...(prev.get(key) ?? []), comment]);
      return next;
    });
  }, [ensureMyLock]);

  const removeComment = useCallback((key: string, index: number) => {
    setDraftComments(prev => {
      const next = new Map(prev);
      const comments = [...(prev.get(key) ?? [])];
      comments.splice(index, 1);
      if (comments.length === 0) next.delete(key);
      else next.set(key, comments);
      return next;
    });
  }, []);

  const toggleAction = useCallback(async (key: string, status: ActionStatus) => {
    const ok = await ensureMyLock();
    if (!ok) return;
    setActions(prev => {
      const next = new Map(prev);
      if (next.get(key) === status) next.delete(key);
      else next.set(key, status);
      return next;
    });
  }, [ensureMyLock]);

  /**
   * Wait until a queued task settles (success or terminal failure).
   * Subscribes to the global queue and resolves/rejects when the
   * specific task transitions. Used to block the UI on Finalize.
   */
  const awaitTaskCompletion = (taskId: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const unsubscribe = subscribeToTasks((current) => {
        const task = current.find(t => t.id === taskId);
        if (!task) {
          // Task already cleaned up (auto-removed after a successful
          // linger). Treat as success.
          unsubscribe();
          resolve();
          return;
        }
        if (task.status === 'success') {
          unsubscribe();
          resolve();
        } else if (task.status === 'failed' && task.retryCount >= 3) {
          unsubscribe();
          reject(new Error(task.lastError ?? 'Save failed'));
        }
      });
    });

  const handleSave = useCallback(async (options: { finalize?: boolean } = {}) => {
    if (!report.providerUoi || !report.providerUsi || !report.recipientUoi) return;

    // Only send the delta — actions whose status differs from what's
    // already saved on the server. Without this filter the hydrated
    // baseline would be re-sent untagged on every Save, and the backend
    // (which identifies "new" changes by missing changeId) would dedupe
    // by appending fresh duplicates of decisions the user never touched.
    const baseline = hydratedActionsRef.current;
    // Build a key→variation lookup once so each delta action can pull
    // its primary suggestion onto the save payload. Without this, the
    // saved S3 report only carries source identity + decision flags,
    // and admin drill-ins (which only see the saved report) render
    // "No suggestion" for every row.
    const variationByKey = new Map(report.variations.map(v => [variationKey(v), v]));
    const deltaActions = [...actions.entries()]
      .filter(([key, status]) => baseline.get(key) !== status)
      .map(([key, status]) => {
        const primary = variationByKey.get(key)?.suggestions[0];
        return {
          key,
          status,
          ...(primary?.suggestedResourceName ? { suggestedResourceName: primary.suggestedResourceName } : {}),
          ...(primary?.suggestedFieldName ? { suggestedFieldName: primary.suggestedFieldName } : {}),
          ...(primary?.suggestedLookupValue ? { suggestedLookupValue: primary.suggestedLookupValue } : {}),
          ...(primary?.suggestedLegacyODataValue ? { suggestedLegacyODataValue: primary.suggestedLegacyODataValue } : {}),
        };
      });

    // Finalize is allowed without new edits — admin closing out a
    // review that has no pending changes still needs to send a
    // request so the backend can flip the endorsement to resolved.
    if (deltaActions.length === 0 && draftComments.size === 0 && !options.finalize) return;

    setSaving(true);

    // Optimistic local cleanup. The pending-tasks queue persists the
    // payload to SQLite and retries on failure — if the actual
    // server save never lands, the user can retry from the queue UI.
    // Lock release waits for actual task completion below, so we
    // don't free the lock prematurely on a failed save.
    hydratedActionsRef.current = new Map(actions);
    setHydratedKey(k => k + 1);
    clearDraft(reportId);
    setDraftComments(new Map());
    if (jobId) markVariationsReviewSubmitted(jobId);

    const payload: VariationsSavePayload = {
      version: report.version,
      providerUoi: report.providerUoi,
      providerUsi: report.providerUsi,
      recipientUoi: report.recipientUoi,
      actions: deltaActions,
      comments: [...draftComments.entries()].flatMap(([variationKey, comments]) =>
        comments.map(c => ({ variationKey, ...c }))
      ),
      userName: user?.fullName ?? user?.username ?? '',
      userEmail: user?.email ?? '',
      finalize: options.finalize,
    };

    const task = await enqueueTask({
      type: VARIATIONS_SAVE_TASK_TYPE,
      payload,
      scope: reportId,
    });

    if (options.finalize) {
      // Finalize blocks: wait for the task to settle, then release
      // lock + navigate. Other saves are fire-and-forget — the
      // queue's status pill surfaces success/failure.
      try {
        await awaitTaskCompletion(task.id);
        await releaseMyLock();
        navigate('/cert/variations');
      } catch (err) {
        console.error('Finalize failed:', err);
      } finally {
        setSaving(false);
      }
    } else {
      // Fire-and-forget. When the task succeeds the lock release
      // fires asynchronously so subsequent reviewers can claim it.
      void awaitTaskCompletion(task.id).then(() => releaseMyLock()).catch(() => { /* failure surfaced via queue UI */ });
      setSaving(false);
    }
  }, [actions, reportId, report, user, draftComments, jobId, releaseMyLock, navigate]);

  return (
    <div className={`${PAGE_CONTAINER} py-6`}>
      {/* Lock banner — only renders when someone else is reviewing. The
          pulsing roundel is a deliberate affordance carried over from the
          legacy app: it draws the eye to the contact card so the viewer
          knows who to reach out to. */}
      {isLockedByOther && lockHolder && (
        <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg flex items-center gap-3">
          <UserRoundel name={lockHolder.displayName || lockHolder.username} pulse />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200 truncate">
              {lockHolder.displayName || lockHolder.username} is reviewing this report
            </p>
            <p className="text-xs text-amber-700/80 dark:text-amber-300/80">
              Your view is read-only until they submit.
            </p>
          </div>
          {lockHolder.email && (
            <a
              href={`mailto:${lockHolder.email}?subject=${encodeURIComponent('Variations Review')}`}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors shrink-0"
            >
              Contact
            </a>
          )}
        </div>
      )}
      {lockLoading && (
        <div className="mb-4 flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
          Checking review status...
        </div>
      )}
      {staleNotification && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg flex items-center justify-between text-sm text-blue-800 dark:text-blue-300">
          <span>This report was updated by another reviewer. Reload to see the latest changes.</span>
          <button
            type="button"
            onClick={() => { setStaleNotification(false); onBack(); }}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer shrink-0 ml-4"
          >
            Reload
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Variations Review</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2 flex-wrap">
              <span>
                DD {report.version} — {report.counts.total} variation{report.counts.total !== 1 ? 's' : ''}
                {report.counts.ignored > 0 && ` (${report.counts.ignored} ignored)`}
                {report.counts.fastTrack > 0 && ` (${report.counts.fastTrack} fast track)`}
              </span>
              {isLockedByMe && lockHolder && (
                <span
                  title={`Lock acquired at ${new Date(lockHolder.lockUnixTimestamp * 1000).toLocaleString()}, expires ${new Date(lockHolder.lockUnixTimestampTTL * 1000).toLocaleString()}`}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900/50"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                    className="h-3 w-3"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Locked by you · {formatTimeSince(lockHolder.lockUnixTimestamp)}
                </span>
              )}
              {(hasSubmitted || savedConversations.size > 0 || hydratedActionsRef.current.size > 0) && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-purple-50 dark:bg-purple-900/30 px-2 py-0.5 text-[11px] font-medium text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-900/50 cursor-help"
                  title={isAdmin
                    ? 'Items awaiting your review. Mark each as Fast Track, Ignore, or Remove, then Finalize to notify the provider.'
                    : 'Items in review are awaiting feedback from RESO staff. You will get a notification when there are new items to follow up on.'}
                >
                  In Review
                </span>
              )}
              {hasSubmitted && job?.variationsReviewSubmittedAt && (
                <span
                  title={`Submitted at ${new Date(job.variationsReviewSubmittedAt).toLocaleString()}`}
                  className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900/50"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                    className="h-3 w-3"
                  >
                    <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
                  </svg>
                  Submitted {formatTimeSince(Math.floor(new Date(job.variationsReviewSubmittedAt).getTime() / 1000))}
                </span>
              )}
            </p>
            {/* Provenance: resolved org names + copyable IDs. Provider sees
                their own system + the recipient; admin sees all three.
                Long names wrap by design — readable beats truncated when
                space is available. */}
            {(report.providerUoi || report.providerUsi || report.recipientUoi) && (() => {
              const providerName = report.providerUoi ? lookupOrg(report.providerUoi) : undefined;
              const systemName = lookupSystem(report.providerUoi, report.providerUsi);
              const recipientName = report.recipientUoi ? lookupOrg(report.recipientUoi) : undefined;
              const hasAnyName = !!(providerName || systemName || recipientName);
              return (
                <div className="mt-2 space-y-1">
                  {hasAnyName && (
                    <div className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-1.5 flex-wrap">
                      {isAdmin && providerName && <span className="font-medium text-gray-700 dark:text-gray-300">{providerName}</span>}
                      {isAdmin && providerName && systemName && <span className="text-gray-400 dark:text-gray-500">·</span>}
                      {systemName && <span className="text-gray-700 dark:text-gray-300">{systemName}</span>}
                      {(providerName || systemName) && recipientName && <span className="text-gray-400 dark:text-gray-500">→</span>}
                      {recipientName && <span className="font-medium text-gray-700 dark:text-gray-300">{recipientName}</span>}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {isAdmin && report.providerUoi && (
                      <CopyableChip label="Provider" value={report.providerUoi} mono />
                    )}
                    {report.providerUsi && (
                      <CopyableChip label="USI" value={report.providerUsi} mono />
                    )}
                    {report.recipientUoi && (
                      <CopyableChip label="Recipient" value={report.recipientUoi} mono />
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isReadOnly && (
            <>
              {isDirty && (
                <>
                  <span className="text-xs text-amber-600 dark:text-amber-400">{unsavedCount} unsaved</span>
                  <button type="button" onClick={() => {
                    clearDraft(reportId);
                    setActions(new Map());
                    setDraftComments(new Map());
                    // Discarding drafts means giving up the editing claim,
                    // so release the lock for other reviewers.
                    void releaseMyLock();
                  }}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                    Discard
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => handleSave()}
                disabled={saving || !isDirty}
                title={!isDirty ? 'Take an action on at least one variation to enable submission' : undefined}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {saving
                  ? 'Saving...'
                  : hasSubmitted
                    ? 'Save Changes'
                    : 'Submit Review'}
              </button>
              {/* Finalize — admin only. Saves any pending edits and
                  flips the endorsement to 'resolved' in one call.
                  Fires VARIATIONS_RESOLVED notification on the
                  backend. Only meaningful once the review has been
                  submitted at least once (something to finalize). */}
              {isAdmin && hasSubmitted && (
                <button
                  type="button"
                  onClick={() => {
                    const ok = window.confirm('Finalize this review? This will mark it resolved and notify the provider. Any pending changes will be saved.');
                    if (ok) void handleSave({ finalize: true });
                  }}
                  disabled={saving}
                  title="Save any pending changes and close out this review."
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  {saving ? 'Finalizing...' : 'Finalize Review'}
                </button>
              )}
            </>
          )}
          <div className="text-xs text-gray-400 dark:text-gray-500">
            Match Sensitivity: {Math.round(report.fuzziness * 100)}%
          </div>
        </div>
      </div>

      {/* First-time instruction — appears only when the page is fresh
          (nothing submitted yet, no drafts taken). Disappears once the
          user starts triaging or has submitted before, so it doesn't
          nag seasoned reviewers. */}
      {!hasSubmitted && !isDirty && !isReadOnly && savedConversations.size === 0 && hydratedActionsRef.current.size === 0 && (
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
          Triage each variation below — click <strong>Ignore</strong>, <strong>Fast Track</strong>, or <strong>Remove</strong>. When you're done, click <strong>Submit Review</strong>.
        </p>
      )}

      {/* Filters: search left, filter pills + export pushed right. */}
      <div className="flex items-center gap-3 mb-4">
        <div className="min-w-[250px] flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by resource, field, or lookup..." />
        </div>
        <div className="flex items-center gap-1.5">
          {FILTER_TABS.map(tab => (
            <FilterPill key={tab.key} label={`${tab.label} (${filterCounts[tab.key] ?? 0})`} active={filter === tab.key} onClick={() => setFilter(tab.key)} />
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            const filename = `variations-${report.version ?? 'unknown'}-${new Date().toISOString().slice(0, 10)}.csv`;
            downloadVariationsCsv(filename, report.variations, actions);
          }}
          title="Export all variations (full set, ignoring current filter) as CSV"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
            <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Variations table */}
      {filtered.length === 0 ? (
        <p className="text-center py-8 text-sm text-gray-400 dark:text-gray-500">
          {search ? 'No matching variations.' : 'No variations to review.'}
        </p>
      ) : (
        <VariationsTable
          variations={filtered}
          actions={actions}
          selectedKey={selectedKey}
          draftComments={draftComments}
          savedConversations={savedConversations}
          isReadOnly={isReadOnly}
          isAdmin={isAdmin}
          onSelect={(variation) => setSelectedKey(variationKey(variation))}
          onToggleAction={toggleAction}
        />
      )}

      <VariationDrawer
        variation={selectedKey ? (filtered.find(v => variationKey(v) === selectedKey) ?? null) : null}
        action={selectedKey ? actions.get(selectedKey) : undefined}
        draftComments={selectedKey ? (draftComments.get(selectedKey) ?? []) : []}
        savedComments={selectedKey ? (savedConversations.get(selectedKey) ?? []) : []}
        isReadOnly={isReadOnly}
        isAdmin={isAdmin}
        userName={user?.fullName ?? user?.username ?? ''}
        userUoi={report.providerUoi ?? ''}
        onClose={() => setSelectedKey(null)}
        onToggleAction={(status) => selectedKey && toggleAction(selectedKey, status)}
        onAddComment={(comment) => selectedKey && addComment(selectedKey, comment)}
        onRemoveComment={(index) => selectedKey && removeComment(selectedKey, index)}
      />
    </div>
  );
};

// ── User roundel ─────────────────────────────────────────────────────

/** Initials avatar with an optional pulse ring — used in the lock banner
 *  to draw the eye to the contact card for the holder. */
const UserRoundel = ({ name, pulse }: { readonly name: string; readonly pulse?: boolean }) => {
  const initials = name
    .split(/\s+/)
    .map(p => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className="relative shrink-0">
      {pulse && (
        <span className="absolute inset-0 rounded-full bg-amber-400/40 dark:bg-amber-300/30 animate-ping" />
      )}
      <div className="relative w-9 h-9 rounded-full bg-amber-500 dark:bg-amber-600 text-white text-xs font-semibold flex items-center justify-center">
        {initials || '?'}
      </div>
    </div>
  );
};

/**
 * Small clickable chip that copies its value to the clipboard. Used
 * in the variations review header to surface UOI / USI / recipient
 * IDs in a way that's easy to grab when filing or referencing.
 */
const CopyableChip = ({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={copied ? 'Copied' : `Click to copy ${label}: ${value}`}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors ${mono ? 'font-mono' : ''}`}
    >
      <span className="text-[9px] uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</span>
      <span>{value}</span>
      {copied && (
        <svg className="w-3 h-3 text-green-600 dark:text-green-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
        </svg>
      )}
    </button>
  );
};

// ── Path rendering with diff highlighting ────────────────────────────

const PathDisplay = ({ parts, tone }: { readonly parts: ReadonlyArray<PathPart>; readonly tone: 'source' | 'target' }) => {
  const mutedClass = 'text-gray-400 dark:text-gray-500';
  const changedClass = tone === 'source'
    ? 'text-red-600 dark:text-red-400 font-semibold'
    : 'text-green-700 dark:text-green-400 font-semibold';
  return (
    <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-baseline">
          {i > 0 && <span className={mutedClass}>.</span>}
          <span className={part.changed ? changedClass : mutedClass}>{part.text}</span>
        </span>
      ))}
    </span>
  );
};

// ── Variations table row ─────────────────────────────────────────────

interface VariationRowProps {
  readonly variation: BlendedVariation;
  readonly action?: ActionStatus;
  readonly isSelected: boolean;
  readonly isReadOnly: boolean;
  readonly isAdmin: boolean;
  readonly hasDraftComments: boolean;
  /** Count of comments hydrated from the saved variations report. */
  readonly savedCommentCount: number;
  readonly onSelect: () => void;
  readonly onToggleAction: (status: ActionStatus) => void;
}

const VariationRow = ({ variation, action, isSelected, isReadOnly, isAdmin, hasDraftComments, savedCommentCount, onSelect, onToggleAction }: VariationRowProps) => {
  const primary = variation.suggestions[0];
  const diff = primary
    ? diffSegments(sourceSegments(variation), targetSegments(primary))
    : { source: sourceSegments(variation).filter((s): s is string => s != null).map(text => ({ text, changed: false })), target: [] };
  const extraCount = variation.suggestions.length > 1 ? variation.suggestions.length - 1 : 0;
  const strategyInfo = primary ? getStrategyMeta(primary.strategy) : null;
  const commentCount = (variation.conversations?.length ?? 0) + savedCommentCount + (hasDraftComments ? 1 : 0);

  return (
    <div
      className={`grid grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_140px_110px_180px] items-center gap-3 px-4 py-2 text-sm cursor-pointer transition-colors ${
        isSelected
          ? 'bg-blue-50 dark:bg-blue-900/20'
          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
      }`}
      onClick={onSelect}
      onKeyDown={e => { if (e.key === 'Enter') onSelect(); }}
      role="button"
      tabIndex={0}
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 capitalize min-w-0">
        {variation.type}
        {isAdmin && (variation.providerUoi || variation.recipientUoi) && (
          <div
            className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 truncate font-mono normal-case"
            title={`Provider UOI: ${variation.providerUoi ?? '—'}\nProvider USI: ${variation.providerUsi ?? '—'}\nRecipient UOI: ${variation.recipientUoi ?? '—'}\nDD version: ${variation.version ?? '—'}`}
          >
            {variation.providerUoi ?? '—'}<span className="mx-0.5 text-gray-300 dark:text-gray-600">→</span>{variation.recipientUoi ?? '—'}
          </div>
        )}
      </div>
      <div className="truncate"><PathDisplay parts={diff.source} tone="source" /></div>
      <div className="truncate">
        {primary
          ? <PathDisplay parts={diff.target} tone="target" />
          : <span className="text-xs text-gray-400 dark:text-gray-500">No suggestion</span>}
        {extraCount > 0 && <span className="ml-2 text-[10px] text-gray-400 dark:text-gray-500">+{extraCount} more</span>}
      </div>
      <div className="flex justify-center">
        {strategyInfo && (
          <span
            title={strategyInfo.description}
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full cursor-help ${strategyInfo.color}`}
          >
            {strategyInfo.label}
          </span>
        )}
      </div>
      <div className="flex items-center justify-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        {commentCount > 0 ? (
          <>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
              className="h-3.5 w-3.5"
            >
              <path
                fillRule="evenodd"
                d="M10 3.5c-3.866 0-7 2.351-7 5.25 0 1.498.83 2.84 2.137 3.788-.135.62-.42 1.276-.798 1.84a.5.5 0 0 0 .566.766c1.133-.343 2.087-.86 2.74-1.39A8.6 8.6 0 0 0 10 14c3.866 0 7-2.351 7-5.25S13.866 3.5 10 3.5Z"
                clipRule="evenodd"
              />
            </svg>
            <span className="tabular-nums">{commentCount}</span>
          </>
        ) : (
          <span>—</span>
        )}
      </div>
      <div className="flex items-center justify-center gap-1" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        {!isReadOnly ? (
          <>
            <button type="button" onClick={() => onToggleAction('ignored')}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors cursor-pointer ${action === 'ignored' ? 'bg-amber-600 text-white ring-1 ring-amber-400/60' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
              title="Mark as ignored">
              Ignore
            </button>
            {/* FT and Ignore are hints on the provider side and decisions
                on the admin side; both are visible to any reviewer. The
                final state is whatever the admin signs off on at submit. */}
            <button type="button" onClick={() => onToggleAction('fast-track')}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors cursor-pointer ${action === 'fast-track' ? 'bg-green-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
              title="Fast Track">
              FT
            </button>
            {isAdmin && (
              <button type="button" onClick={() => onToggleAction('remove')}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors cursor-pointer ${action === 'remove' ? 'bg-red-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400'}`}
                title="Remove (admin)">
                Remove
              </button>
            )}
          </>
        ) : <span className="text-xs text-gray-400 dark:text-gray-500">Read-only</span>}
      </div>
    </div>
  );
};

// ── Variations virtualized table ─────────────────────────────────────

interface VariationsTableProps {
  readonly variations: ReadonlyArray<BlendedVariation>;
  readonly actions: Map<string, ActionStatus>;
  readonly selectedKey: string | null;
  readonly draftComments: Map<string, ReadonlyArray<VariationComment>>;
  readonly savedConversations: Map<string, ReadonlyArray<VariationComment>>;
  readonly isReadOnly: boolean;
  readonly isAdmin: boolean;
  readonly onSelect: (variation: BlendedVariation) => void;
  readonly onToggleAction: (key: string, status: ActionStatus) => void;
}

const VariationsTable = ({ variations, actions, selectedKey, draftComments, savedConversations, isReadOnly, isAdmin, onSelect, onToggleAction }: VariationsTableProps) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: variations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 10,
  });

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
      <div className="grid grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_140px_110px_180px] gap-3 px-4 py-2 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
        <div>Type</div>
        <div>Source</div>
        <div>Suggested</div>
        <div className="text-center">Strategy</div>
        <div className="text-center">Comments</div>
        <div className="text-center">Actions</div>
      </div>
      <div ref={parentRef} className="max-h-[calc(100vh-320px)] overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map(vRow => {
            const variation = variations[vRow.index];
            const key = variationKey(variation);
            return (
              <div
                key={key}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vRow.start}px)` }}
                className="border-b border-gray-100 dark:border-gray-700/50 last:border-b-0"
              >
                <VariationRow
                  variation={variation}
                  action={actions.get(key)}
                  isSelected={selectedKey === key}
                  isReadOnly={isReadOnly}
                  isAdmin={isAdmin}
                  hasDraftComments={(draftComments.get(key)?.length ?? 0) > 0}
                  savedCommentCount={savedConversations.get(key)?.length ?? 0}
                  onSelect={() => onSelect(variation)}
                  onToggleAction={(status) => onToggleAction(key, status)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ── Variation drawer (slide-out detail panel) ────────────────────────

interface VariationDrawerProps {
  readonly variation: BlendedVariation | null;
  readonly action?: ActionStatus;
  readonly draftComments: ReadonlyArray<VariationComment>;
  /** Comments hydrated from the saved variations report on the backend. */
  readonly savedComments: ReadonlyArray<VariationComment>;
  readonly isReadOnly: boolean;
  readonly isAdmin: boolean;
  readonly userName: string;
  readonly userUoi: string;
  readonly onClose: () => void;
  readonly onToggleAction: (status: ActionStatus) => void;
  readonly onAddComment: (comment: VariationComment) => void;
  readonly onRemoveComment: (index: number) => void;
}

const VariationDrawer = ({ variation, action, draftComments, savedComments, isReadOnly, isAdmin, userName, userUoi, onClose, onToggleAction, onAddComment, onRemoveComment }: VariationDrawerProps) => {
  // Close on Escape
  useEffect(() => {
    if (!variation) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [variation, onClose]);

  if (!variation) return null;

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
      <div className="fixed top-0 right-0 h-full w-[480px] bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 shadow-xl z-40 flex flex-col">
        <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-5 py-4 flex items-center justify-between shrink-0">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-0.5 capitalize">{variation.type} variation</div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Variation Detail</h2>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-2xl leading-none cursor-pointer" aria-label="Close">×</button>
        </div>

        <div className="flex-1 flex flex-col min-h-0">
          {/* Top section: variation context (Source / Provenance /
              Suggestions / Actions). Owns its own vertical scroll
              when content overflows. Natural-height by default so
              the comments panel below stays anchored to the
              bottom of the drawer rather than getting pushed off-
              screen by a tall top section. */}
          <div className="px-5 pt-5 pb-3 flex flex-col gap-4 overflow-y-auto min-h-0">
          {/* Source */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">Local value</div>
            <div className="text-base">
              <PathDisplay parts={sourceSegments(variation).filter((s): s is string => s != null).map(text => ({ text, changed: true }))} tone="source" />
            </div>
          </div>

          {/* Provenance — admin only. Shows where this variation came from
              so admins can route follow-ups to the right provider. */}
          {isAdmin && (variation.providerUoi || variation.providerUsi || variation.recipientUoi || variation.version) && (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 p-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Provenance</div>
              <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                {variation.providerUoi && <>
                  <dt className="text-gray-500 dark:text-gray-400">Provider UOI</dt>
                  <dd className="font-mono text-gray-800 dark:text-gray-200 truncate" title={variation.providerUoi}>{variation.providerUoi}</dd>
                </>}
                {variation.providerUsi && <>
                  <dt className="text-gray-500 dark:text-gray-400">Provider USI</dt>
                  <dd className="font-mono text-gray-800 dark:text-gray-200 truncate" title={variation.providerUsi}>{variation.providerUsi}</dd>
                </>}
                {variation.recipientUoi && <>
                  <dt className="text-gray-500 dark:text-gray-400">Recipient UOI</dt>
                  <dd className="font-mono text-gray-800 dark:text-gray-200 truncate" title={variation.recipientUoi}>{variation.recipientUoi}</dd>
                </>}
                {variation.version && <>
                  <dt className="text-gray-500 dark:text-gray-400">DD version</dt>
                  <dd className="font-mono text-gray-800 dark:text-gray-200">{variation.version}</dd>
                </>}
              </dl>
            </div>
          )}

          {/* Suggestions */}
          {variation.suggestions.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                Suggested mapping{variation.suggestions.length > 1 ? `s (${variation.suggestions.length})` : ''}
              </div>
              <div className="space-y-2">
                {variation.suggestions.map((suggestion, i) => {
                  const diff = diffSegments(sourceSegments(variation), targetSegments(suggestion));
                  const strategyInfo = getStrategyMeta(suggestion.strategy);
                  return (
                    <div key={i} className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="min-w-0 flex-1">
                          <PathDisplay parts={diff.target} tone="target" />
                        </div>
                        <span
                          title={strategyInfo.description}
                          className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 cursor-help ${strategyInfo.color}`}
                        >
                          {strategyInfo.label}
                        </span>
                      </div>
                      {suggestion.suggestedRelatedFieldName && (
                        <div className="text-xs text-purple-600 dark:text-purple-400 mb-2">
                          + Related: {suggestion.suggestedRelatedResourceName ?? variation.resourceName}.{suggestion.suggestedRelatedFieldName}
                          {suggestion.suggestedRelatedLookupValue && `.${suggestion.suggestedRelatedLookupValue}`}
                        </div>
                      )}
                      {suggestion.ddWikiUrl && (
                        <a
                          href={suggestion.ddWikiUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          DD reference
                          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clipRule="evenodd" />
                            <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clipRule="evenodd" />
                          </svg>
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-400 dark:text-gray-500">No suggestions available</div>
          )}

          {/* Actions */}
          {!isReadOnly && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Actions</div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => onToggleAction('ignored')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${action === 'ignored' ? 'bg-amber-600 text-white ring-1 ring-amber-400/60' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}>
                  Ignore
                </button>
                <button type="button" onClick={() => onToggleAction('fast-track')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${action === 'fast-track' ? 'bg-green-600 text-white' : 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/50'}`}>
                  Fast Track
                </button>
                {isAdmin && (
                  <button type="button" onClick={() => onToggleAction('remove')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${action === 'remove' ? 'bg-red-600 text-white' : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50'}`}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}

          </div>
          {/* Comments panel — permanently visible, anchored to the
              bottom of the drawer. Merge live conversations (from
              the blended report) with saved ones (from the persisted
              variations report) so prior comments don't vanish on
              reopen. */}
          <div className="flex-1 min-h-0 flex flex-col border-t border-gray-200 dark:border-gray-700">
            <VariationComments
              existingComments={[...(variation.conversations ?? []), ...savedComments]}
              draftComments={draftComments}
              onAddComment={onAddComment}
              onRemoveComment={onRemoveComment}
              userName={userName}
              userUoi={userUoi}
              isReadOnly={isReadOnly}
            />
          </div>
        </div>
      </div>
    </>
  );
};

