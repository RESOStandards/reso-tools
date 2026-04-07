import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type {
  EndorsementStatus,
  EndorsementType
} from '../../api/cert-fixtures';
import { useEndorsements } from '../../hooks/use-endorsements';
import { useInfiniteScroll } from '../../hooks/use-infinite-scroll';
import { EndorsementRow } from './endorsement-row';
import { STATUS_SORT_ORDER, statusLabel } from './status-pill';

const ENDORSEMENT_TYPE_OPTIONS: ReadonlyArray<{
  readonly type: EndorsementType;
  readonly label: string;
}> = [
  { type: 'data_dictionary', label: 'Data Dictionary' },
  { type: 'web_api_server_core', label: 'Web API Server Core' },
  { type: 'add_edit', label: 'Add/Edit' },
  { type: 'entity_event', label: 'Entity Event' },
  { type: 'reso_common_format', label: 'RESO Common Format' },
  { type: 'webhooks', label: 'Webhooks' }
];

const STATUS_PRIORITY: Record<EndorsementStatus, number> =
  STATUS_SORT_ORDER.reduce(
    (acc, status, idx) => ({ ...acc, [status]: idx }),
    {} as Record<EndorsementStatus, number>
  );

/** Read a CSV-encoded URL search param into a Set. */
const paramSet = (raw: string | null): Set<string> =>
  new Set((raw ?? '').split(',').filter(Boolean));

/** Write a Set back to the URL as a CSV string (or remove if empty). */
const setToParam = (s: ReadonlySet<string>): string | null => {
  const arr = Array.from(s);
  return arr.length > 0 ? arr.join(',') : null;
};

interface FilterChipProps {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}

const FilterChip = ({ label, active, onClick }: FilterChipProps) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
      active
        ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
        : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
    }`}
  >
    {label}
  </button>
);

/**
 * Public Endorsements list — server-paginated, server-filtered.
 * Filter state lives in the URL so it survives refresh and is shareable.
 * The list owns its own data via `useEndorsements()`. Client-side
 * pagination has been replaced by cursor-based fetches; the infinite
 * scroll sentinel triggers `loadMore()` when it enters view.
 */
export const EndorsementList = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(
    () => searchParams.get('q') ?? ''
  );

  const activeStatuses = paramSet(searchParams.get('status'));
  const activeTypes = paramSet(searchParams.get('type'));
  const query = searchParams.get('q') ?? '';

  // Sync the search input with URL changes (back/forward navigation)
  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  };

  const toggleStatus = (status: EndorsementStatus) => {
    const next = new Set(activeStatuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    updateParam('status', setToParam(next));
  };

  const toggleType = (type: EndorsementType) => {
    const next = new Set(activeTypes);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    updateParam('type', setToParam(next));
  };

  const applySearch = () => {
    updateParam('q', searchInput.trim() || null);
  };

  const clearAll = () => {
    setSearchInput('');
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  const hasActiveFilters =
    activeStatuses.size > 0 || activeTypes.size > 0 || query.length > 0;

  // ── Data ───────────────────────────────────────────────────────────
  const {
    endorsements,
    isLoadingInitial,
    isLoadingMore,
    hasMore,
    source,
    fallbackError,
    loadMore
  } = useEndorsements({
    statusFilter: Array.from(activeStatuses),
    endorsementFilter: Array.from(activeTypes),
    searchKey: query
  });

  // Sort by status priority client-side. Server may already sort, but
  // this gives a stable, predictable order regardless and groups
  // actionable items at the top.
  const sortedEndorsements = useMemo(() => {
    return [...endorsements].sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 99;
      const pb = STATUS_PRIORITY[b.status] ?? 99;
      if (pa !== pb) return pa - pb;
      return (
        new Date(b.statusTimestamp).getTime() -
        new Date(a.statusTimestamp).getTime()
      );
    });
  }, [endorsements]);

  const sentinelRef = useInfiniteScroll({
    hasMore,
    isLoading: isLoadingMore || isLoadingInitial,
    onLoadMore: loadMore
  });

  return (
    <div className="space-y-5">
      {/* Search + clear */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applySearch();
            }}
            onBlur={applySearch}
            placeholder="Search by provider, system, or endorsement type"
            className="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
          />
        </div>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mr-1">
          Status
        </span>
        {STATUS_SORT_ORDER.map((s) => (
          <FilterChip
            key={s}
            label={statusLabel(s)}
            active={activeStatuses.has(s)}
            onClick={() => toggleStatus(s)}
          />
        ))}
      </div>

      {/* Type filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mr-1">
          Type
        </span>
        {ENDORSEMENT_TYPE_OPTIONS.map(({ type, label }) => (
          <FilterChip
            key={type}
            label={label}
            active={activeTypes.has(type)}
            onClick={() => toggleType(type)}
          />
        ))}
      </div>

      {/* Status row: counts, source badge, error */}
      <div className="flex items-center justify-between gap-3 pt-1 text-xs text-gray-500 dark:text-gray-400">
        <div>
          {isLoadingInitial ? (
            <span>Loading endorsements…</span>
          ) : (
            <>
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {sortedEndorsements.length}
              </span>{' '}
              endorsement{sortedEndorsements.length === 1 ? '' : 's'} loaded
              {hasMore && (
                <span className="text-gray-400 dark:text-gray-500"> · more available</span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {source === 'live' ? (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider bg-green-50 text-green-700 ring-1 ring-green-200/70 dark:bg-green-900/30 dark:text-green-300 dark:ring-green-900/40"
              title="Live data from certqa.reso.org"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Live
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider bg-amber-50 text-amber-700 ring-1 ring-amber-200/70 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-900/40"
              title={fallbackError ?? 'Showing fixture data'}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              Fixtures
            </span>
          )}
        </div>
      </div>

      {/* Soft inline note when we fell back to fixtures */}
      {fallbackError && source === 'fixtures' && (
        <div className="text-xs text-gray-500 dark:text-gray-400 bg-amber-50/40 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded-lg px-3 py-2">
          {fallbackError}
        </div>
      )}

      {/* List */}
      {isLoadingInitial ? (
        <div className="py-16 text-center text-sm text-gray-400 dark:text-gray-500">
          Loading endorsements…
        </div>
      ) : sortedEndorsements.length > 0 ? (
        <>
          <ul className="space-y-2.5">
            {sortedEndorsements.map((e) => (
              <li key={e.id}>
                <EndorsementRow endorsement={e} />
              </li>
            ))}
          </ul>

          {/* Sentinel — fires loadMore() when scrolled into view */}
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
          {hasActiveFilters && (
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
  );
};
