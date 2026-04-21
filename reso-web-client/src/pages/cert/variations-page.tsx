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

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useLocation, useBlocker } from 'react-router';
import { SearchInput, FilterPill } from '../../components/metadata/shared';
import { blendVariations, type BlendedVariation, type BlendedVariationsReport } from '../../services/variations-blender';
import { searchVariations, getVariationsStats } from '../../services/variations-service';
import { saveVariationsReview } from '../../services/variations-save';
import { VariationComments, type VariationComment } from '../../components/cert/variation-comments';
import { useAuth } from '../../hooks/use-auth';

// ── Constants ────────────────────────────────────────────────────────

/** Emails authorized for Fast Track management (must also be admin). */
const FT_ADMIN_EMAILS = new Set(['josh@reso.org', 'jason@reso.org']);

// ── Types ────────────────────────────────────────────────────────────

type VariationFilter = 'all' | 'fields' | 'lookups' | 'resources' | 'expansions';
type ActionStatus = 'pending' | 'ignored' | 'fast-track' | 'remove';
type ViewMode = 'list' | 'detail';

interface DraftAction {
  readonly key: string;
  readonly status: ActionStatus;
}

interface ReviewSummary {
  readonly version: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly recipientName?: string;
  readonly providerName?: string;
  readonly totalVariations: number;
  readonly resolved: number;
  readonly inReview: number;
  readonly ignored: number;
  readonly fastTrack: number;
  readonly reviewStartedAt?: string;
  readonly lastActivityAt?: string;
  readonly status: 'active' | 'stale' | 'resolved';
}

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
  `${v.resourceName}:${v.fieldName ?? ''}:${v.lookupValue ?? ''}`;

const STRATEGY_LABELS: Readonly<Record<string, { label: string; color: string }>> = {
  'Substring': { label: 'Substring Match', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  'Edit Distance': { label: 'Edit Distance', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
  'Fast Track': { label: 'Fast Track', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' },
  'Admin Review': { label: 'Admin Review', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  'Suggestion': { label: 'Suggestion', color: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
  'Policy': { label: 'Policy', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
};

const STATUS_COLORS: Readonly<Record<string, string>> = {
  active: 'bg-green-400',
  stale: 'bg-amber-400',
  resolved: 'bg-gray-300 dark:bg-gray-600',
};

// ── Draft localStorage ───────────────────────────────────────────────

const DRAFT_KEY_PREFIX = 'variations-draft:';
const REPORT_CACHE_KEY = 'variations-active-report';

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

const cacheReport = (report: BlendedVariationsReport): void =>
  localStorage.setItem(REPORT_CACHE_KEY, JSON.stringify(report));

const loadCachedReport = (): BlendedVariationsReport | null => {
  try {
    const raw = localStorage.getItem(REPORT_CACHE_KEY);
    return raw ? JSON.parse(raw) as BlendedVariationsReport : null;
  } catch { return null; }
};

// ── Main Component ───────────────────────────────────────────────────

export const VariationsPage = () => {
  const location = useLocation();
  const { ensureFreshProviderToken, isAuthenticated, isAdmin, user } = useAuth();
  const routeState = location.state as { job?: Record<string, unknown>; report?: BlendedVariationsReport } | null;

  const [report, setReport] = useState<BlendedVariationsReport | null>(() => {
    if (routeState?.report) return routeState.report;
    return loadCachedReport();
  });
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewMode>(report ? 'detail' : 'list');

  // When a job arrives via route state, extract variations and blend with service suggestions
  useEffect(() => {
    if (routeState?.report) {
      setReport(routeState.report);
      cacheReport(routeState.report);
      setView('detail');
      window.history.replaceState({}, '');
      return;
    }

    const job = routeState?.job;
    if (!job) return;

    const variationsReport = (job.reports as Record<string, unknown>)?.variationsReport as Record<string, unknown> | undefined;
    if (!variationsReport) return;

    setLoading(true);

    // Attempt to fetch service suggestions and blend
    const fetchAndBlend = async () => {
      try {
        const localReport = variationsReport as unknown as Parameters<typeof blendVariations>[0];
        let serviceSuggestions = {};

        if (isAuthenticated) {
          try {
            const token = await ensureFreshProviderToken();
            const metadataReport = (job.reports as Record<string, unknown>)?.metadataReport as { fields: unknown[]; lookups: unknown[] } | undefined;
            if (metadataReport) {
              const result = await searchVariations(metadataReport as Parameters<typeof searchVariations>[0], token);
              serviceSuggestions = result.mappings ?? {};
            }
          } catch { /* Not authenticated or token expired — use local only */ }
        }

        const blended = {
          ...blendVariations(localReport, serviceSuggestions),
          providerUoi: job.providerUoi as string | undefined,
          providerUsi: job.providerUsi as string | undefined,
          recipientUoi: job.recipientUoi as string | undefined,
        };
        setReport(blended);
        cacheReport(blended);
        setView('detail');
      } catch {
        // If service is unavailable, use local results only
        const blended = {
          ...blendVariations(variationsReport as unknown as Parameters<typeof blendVariations>[0]),
          providerUoi: job.providerUoi as string | undefined,
          providerUsi: job.providerUsi as string | undefined,
          recipientUoi: job.recipientUoi as string | undefined,
        };
        setReport(blended);
        cacheReport(blended);
        setView('detail');
      } finally {
        setLoading(false);
        window.history.replaceState({}, '');
      }
    };

    fetchAndBlend();
  }, [routeState, isAuthenticated, ensureFreshProviderToken]);

  if (loading) {
    return (
      <div className={`${PAGE_CONTAINER} py-12 text-center`}>
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 mr-2" />
        <span className="text-sm text-gray-500 dark:text-gray-400">Loading variations and fetching suggestions...</span>
      </div>
    );
  }

  if (view === 'list' || !report) {
    return <ReviewListView
      onSelectReport={(r) => { setReport(r); cacheReport(r); setView('detail'); }}
      ensureFreshToken={ensureFreshProviderToken}
      isAuthenticated={isAuthenticated}
    />;
  }

  return <ReviewDetailView report={report} onBack={() => setView('list')} ensureFreshToken={ensureFreshProviderToken} user={user} isAdmin={isAdmin} />;
};

// ── Review List View ─────────────────────────────────────────────────

interface VariationsStats {
  readonly resources?: number;
  readonly fields?: number;
  readonly lookups?: number;
  readonly suggestions?: number;
  readonly ignored?: number;
  readonly fastTrack?: number;
  readonly adminReview?: number;
  readonly inReview?: number;
  readonly stale?: number;
  readonly resolved?: number;
  readonly byResource?: ReadonlyArray<{
    readonly resourceName: string;
    readonly fields: number;
    readonly lookups: number;
    readonly suggestions: number;
    readonly inReview: number;
    readonly ignored: number;
    readonly fastTrack: number;
  }>;
}

const ReviewListView = ({ onSelectReport, ensureFreshToken, isAuthenticated }: {
  readonly onSelectReport: (report: BlendedVariationsReport) => void;
  readonly ensureFreshToken: () => Promise<string>;
  readonly isAuthenticated: boolean;
}) => {
  const [stats, setStats] = useState<VariationsStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    setLoading(true);
    ensureFreshToken()
      .then(token => getVariationsStats(token))
      .then(data => { if (data) setStats(data as VariationsStats); })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load variations stats'))
      .finally(() => setLoading(false));
  }, [isAuthenticated, ensureFreshToken]);

  const activeResources = stats?.byResource?.filter(r => r.inReview > 0 || r.suggestions > 0) ?? [];

  return (
    <div className={`${PAGE_CONTAINER} py-6`}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Variations Reviews</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Active reviews and their status. Run a DD certification test to start a new review.
        </p>
      </div>

      {/* Summary tiles */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">In Review</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{stats.inReview ?? 0}</p>
          </div>
          <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Fast Track</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-green-600 dark:text-green-400">{stats.fastTrack ?? 0}</p>
          </div>
          <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Ignored</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-gray-500 dark:text-gray-400">{stats.ignored ?? 0}</p>
          </div>
          <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Resolved</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-blue-600 dark:text-blue-400">{stats.resolved ?? 0}</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500 py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
          Loading variations stats...
        </div>
      )}

      {error && (
        <p className="text-sm text-red-500 dark:text-red-400 py-4">{error}</p>
      )}

      {!loading && !isAuthenticated && (
        <div className="text-center py-16">
          <p className="text-gray-400 dark:text-gray-500">Sign in to view active variations reviews.</p>
        </div>
      )}

      {!loading && isAuthenticated && activeResources.length === 0 && !error && (
        <div className="text-center py-16">
          <p className="text-gray-400 dark:text-gray-500">
            No active reviews. Run a DD certification test with variations enabled to begin.
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
            Reviews appear here automatically after a test detects variations in your metadata.
          </p>
        </div>
      )}

      {activeResources.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {activeResources.map(resource => (
            <div key={resource.resourceName} className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4 hover:border-blue-300 dark:hover:border-blue-600 transition-colors">
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{resource.resourceName}</h3>
              <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400">
                <span>{resource.fields} fields</span>
                <span>{resource.lookups} lookups</span>
                <span>{resource.suggestions} suggestions</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                {resource.inReview > 0 && (
                  <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                    {resource.inReview} in review
                  </span>
                )}
                {resource.fastTrack > 0 && (
                  <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    {resource.fastTrack} fast track
                  </span>
                )}
                {resource.ignored > 0 && (
                  <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                    {resource.ignored} ignored
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Review Detail View ───────────────────────────────────────────────

const ReviewDetailView = ({ report, onBack, ensureFreshToken, user, isAdmin }: {
  readonly report: BlendedVariationsReport;
  readonly onBack: () => void;
  readonly ensureFreshToken: () => Promise<string>;
  readonly user: { readonly username: string; readonly email: string; readonly fullName: string } | null;
  readonly isAdmin: boolean;
}) => {
  const reportId = `${report.version}`;

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<VariationFilter>('all');
  const [actions, setActions] = useState<Map<string, ActionStatus>>(() => loadDraft(reportId));
  const [draftComments, setDraftComments] = useState<Map<string, ReadonlyArray<VariationComment>>>(new Map());
  const [saving, setSaving] = useState(false);

  useEffect(() => { saveDraft(reportId, actions); }, [actions, reportId]);

  const isDirty = actions.size > 0 || draftComments.size > 0;
  useBlocker(isDirty && !saving);

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
          (s.suggestedLookupValue?.toLowerCase().includes(q) ?? false)
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

  const addComment = useCallback((key: string, comment: VariationComment) => {
    setDraftComments(prev => {
      const next = new Map(prev);
      next.set(key, [...(prev.get(key) ?? []), comment]);
      return next;
    });
  }, []);

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

  const toggleAction = useCallback((key: string, status: ActionStatus) => {
    setActions(prev => {
      const next = new Map(prev);
      if (next.get(key) === status) next.delete(key);
      else next.set(key, status);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (actions.size === 0) return;
    if (!report.providerUoi || !report.providerUsi || !report.recipientUoi) return;

    setSaving(true);
    try {
      const token = await ensureFreshToken();
      const success = await saveVariationsReview({
        version: report.version,
        providerUoi: report.providerUoi,
        providerUsi: report.providerUsi,
        recipientUoi: report.recipientUoi,
        actions: [...actions.entries()].map(([key, status]) => ({ key, status })),
        comments: [...draftComments.entries()].flatMap(([variationKey, comments]) =>
          comments.map(c => ({ variationKey, ...c }))
        ),
        userName: user?.fullName ?? user?.username ?? '',
        userEmail: user?.email ?? '',
        token,
      });

      if (success) {
        clearDraft(reportId);
        setActions(new Map());
        setDraftComments(new Map());
      }
    } finally {
      setSaving(false);
    }
  }, [actions, reportId, report, ensureFreshToken]);

  return (
    <div className={`${PAGE_CONTAINER} py-6`}>
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
            <p className="text-sm text-gray-500 dark:text-gray-400">
              DD {report.version} — {report.counts.total} variation{report.counts.total !== 1 ? 's' : ''}
              {report.counts.ignored > 0 && ` (${report.counts.ignored} ignored)`}
              {report.counts.fastTrack > 0 && ` (${report.counts.fastTrack} fast track)`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <>
              <span className="text-xs text-amber-600 dark:text-amber-400">{actions.size} unsaved</span>
              <button type="button" onClick={() => { clearDraft(reportId); setActions(new Map()); }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                Discard
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </>
          )}
          <div className="text-xs text-gray-400 dark:text-gray-500">
            Match Sensitivity: {Math.round(report.fuzziness * 100)}%
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="min-w-[250px]">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by resource, field, or lookup..." />
        </div>
        <div className="flex items-center gap-1.5">
          {FILTER_TABS.map(tab => (
            <FilterPill key={tab.key} label={`${tab.label} (${filterCounts[tab.key] ?? 0})`} active={filter === tab.key} onClick={() => setFilter(tab.key)} />
          ))}
        </div>
      </div>

      {/* Variations list */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <p className="text-center py-8 text-sm text-gray-400 dark:text-gray-500">
            {search ? 'No matching variations.' : 'No variations to review.'}
          </p>
        )}
        {filtered.map(variation => {
          const key = variationKey(variation);
          return (
            <VariationCard
              key={key}
              variation={variation}
              action={actions.get(key)}
              onToggleAction={(status) => toggleAction(key, status)}
              isReadOnly={false}
              isAdmin={isAdmin}
              isFastTrackAdmin={isAdmin && FT_ADMIN_EMAILS.has(user?.email ?? '')}
              draftComments={draftComments.get(key) ?? []}
              onAddComment={(comment) => addComment(key, comment)}
              onRemoveComment={(index) => removeComment(key, index)}
              userName={user?.fullName ?? user?.username ?? ''}
              userUoi={report.providerUoi ?? ''}
            />
          );
        })}
      </div>
    </div>
  );
};

// ── Variation Card ───────────────────────────────────────────────────

const VariationCard = ({
  variation, action, onToggleAction, isReadOnly, isAdmin, isFastTrackAdmin, draftComments, onAddComment, onRemoveComment, userName, userUoi,
}: {
  readonly variation: BlendedVariation;
  readonly action?: ActionStatus;
  readonly onToggleAction: (status: ActionStatus) => void;
  readonly isReadOnly: boolean;
  readonly isAdmin: boolean;
  readonly isFastTrackAdmin: boolean;
  readonly draftComments: ReadonlyArray<VariationComment>;
  readonly onAddComment: (comment: VariationComment) => void;
  readonly onRemoveComment: (index: number) => void;
  readonly userName: string;
  readonly userUoi: string;
}) => {
  const isIgnored = variation.ignored || action === 'ignored';

  return (
    <div className={`rounded-lg border overflow-hidden ${isIgnored ? 'border-gray-200 dark:border-gray-700 opacity-60' : 'border-red-200 dark:border-red-800'}`}>
      <div className={`px-4 py-2.5 flex items-center justify-between ${isIgnored ? 'bg-gray-50 dark:bg-gray-800/50' : 'bg-red-50 dark:bg-red-900/20'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">{variation.type}</span>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{variation.resourceName}</span>
          {variation.fieldName && (<><span className="text-gray-400">.</span><span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{variation.fieldName}</span></>)}
          {variation.lookupValue && (<><span className="text-gray-400">.</span><span className="text-sm font-medium text-red-700 dark:text-red-400">{variation.lookupValue}</span></>)}
        </div>
        {!isReadOnly && (
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" onClick={() => onToggleAction('ignored')}
              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors cursor-pointer ${action === 'ignored' ? 'bg-gray-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
              title="Mark as ignored — this local value is intentional">
              Ignore
            </button>
            {isFastTrackAdmin && (
              <button type="button" onClick={() => onToggleAction('fast-track')}
                className={`px-2 py-1 text-[10px] font-medium rounded transition-colors cursor-pointer ${action === 'fast-track' ? 'bg-green-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                title="Fast Track — add to DD workgroup agenda for expedited review">
                Fast Track
              </button>
            )}
            {isAdmin && (
              <button type="button" onClick={() => onToggleAction('remove')}
                className={`px-2 py-1 text-[10px] font-medium rounded transition-colors cursor-pointer ${action === 'remove' ? 'bg-red-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400'}`}
                title="Remove — delete this mapping from the service (admin only)">
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      {!isIgnored && variation.suggestions.length > 0 && (
        <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
          {variation.suggestions.map((suggestion, i) => {
            const strategyInfo = STRATEGY_LABELS[suggestion.strategy] ?? STRATEGY_LABELS['Suggestion'];
            return (
              <div key={i} className="px-4 py-2 flex items-center justify-between bg-white dark:bg-gray-800/30">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-300 dark:text-gray-600">→</span>
                  <span className="text-sm text-green-700 dark:text-green-400">
                    {suggestion.suggestedResourceName}
                    {suggestion.suggestedFieldName && `.${suggestion.suggestedFieldName}`}
                    {suggestion.suggestedLookupValue && `.${suggestion.suggestedLookupValue}`}
                  </span>
                  {suggestion.suggestedRelatedFieldName && (
                    <span className="text-xs text-purple-600 dark:text-purple-400">
                      + {suggestion.suggestedRelatedFieldName}
                      {suggestion.suggestedRelatedLookupValue && `.${suggestion.suggestedRelatedLookupValue}`}
                    </span>
                  )}
                </div>
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${strategyInfo.color}`}>
                  {strategyInfo.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {!isIgnored && variation.suggestions.length === 0 && (
        <div className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500 bg-white dark:bg-gray-800/30">
          No suggestions available
        </div>
      )}
      <VariationComments
        existingComments={variation.conversations ?? []}
        draftComments={draftComments}
        onAddComment={onAddComment}
        onRemoveComment={onRemoveComment}
        userName={userName}
        userUoi={userUoi}
        isReadOnly={isReadOnly}
      />
    </div>
  );
};
