/**
 * Variations Review Dashboard — top-level items-screen.
 *
 * Aggregates in-review variations across all reports. Server applies
 * scope based on the caller's auth context (admin sees the full pool;
 * provider sees their own partition). Cursor-based pagination via
 * "Load more" today; will become infinite scroll in Phase 3 with the
 * virtualized row table.
 *
 * Replaces the list mode of the old VariationsPage (which still
 * serves the per-report drill-in at /cert/variations/:slug; cleaned
 * up in Phase 7). See reso-tools#150.
 *
 * Phase 2 of the items-screen rewrite.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  listVariationItems,
  type VariationItem,
  type VariationItemStatus,
} from '../../services/variations-service';

type StatusFilter = VariationItemStatus | 'all';

const STATUS_FILTERS: ReadonlyArray<StatusFilter> = ['all', 'pending', 'ft-submitted', 'resolved'];

/** Filter chip labels. The 'pending' bucket is rendered as "In Review"
 *  for the user — the pool's `status` enum value is internal. */
const STATUS_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  pending: 'In Review',
  'ft-submitted': 'FT WG',
  resolved: 'Resolved',
};

export const VariationsDashboardPage = () => {
  const [items, setItems] = useState<ReadonlyArray<VariationItem>>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // First page (or refetch on filter change).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const page = await listVariationItems(
          statusFilter !== 'all' ? { status: statusFilter } : undefined
        );
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load variations');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [statusFilter]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listVariationItems({
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        cursor: nextCursor,
      });
      setItems(prev => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more variations');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, statusFilter]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 pb-3">
        <h1 className="text-lg font-semibold">Variations Review</h1>
        <div className="flex gap-1.5" role="tablist" aria-label="Status filter">
          {STATUS_FILTERS.map(s => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                statusFilter === s
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900 rounded px-3 py-2">
          {error}
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">No variations in this view.</div>
      )}

      {/* Phase 2: bare-bones row rendering. Phase 3 swaps in a
          virtualized table with strategy badges, ball-with-whom pill,
          provenance summary, and infinite scroll. */}
      {items.length > 0 && (
        <ul className="flex flex-col gap-1">
          {items.map(item => (
            <li
              key={item.variationKey}
              className="flex items-center gap-3 px-3 py-2 text-xs font-mono border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer"
            >
              <span className="flex-1 truncate">
                {item.resourceName}
                {item.fieldName ? ` · ${item.fieldName}` : ''}
                {item.lookupValue ? ` · ${item.lookupValue}` : ''}
              </span>
              <span className="text-gray-500 dark:text-gray-400 w-20 text-right">{item.status}</span>
              <span className="text-gray-400 dark:text-gray-500 w-16 text-right">
                {item.provenance.length} org{item.provenance.length === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {nextCursor && !loadingMore && (
        <button
          type="button"
          onClick={() => { void loadMore(); }}
          className="self-start px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded cursor-pointer"
        >
          Load more
        </button>
      )}
      {loadingMore && (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading more…</div>
      )}
    </div>
  );
};
