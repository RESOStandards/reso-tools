import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { EndorsementStatus } from '../../api/cert-fixtures';
import { useAuth } from '../../hooks/use-auth';
import { useCertificationCounts } from '../../hooks/use-certification-counts';
import { useEndorsements } from '../../hooks/use-endorsements';
import { useInfiniteScroll } from '../../hooks/use-infinite-scroll';
import { useOrganizationNames } from '../../hooks/use-organization-names';
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
import { EndorsementGroupCard } from './endorsement-group-card';
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

  // Debounced search-as-you-type. The local input updates instantly;
  // the URL (and therefore the API call) only updates after the user
  // stops typing for 300ms — matches the existing reso-certification
  // client's pattern of pushing the searchKey straight to the
  // server-side filter.
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === query) return;
    const timer = setTimeout(() => {
      updateParam('q', trimmed || null);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const clearAll = () => {
    setSearchInput('');
    setSearchParams(new URLSearchParams());
  };

  // ── Data ───────────────────────────────────────────────────────────
  //
  // When a text search is active, we deliberately drop the endorsement
  // and status filters from the API call and apply them client-side
  // instead. The reason: facet count badges should reflect what's
  // available *for the searched org* — not what's left after the
  // user's chip selection. By fetching the full search-scoped set we
  // can compute accurate per-endorsement / per-status counts and
  // still narrow the displayed list to what the chips select.
  const endorsementFilter = useMemo(
    () => (query ? [] : Array.from(activeEndorsements)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, searchParams.get('endorsement')]
  );

  const apiStatusFilter = useMemo(
    () => (query ? [] : isSignedIn ? Array.from(activeStatuses) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, isSignedIn, searchParams.get('status')]
  );

  const {
    endorsements: rawEndorsements,
    isLoadingInitial,
    isLoadingMore,
    hasMore,
    source,
    fallbackError,
    loadMore
  } = useEndorsements({
    statusFilter: apiStatusFilter,
    endorsementFilter,
    searchKey: query,
    sortBy: sortOption.sortBy,
    sortByTimestamp: sortOption.sortByTimestamp
  });

  // Apply endorsement + status filters client-side when search is
  // active. Otherwise the API has already done it and we pass through.
  const endorsements = useMemo(() => {
    if (!query) return rawEndorsements;
    return rawEndorsements.filter((e) => {
      const endorsementKey = `${e.type}_${e.version}`;
      if (
        activeEndorsements.size > 0 &&
        !activeEndorsements.has(endorsementKey)
      ) {
        return false;
      }
      if (
        isSignedIn &&
        activeStatuses.size > 0 &&
        !(activeStatuses as Set<string>).has(e.status)
      ) {
        return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    query,
    rawEndorsements,
    isSignedIn,
    searchParams.get('endorsement'),
    searchParams.get('status')
  ]);

  // ── Counts ─────────────────────────────────────────────────────────
  const { counts: globalCounts } = useCertificationCounts();

  // When a text search is active, the global counts no longer reflect
  // the visible set (the count endpoint ignores `searchKey`). Compute
  // counts client-side from the loaded results so the facet badges
  // and headline reflect what the user is actually seeing. This is
  // best-effort against the loaded page — accurate when the search
  // narrows enough that everything fits in one page.
  const localCounts = useMemo<Record<string, number> | null>(() => {
    if (!query) return null;
    // Counts come from the *unfiltered* (search-only) set so chips
    // represent what's available for the searched org regardless of
    // the user's current chip selection.
    const c: Record<string, number> = { all: rawEndorsements.length };
    for (const e of rawEndorsements) {
      const key = `${e.type}_${e.version}`;
      c[key] = (c[key] ?? 0) + 1;
      c[e.status] = (c[e.status] ?? 0) + 1;
    }
    return c;
  }, [query, rawEndorsements]);

  const counts = localCounts ?? globalCounts;

  const countOf = (key: string): number | undefined =>
    counts ? counts[key] ?? 0 : undefined;

  // Always show every chip, even when its count is zero. Zero counts
  // are meaningful — "this org doesn't have Web API" is information.
  const endorsementGroupOptions = useMemo<
    ReadonlyArray<{ readonly group: EndorsementGroup; readonly options: ReadonlyArray<FacetOption<string>> }>
  >(
    () =>
      ENDORSEMENT_GROUPS.map((group) => ({
        group,
        options: group.items.map((item) => ({
          value: item.key,
          label: item.label,
          count: countOf(item.key)
        }))
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts]
  );

  const statusOptions = useMemo<ReadonlyArray<FacetOption<EndorsementStatus>>>(
    () => {
      const visible: ReadonlyArray<EndorsementStatus> = showAllStatuses
        ? [...PUBLIC_DEFAULT_STATUSES, ...ADVANCED_STATUSES]
        : PUBLIC_DEFAULT_STATUSES;
      return visible.map((s) => ({
        value: s,
        label: statusLabel(s),
        count: countOf(s)
      }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts, showAllStatuses]
  );

  // Decorate endorsements with resolved org names + system product
  // names so the row can lead with human-readable identity rather
  // than raw UOIs and USIs.
  const { lookup: lookupOrgName, lookupSystem } = useOrganizationNames();
  const decoratedEndorsements = useMemo(
    () =>
      endorsements.map((e) => ({
        ...e,
        recipientName: lookupOrgName(e.recipientUoi) ?? e.recipientName ?? e.recipientUoi,
        providerName: lookupOrgName(e.providerUoi) ?? e.providerName ?? e.providerUoi,
        systemName: lookupSystem(e.providerUoi, e.providerUsi) ?? e.systemName
      })),
    [endorsements, lookupOrgName, lookupSystem]
  );

  // Group by recipient organization. Group order follows the chosen
  // sort: alpha sorts arrange groups A→Z; time sorts arrange groups
  // by their most-recent endorsement. Within each group, sub-rows
  // follow the same sort.
  interface RecipientGroup {
    readonly recipientUoi: string;
    readonly recipientName: string;
    readonly endorsements: ReadonlyArray<typeof decoratedEndorsements[number]>;
    readonly mostRecentMs: number;
  }

  const groupedEndorsements = useMemo<ReadonlyArray<RecipientGroup>>(() => {
    const groups = new Map<string, RecipientGroup & { endorsements: Array<typeof decoratedEndorsements[number]> }>();

    for (const e of decoratedEndorsements) {
      const key = e.recipientUoi;
      const existing = groups.get(key);
      const ts = new Date(e.statusTimestamp).getTime();
      if (existing) {
        existing.endorsements.push(e);
        if (!Number.isNaN(ts) && ts > existing.mostRecentMs) {
          (existing as { mostRecentMs: number }).mostRecentMs = ts;
        }
      } else {
        groups.set(key, {
          recipientUoi: key,
          recipientName: e.recipientName ?? e.recipientUoi,
          endorsements: [e],
          mostRecentMs: Number.isNaN(ts) ? 0 : ts
        });
      }
    }

    const list = Array.from(groups.values());

    const dir = sortOption.sortBy === 'asc' ? 1 : -1;
    const byTime = sortOption.sortByTimestamp;

    // Sort sub-rows within each group
    for (const g of list) {
      g.endorsements.sort((a, b) => {
        if (byTime) {
          return (
            (new Date(a.statusTimestamp).getTime() -
              new Date(b.statusTimestamp).getTime()) *
            dir
          );
        }
        return (
          (`${a.typeLabel} ${a.version}`.localeCompare(
            `${b.typeLabel} ${b.version}`
          )) * dir
        );
      });
    }

    // Sort groups themselves
    list.sort((a, b) => {
      if (byTime) {
        return (a.mostRecentMs - b.mostRecentMs) * dir;
      }
      return a.recipientName.localeCompare(b.recipientName) * dir;
    });

    return list;
  }, [decoratedEndorsements, sortOption.sortBy, sortOption.sortByTimestamp]);

  const totalShown = groupedEndorsements.reduce(
    (n, g) => n + g.endorsements.length,
    0
  );

  // Sort mode determines layout:
  //   - Name (alpha):  grouped showcase — one card per recipient with
  //     all their matching endorsements stacked inside.
  //   - Time:          flat activity feed — one row per endorsement
  //     with the org name inline, ordered by date.
  const isGroupedMode = !sortOption.sortByTimestamp;

  // Flat-mode sorted list (used when isGroupedMode === false).
  const flatSortedEndorsements = useMemo(() => {
    const dir = sortOption.sortBy === 'asc' ? 1 : -1;
    return [...decoratedEndorsements].sort(
      (a, b) =>
        (new Date(a.statusTimestamp).getTime() -
          new Date(b.statusTimestamp).getTime()) *
        dir
    );
  }, [decoratedEndorsements, sortOption.sortBy]);

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
      count: countOf(key),
      onRemove: () => toggleEndorsement(key)
    })),
    ...(isSignedIn
      ? Array.from(activeStatuses).map((s) => ({
          key: `s-${s}`,
          label: statusLabel(s),
          count: countOf(s),
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

  // ── Counts derived from active filter ──────────────────────────────
  //
  // Public users only see certified endorsements on the wire (the API
  // doesn't expose status filtering anonymously), so the headline count
  // should reflect whatever endorsement filter they currently have set.
  // Sum the per-endorsement counts when one or more is selected;
  // otherwise fall back to the certified total (or `all` as a last
  // resort, in case the API ever exposes a non-certified-restricted
  // anonymous count).
  const headlineCount = useMemo<number | undefined>(() => {
    if (!counts) return undefined;
    if (activeEndorsements.size > 0) {
      let sum = 0;
      for (const key of activeEndorsements) sum += counts[key] ?? 0;
      return sum;
    }
    return counts.certified ?? counts.all;
  }, [counts, searchParams.get('endorsement')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Signed-in users get the stats strip — hide zero values so we don't
  // surface empty rails for endpoints that the API didn't return.
  const totalCount = counts?.all;
  const certifiedCount = counts?.certified;
  const notifiedCount = counts?.recipient_notified;
  const passedCount = counts?.passed;

  return (
    <>
      {/* Sticky sub-chrome — title + search/sort/filters + active pills */}
      <div className="sticky top-[52px] z-20 bg-gray-50/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200/60 dark:border-gray-700/60">
        <div className={`${containerClassName} pt-3 pb-3 space-y-3`}>
          {/* Title row — title left, action slot right */}
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-x-4 gap-y-1 flex-wrap">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
                  Endorsements
                </h1>
                {!isSignedIn && typeof headlineCount === 'number' && (
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tabular-nums text-green-700 dark:text-green-400">
                      {headlineCount.toLocaleString()}
                    </span>
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-green-700 dark:text-green-400">
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Certified
                      {activeEndorsements.size > 0 && (
                        <span className="text-gray-500 dark:text-gray-400 font-normal">
                          {' '}· matching filters
                        </span>
                      )}
                    </span>
                    {/* Source badge hidden for production — re-enable for diagnostics */}
                  </div>
                )}
              </div>
              {isSignedIn && (
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  Browse RESO certification endorsements across all participating organizations.
                </p>
              )}
            </div>
            {/* Action slot — reserved for export, provider/admin actions, etc. */}
            <div className="flex items-center gap-2" aria-label="Page actions" />
          </div>

          {/* Stats strip — signed-in only. Reserved for the eventual
              role-aware mini dashboard for providers and admins. */}
          {isSignedIn && counts && (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              {typeof totalCount === 'number' && totalCount > 0 && (
                <Stat label="Total" value={totalCount} accent />
              )}
              {typeof certifiedCount === 'number' && certifiedCount > 0 && (
                <Stat label="Certified" value={certifiedCount} tone="green" />
              )}
              {typeof notifiedCount === 'number' && notifiedCount > 0 && (
                <Stat label="Notified" value={notifiedCount} tone="sky" />
              )}
              {typeof passedCount === 'number' && passedCount > 0 && (
                <Stat label="Passed" value={passedCount} tone="emerald" />
              )}
              <SourceBadge source={source} title={fallbackError ?? undefined} />
            </div>
          )}

          {/* Search + Filters + Sort — single row. Sort sits trailing
              by convention: filters narrow the set, sort orders it. */}
          <div className="flex items-center gap-2">
            <SearchInput
              value={searchInput}
              placeholder={searchPlaceholder}
              onChange={setSearchInput}
              onApply={() => {
                /* debounced; explicit apply is a no-op */
              }}
            />
            <FilterToggleButton
              open={drawerOpen}
              onToggle={() => setDrawerOpen((o) => !o)}
              activeCount={activeFilterCount}
            />
            <SortDropdown
              value={sortValue}
              options={SORT_OPTIONS}
              onChange={setSort}
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
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-x-4 gap-y-3">
                  {endorsementGroupOptions.map(({ group, options }) => (
                    <FacetGroup
                      key={group.groupKey}
                      label={group.groupLabel}
                      options={options}
                      selected={activeEndorsements}
                      onToggle={toggleEndorsement}
                      stacked
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
        {/* Fixture fallback warning — hidden from UI for production testing.
            Keep the code for dev diagnostics; re-enable when needed. */}

        {isLoadingInitial ? (
          <div className="py-16 text-center text-sm text-gray-400 dark:text-gray-500">
            Loading endorsements…
          </div>
        ) : totalShown > 0 ? (
          <>
            <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {totalShown}
              </span>{' '}
              endorsement{totalShown === 1 ? '' : 's'}
              {isGroupedMode && (
                <>
                  {' '}across{' '}
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    {groupedEndorsements.length}
                  </span>{' '}
                  organization{groupedEndorsements.length === 1 ? '' : 's'}
                </>
              )}
              {hasMore && (
                <span className="inline-flex items-center gap-0.5 text-gray-400 dark:text-gray-500">
                  {' · scroll to view more'}
                  <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              )}
            </div>
            {isGroupedMode ? (
              <ul className="space-y-3">
                {groupedEndorsements.map((g) => (
                  <li key={g.recipientUoi}>
                    <EndorsementGroupCard
                      recipientUoi={g.recipientUoi}
                      recipientName={g.recipientName}
                      endorsements={g.endorsements}
                      isGrouped
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="space-y-3">
                {flatSortedEndorsements.map((e) => (
                  <li key={e.id}>
                    <EndorsementGroupCard
                      recipientUoi={e.recipientUoi}
                      recipientName={e.recipientName ?? e.recipientUoi}
                      endorsements={[e]}
                      isGrouped={false}
                    />
                  </li>
                ))}
              </ul>
            )}
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
