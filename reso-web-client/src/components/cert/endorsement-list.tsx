import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { EndorsementStatus } from '../../api/cert-fixtures';
import { useAuth } from '../../hooks/use-auth';
import { useCertificationCounts } from '../../hooks/use-certification-counts';
import { useEndorsements } from '../../hooks/use-endorsements';
import { useInfiniteScroll } from '../../hooks/use-infinite-scroll';
import { ActiveFilters, type ActiveFilterPillSpec } from '../filters/active-filters';
import {
  DateRangePresets,
  datePresetLabel,
  type DateRangePreset
} from '../filters/date-range-presets';
import { FacetGroup, type FacetOption } from '../filters/facet-group';
import {
  FilterDrawer,
  FilterToggleButton
} from '../filters/filter-disclosure';
import { SearchInput } from '../filters/search-input';
import { SortDropdown, type SortOption } from '../filters/sort-dropdown';
import { EndorsementRow } from './endorsement-row';
import { SourceBadge } from './source-badge';
import { statusLabel } from './status-pill';

// ── Endorsement catalog ──────────────────────────────────────────────────

interface EndorsementGroup {
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly items: ReadonlyArray<{ readonly key: string; readonly label: string }>;
}

const ENDORSEMENT_GROUPS: ReadonlyArray<EndorsementGroup> = [
  {
    groupKey: 'data_dictionary',
    groupLabel: 'Data Dictionary',
    items: [
      { key: 'data_dictionary_1.7', label: '1.7' },
      { key: 'data_dictionary_2.0', label: '2.0' },
      { key: 'data_dictionary_2.1', label: '2.1' }
    ]
  },
  {
    groupKey: 'web_api_server_core',
    groupLabel: 'Web API Server',
    items: [
      { key: 'web_api_server_core_2.0.0', label: '2.0.0' },
      { key: 'web_api_server_core_2.1.0', label: '2.1.0' }
    ]
  },
  {
    groupKey: 'reso_common_format',
    groupLabel: 'Common Format',
    items: [
      { key: 'reso_common_format_1.7', label: '1.7' },
      { key: 'reso_common_format_2.0', label: '2.0' }
    ]
  },
  {
    groupKey: 'add_edit',
    groupLabel: 'Add/Edit',
    items: [{ key: 'add_edit_1.0.0', label: '1.0.0' }]
  },
  {
    groupKey: 'webhooks',
    groupLabel: 'Webhooks',
    items: [{ key: 'webhooks_1.0.0', label: '1.0.0' }]
  }
];

const endorsementKeyLabel = (key: string): string => {
  for (const g of ENDORSEMENT_GROUPS) {
    const item = g.items.find((i) => i.key === key);
    if (item) return `${g.groupLabel} ${item.label}`;
  }
  return key;
};

// ── Status grouping ──────────────────────────────────────────────────────

const PUBLIC_DEFAULT_STATUSES: ReadonlyArray<EndorsementStatus> = [
  'certified',
  'recipient_notified',
  'passed'
];

const ADVANCED_STATUSES: ReadonlyArray<EndorsementStatus> = [
  'in_review',
  'in_progress',
  'failed',
  'canceled',
  'withdrawn',
  'revoked'
];

// ── Sort options ─────────────────────────────────────────────────────────

type SortValue = 'recent' | 'oldest' | 'name-az' | 'name-za';

interface SortSpec extends SortOption<SortValue> {
  readonly sortBy: 'asc' | 'desc';
  readonly sortByTimestamp: boolean;
}

const SORT_OPTIONS: ReadonlyArray<SortSpec> = [
  { value: 'recent',  label: 'Most recent', sortBy: 'desc', sortByTimestamp: true  },
  { value: 'oldest',  label: 'Oldest',      sortBy: 'asc',  sortByTimestamp: true  },
  { value: 'name-az', label: 'Name A→Z',    sortBy: 'asc',  sortByTimestamp: false },
  { value: 'name-za', label: 'Name Z→A',    sortBy: 'desc', sortByTimestamp: false }
];

const DEFAULT_SORT = SORT_OPTIONS[0];

// ── URL state helpers ────────────────────────────────────────────────────

const paramSet = (raw: string | null): Set<string> =>
  new Set((raw ?? '').split(',').filter(Boolean));

const setToParam = (s: ReadonlySet<string>): string | null => {
  const arr = Array.from(s);
  return arr.length > 0 ? arr.join(',') : null;
};

// ── Component ────────────────────────────────────────────────────────────

interface EndorsementListProps {
  /** Container width class — supplied by the page so all chrome (sticky
   *  header, content) lines up to the same gutter. */
  readonly containerClassName?: string;
}

export const EndorsementList = ({
  containerClassName = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8'
}: EndorsementListProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const isSignedIn = Boolean(user);
  const isAdmin = Boolean(user?.isAdmin);
  const searchPlaceholder = isAdmin
    ? 'Search by provider or recipient name'
    : 'Search by recipient name';

  const [searchInput, setSearchInput] = useState(
    () => searchParams.get('q') ?? ''
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const activeEndorsements = paramSet(searchParams.get('endorsement'));
  const activeStatuses = paramSet(searchParams.get('status')) as Set<EndorsementStatus>;
  const showAllStatuses = searchParams.get('all') === '1';
  const query = searchParams.get('q') ?? '';
  const sortValue = (searchParams.get('sort') ?? DEFAULT_SORT.value) as SortValue;
  const sortOption =
    SORT_OPTIONS.find((s) => s.value === sortValue) ?? DEFAULT_SORT;
  const datePreset = (searchParams.get('date') ?? 'all') as DateRangePreset;
  const customFrom = searchParams.get('from') ?? '';
  const customTo = searchParams.get('to') ?? '';

  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  // Open the drawer automatically if the URL arrives with active filters
  // — otherwise the user lands on a "filtered" view with no idea why.
  useEffect(() => {
    const hasActive =
      activeEndorsements.size > 0 ||
      activeStatuses.size > 0 ||
      datePreset !== 'all';
    if (hasActive) setDrawerOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Push (not replace) so the browser back button traverses filter state. */
  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };

  const updateMany = (changes: ReadonlyArray<readonly [string, string | null]>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of changes) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next);
  };

  const toggleEndorsement = (key: string) => {
    const next = new Set(activeEndorsements);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    updateParam('endorsement', setToParam(next));
  };

  const toggleStatus = (status: EndorsementStatus) => {
    const next = new Set(activeStatuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    updateParam('status', setToParam(next));
  };

  const toggleShowAll = () => {
    updateParam('all', showAllStatuses ? null : '1');
  };

  const setSort = (value: SortValue) => {
    updateParam('sort', value === DEFAULT_SORT.value ? null : value);
  };

  const setDatePreset = (preset: DateRangePreset) => {
    if (preset === 'all') {
      updateMany([['date', null], ['from', null], ['to', null]]);
    } else if (preset === 'custom') {
      updateParam('date', 'custom');
    } else {
      updateMany([['date', preset], ['from', null], ['to', null]]);
    }
  };

  const setCustomDate = (from: string, to: string) => {
    updateMany([
      ['date', 'custom'],
      ['from', from || null],
      ['to', to || null]
    ]);
  };

  const applySearch = () => {
    const trimmed = searchInput.trim();
    if (trimmed === query) return;
    updateParam('q', trimmed || null);
  };

  const clearAll = () => {
    setSearchInput('');
    setSearchParams(new URLSearchParams());
  };

  // ── Counts ─────────────────────────────────────────────────────────
  const { counts } = useCertificationCounts();

  const countOf = (key: string): number | undefined =>
    counts ? counts[key] ?? 0 : undefined;

  const endorsementGroupOptions = useMemo<
    ReadonlyArray<{ readonly group: EndorsementGroup; readonly options: ReadonlyArray<FacetOption<string>> }>
  >(
    () =>
      ENDORSEMENT_GROUPS.map((group) => ({
        group,
        options: group.items.map((item) => {
          const c = countOf(item.key);
          return {
            value: item.key,
            label: item.label,
            count: c,
            hidden: counts !== null && c === 0
          };
        })
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts]
  );

  const statusOptions = useMemo<ReadonlyArray<FacetOption<EndorsementStatus>>>(
    () => {
      const visible: ReadonlyArray<EndorsementStatus> = showAllStatuses
        ? [...PUBLIC_DEFAULT_STATUSES, ...ADVANCED_STATUSES]
        : PUBLIC_DEFAULT_STATUSES;
      return visible.map((s) => {
        const c = countOf(s);
        return {
          value: s,
          label: statusLabel(s),
          count: c,
          hidden: counts !== null && c === 0 && !activeStatuses.has(s)
        };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts, showAllStatuses, searchParams.get('status')]
  );

  // ── Data ───────────────────────────────────────────────────────────
  const endorsementFilter = useMemo(
    () => Array.from(activeEndorsements),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams.get('endorsement')]
  );

  const {
    endorsements,
    isLoadingInitial,
    isLoadingMore,
    hasMore,
    source,
    fallbackError,
    loadMore
  } = useEndorsements({
    statusFilter: isSignedIn ? Array.from(activeStatuses) : [],
    endorsementFilter,
    searchKey: query,
    sortBy: sortOption.sortBy,
    sortByTimestamp: sortOption.sortByTimestamp
  });

  const sentinelRef = useInfiniteScroll({
    hasMore,
    isLoading: isLoadingMore || isLoadingInitial,
    onLoadMore: loadMore
  });

  // ── Active filter pills ────────────────────────────────────────────
  const activePills: ReadonlyArray<ActiveFilterPillSpec> = [
    ...Array.from(activeEndorsements).map((key) => ({
      key: `e-${key}`,
      label: endorsementKeyLabel(key),
      onRemove: () => toggleEndorsement(key)
    })),
    ...(isSignedIn
      ? Array.from(activeStatuses).map((s) => ({
          key: `s-${s}`,
          label: statusLabel(s),
          onRemove: () => toggleStatus(s)
        }))
      : []),
    ...(datePreset !== 'all'
      ? [
          {
            key: 'd',
            label:
              datePreset === 'custom' && (customFrom || customTo)
                ? `${customFrom || '…'} → ${customTo || '…'}`
                : datePresetLabel(datePreset),
            onRemove: () => setDatePreset('all')
          }
        ]
      : []),
    ...(query
      ? [
          {
            key: 'q',
            label: `"${query}"`,
            onRemove: () => updateMany([['q', null]])
          }
        ]
      : [])
  ];

  const activeFilterCount = activePills.length;

  // ── Stats strip ────────────────────────────────────────────────────
  const totalCount = counts?.all;
  const certifiedCount = counts?.certified;
  const notifiedCount = counts?.recipient_notified;
  const passedCount = counts?.passed;

  return (
    <>
      {/* Sticky sub-chrome — title + search/sort/filters + active pills */}
      <div className="sticky top-[52px] z-20 bg-gray-50/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200/60 dark:border-gray-700/60">
        <div className={`${containerClassName} pt-6 pb-4 space-y-4`}>
          {/* Title row — title left, summary stats inline, action slot right */}
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div className="min-w-0 flex-1">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
                Endorsements
              </h1>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Browse RESO certification endorsements across all participating organizations.
              </p>
            </div>
            {/* Action slot — reserved for export, provider/admin actions, etc. */}
            <div className="flex items-center gap-2" aria-label="Page actions" />
          </div>

          {/* Stats strip — prominent counts */}
          {counts && (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              {typeof totalCount === 'number' && (
                <Stat label="Total" value={totalCount} accent />
              )}
              {typeof certifiedCount === 'number' && (
                <Stat label="Certified" value={certifiedCount} tone="green" />
              )}
              {typeof notifiedCount === 'number' && (
                <Stat label="Notified" value={notifiedCount} tone="sky" />
              )}
              {typeof passedCount === 'number' && (
                <Stat label="Passed" value={passedCount} tone="emerald" />
              )}
              <SourceBadge source={source} title={fallbackError ?? undefined} />
            </div>
          )}

          {/* Search + Sort + Filters toggle — single row */}
          <div className="flex items-center gap-2">
            <SearchInput
              value={searchInput}
              placeholder={searchPlaceholder}
              onChange={setSearchInput}
              onApply={applySearch}
            />
            <SortDropdown
              value={sortValue}
              options={SORT_OPTIONS}
              onChange={setSort}
            />
            <FilterToggleButton
              open={drawerOpen}
              onToggle={() => setDrawerOpen((o) => !o)}
              activeCount={activeFilterCount}
            />
          </div>

          {/* Filter drawer — flows horizontally, two columns on wide screens */}
          <FilterDrawer open={drawerOpen}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-4">
              <div className="space-y-3">
                <DateRangePresets
                  value={datePreset}
                  customFrom={customFrom}
                  customTo={customTo}
                  onChange={setDatePreset}
                  onCustomChange={setCustomDate}
                />
              </div>
              <div className="space-y-3">
                {isSignedIn && (
                  <FacetGroup
                    label="Status"
                    options={statusOptions}
                    selected={activeStatuses}
                    onToggle={toggleStatus}
                    trailing={
                      <button
                        type="button"
                        onClick={toggleShowAll}
                        className="ml-1 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 underline-offset-2 hover:underline"
                      >
                        {showAllStatuses ? 'Hide advanced' : 'Show all'}
                      </button>
                    }
                  />
                )}
              </div>
              <div className="lg:col-span-2 space-y-3 pt-1 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 pt-3">
                  Endorsements
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-3">
                  {endorsementGroupOptions.map(({ group, options }) => (
                    <FacetGroup
                      key={group.groupKey}
                      label={group.groupLabel}
                      options={options}
                      selected={activeEndorsements}
                      onToggle={toggleEndorsement}
                    />
                  ))}
                </div>
              </div>
            </div>
          </FilterDrawer>

          {/* Active filter pills */}
          {activeFilterCount > 0 && (
            <ActiveFilters pills={activePills} onClearAll={clearAll} />
          )}
        </div>
      </div>

      {/* Scrolling content — list */}
      <div className={`${containerClassName} py-6`}>
        {fallbackError && source === 'fixtures' && (
          <div className="mb-4 text-xs text-gray-500 dark:text-gray-400 bg-amber-50/40 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded-lg px-3 py-2">
            {fallbackError}
          </div>
        )}

        {isLoadingInitial ? (
          <div className="py-16 text-center text-sm text-gray-400 dark:text-gray-500">
            Loading endorsements…
          </div>
        ) : endorsements.length > 0 ? (
          <>
            <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {endorsements.length}
              </span>{' '}
              endorsement{endorsements.length === 1 ? '' : 's'} shown
              {hasMore && (
                <span className="text-gray-400 dark:text-gray-500"> · more available</span>
              )}
            </div>
            <ul className="space-y-2.5">
              {endorsements.map((e) => (
                <li key={e.id}>
                  <EndorsementRow endorsement={e} />
                </li>
              ))}
            </ul>
            <div
              ref={sentinelRef}
              className="py-6 text-center text-xs text-gray-400 dark:text-gray-500"
              aria-live="polite"
            >
              {isLoadingMore ? (
                <span>Loading more…</span>
              ) : hasMore ? (
                <span className="opacity-60">Scroll for more</span>
              ) : (
                <span>End of results</span>
              )}
            </div>
          </>
        ) : (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No endorsements match the current filters.
            </p>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="mt-3 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
};

// ── Local atoms ──────────────────────────────────────────────────────────

interface StatProps {
  readonly label: string;
  readonly value: number;
  readonly accent?: boolean;
  readonly tone?: 'green' | 'sky' | 'emerald';
}

const TONE_CLASSES: Record<NonNullable<StatProps['tone']>, string> = {
  green:   'text-green-700 dark:text-green-400',
  sky:     'text-sky-700 dark:text-sky-400',
  emerald: 'text-emerald-700 dark:text-emerald-400'
};

const Stat = ({ label, value, accent, tone }: StatProps) => {
  const valueClass = accent
    ? 'text-gray-900 dark:text-gray-100'
    : tone
      ? TONE_CLASSES[tone]
      : 'text-gray-700 dark:text-gray-300';
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-2xl font-semibold tabular-nums ${valueClass}`}>
        {value.toLocaleString()}
      </span>
      <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </span>
    </div>
  );
};
