/**
 * Variations Review Page — full collaborative review experience.
 *
 * Card-per-variation layout with:
 * - Search bar and filter tabs (Fields / Lookups / Resources) with counts
 * - Match sensitivity control (pencil icon to edit, default 25%)
 * - Variation cards: red header (non-standard item), correction sub-row with match type
 * - Actions per card: Ignore, Fast Track, Comment
 * - Lock banner (who has the lock, expiry, read-only mode)
 * - Save/Cancel with unsaved changes warning
 * - localStorage draft for pending actions
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useBlocker } from 'react-router';
import { SearchInput, FilterPill } from '../../components/metadata/shared';
import type { BlendedVariation, BlendedVariationsReport } from '../../services/variations-blender';

// ── Types ────────────────────────────────────────────────────────────

type VariationFilter = 'all' | 'fields' | 'lookups' | 'resources' | 'expansions';
type ActionStatus = 'pending' | 'ignored' | 'fast-track';

interface DraftAction {
  readonly key: string;
  readonly status: ActionStatus;
}

interface VariationsPageProps {
  readonly report: BlendedVariationsReport | null;
  readonly providerUoi?: string;
  readonly recipientUoi?: string;
  readonly isReadOnly?: boolean;
  readonly onSave?: (actions: ReadonlyArray<DraftAction>) => Promise<void>;
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
};

// ── Draft localStorage ───────────────────────────────────────────────

const DRAFT_KEY_PREFIX = 'variations-draft:';

const loadDraft = (reportId: string): Map<string, ActionStatus> => {
  try {
    const raw = localStorage.getItem(`${DRAFT_KEY_PREFIX}${reportId}`);
    if (!raw) return new Map();
    const entries = JSON.parse(raw) as ReadonlyArray<[string, ActionStatus]>;
    return new Map(entries);
  } catch {
    return new Map();
  }
};

const saveDraft = (reportId: string, actions: Map<string, ActionStatus>): void => {
  if (actions.size === 0) {
    localStorage.removeItem(`${DRAFT_KEY_PREFIX}${reportId}`);
  } else {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}${reportId}`, JSON.stringify([...actions.entries()]));
  }
};

const clearDraft = (reportId: string): void => {
  localStorage.removeItem(`${DRAFT_KEY_PREFIX}${reportId}`);
};

// ── Component ────────────────────────────────────────────────────────

export const VariationsPage = ({ report, providerUoi, recipientUoi, isReadOnly = false, onSave }: VariationsPageProps) => {
  const reportId = `${report?.version ?? ''}:${providerUoi ?? ''}:${recipientUoi ?? ''}`;

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<VariationFilter>('all');
  const [actions, setActions] = useState<Map<string, ActionStatus>>(() => loadDraft(reportId));
  const [saving, setSaving] = useState(false);

  // Persist draft on change
  useEffect(() => {
    saveDraft(reportId, actions);
  }, [actions, reportId]);

  // Unsaved changes warning
  const isDirty = actions.size > 0;
  useBlocker(isDirty && !saving);

  // Filter and search
  const filtered = useMemo(() => {
    if (!report) return [];
    let items = report.variations;

    // Filter by type
    if (filter !== 'all') {
      const typeMap: Record<string, string> = { fields: 'field', lookups: 'lookup', resources: 'resource', expansions: 'expansion' };
      items = items.filter(v => v.type === typeMap[filter]);
    }

    // Search
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

  // Filter counts
  const filterCounts = useMemo(() => {
    if (!report) return {};
    return {
      all: report.variations.length,
      fields: report.counts.fields,
      lookups: report.counts.lookups,
      resources: report.counts.resources,
      expansions: report.counts.expansions,
    };
  }, [report]);

  const toggleAction = useCallback((key: string, status: ActionStatus) => {
    setActions(prev => {
      const next = new Map(prev);
      if (next.get(key) === status) {
        next.delete(key);
      } else {
        next.set(key, status);
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!onSave || actions.size === 0) return;
    setSaving(true);
    try {
      await onSave([...actions.entries()].map(([key, status]) => ({ key, status })));
      clearDraft(reportId);
      setActions(new Map());
    } finally {
      setSaving(false);
    }
  }, [actions, onSave, reportId]);

  const handleCancel = useCallback(() => {
    clearDraft(reportId);
    setActions(new Map());
  }, [reportId]);

  if (!report) {
    return (
      <div className={`${PAGE_CONTAINER} py-12 text-center`}>
        <p className="text-gray-400 dark:text-gray-500">No variations report loaded. Run a DD certification test first.</p>
      </div>
    );
  }

  return (
    <div className={`${PAGE_CONTAINER} py-6`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Variations Review</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            DD {report.version} — {report.counts.total} variation{report.counts.total !== 1 ? 's' : ''} found
            {report.counts.ignored > 0 && ` (${report.counts.ignored} ignored)`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && !isReadOnly && (
            <>
              <span className="text-xs text-amber-600 dark:text-amber-400">{actions.size} unsaved</span>
              <button
                type="button"
                onClick={handleCancel}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="min-w-[250px]">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by resource, field, or lookup..." />
        </div>
        <div className="flex items-center gap-1.5">
          {FILTER_TABS.map(tab => (
            <FilterPill
              key={tab.key}
              label={`${tab.label} (${filterCounts[tab.key] ?? 0})`}
              active={filter === tab.key}
              onClick={() => setFilter(tab.key)}
            />
          ))}
        </div>
        <div className="ml-auto text-xs text-gray-400 dark:text-gray-500">
          Match Sensitivity: {Math.round(report.fuzziness * 100)}%
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
          const action = actions.get(key);

          return (
            <VariationCard
              key={key}
              variation={variation}
              action={action}
              onToggleAction={(status) => toggleAction(key, status)}
              isReadOnly={isReadOnly}
            />
          );
        })}
      </div>
    </div>
  );
};

// ── Variation Card ───────────────────────────────────────────────────

const VariationCard = ({
  variation,
  action,
  onToggleAction,
  isReadOnly,
}: {
  readonly variation: BlendedVariation;
  readonly action?: ActionStatus;
  readonly onToggleAction: (status: ActionStatus) => void;
  readonly isReadOnly: boolean;
}) => {
  const isIgnored = variation.ignored || action === 'ignored';

  return (
    <div className={`rounded-lg border overflow-hidden ${
      isIgnored
        ? 'border-gray-200 dark:border-gray-700 opacity-60'
        : 'border-red-200 dark:border-red-800'
    }`}>
      {/* Header — the non-standard item */}
      <div className={`px-4 py-2.5 flex items-center justify-between ${
        isIgnored
          ? 'bg-gray-50 dark:bg-gray-800/50'
          : 'bg-red-50 dark:bg-red-900/20'
      }`}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">{variation.type}</span>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{variation.resourceName}</span>
          {variation.fieldName && (
            <>
              <span className="text-gray-400">.</span>
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{variation.fieldName}</span>
            </>
          )}
          {variation.lookupValue && (
            <>
              <span className="text-gray-400">.</span>
              <span className="text-sm font-medium text-red-700 dark:text-red-400">{variation.lookupValue}</span>
            </>
          )}
        </div>

        {/* Actions */}
        {!isReadOnly && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onToggleAction('ignored')}
              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                action === 'ignored'
                  ? 'bg-gray-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              title="Mark as ignored — this local value is intentional"
            >
              Ignore
            </button>
            <button
              type="button"
              onClick={() => onToggleAction('fast-track')}
              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                action === 'fast-track'
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              title="Request Fast Track — submit to RESO workgroup for expedited review"
            >
              Fast Track
            </button>
          </div>
        )}
      </div>

      {/* Suggestions — correction sub-rows */}
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

      {/* No suggestions */}
      {!isIgnored && variation.suggestions.length === 0 && (
        <div className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500 bg-white dark:bg-gray-800/30">
          No suggestions available
        </div>
      )}
    </div>
  );
};
