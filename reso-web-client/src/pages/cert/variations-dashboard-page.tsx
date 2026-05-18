/**
 * Variations Review Dashboard — top-level items-screen.
 *
 * Aggregates in-review variations across all reports. Server applies
 * scope based on the caller's auth context (admin sees the full pool;
 * provider sees their own partition). Cursor-based pagination via
 * the virtualized table's near-end watcher.
 *
 * URL-driven detail drawer:
 *   /cert/variations         → dashboard, no drawer
 *   /cert/variations/:key    → dashboard with drawer open for :key
 *
 * Both routes render this component (see main.tsx). The :key param
 * drives `selectedItem` — bookmarkable, shareable URLs; browser-back
 * closes the drawer.
 *
 * Replaces the old VariationsPage entirely (deleted in Phase 7).
 * See reso-tools#150.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router';
import {
  listVariationItems,
  type VariationItem,
  type VariationItemStatus,
} from '../../services/variations-service';
import { VariationItemsTable } from '../../components/cert/variation-items-table';
import { VariationDetailDrawer } from '../../components/cert/variation-detail-drawer';

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
  const navigate = useNavigate();
  const location = useLocation();
  const { key: routeKey } = useParams<{ key?: string }>();
  const decodedRouteKey = routeKey ? decodeURIComponent(routeKey) : null;

  const [items, setItems] = useState<ReadonlyArray<VariationItem>>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  /** Item passed via route state on row click (fast path — avoids
   *  re-fetching when the user clicks a row in this same page).
   *  Direct URL access falls back to `items.find(...)`. */
  const stateItem = (location.state as { item?: VariationItem } | null)?.item;
  /** Items we've fetched specifically by variationKey when the URL
   *  has a :key that's not in items[] (e.g. direct deep link). */
  const [keyFetchedItems, setKeyFetchedItems] = useState<ReadonlyArray<VariationItem>>([]);

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

  /** Resolve the URL :key to a VariationItem. Tries (in order): route
   *  state (fast path on row click), the dashboard's items[], and the
   *  key-fetched items[] (direct deep-link fallback). */
  const selectedItem: VariationItem | null = useMemo(() => {
    if (!decodedRouteKey) return null;
    if (stateItem && stateItem.variationKey === decodedRouteKey) return stateItem;
    const fromList = items.find(i => i.variationKey === decodedRouteKey);
    if (fromList) return fromList;
    const fromKeyFetched = keyFetchedItems.find(i => i.variationKey === decodedRouteKey);
    return fromKeyFetched ?? null;
  }, [decodedRouteKey, stateItem, items, keyFetchedItems]);

  // Direct deep-link fallback: if URL has :key but the item isn't in
  // items[] or stateItem, fetch the list until we find it. v0.11 has
  // no get-by-key endpoint, so we walk the pages. Skips the fetch if
  // already covered by another source.
  useEffect(() => {
    if (!decodedRouteKey) return;
    if (stateItem?.variationKey === decodedRouteKey) return;
    if (items.some(i => i.variationKey === decodedRouteKey)) return;
    if (keyFetchedItems.some(i => i.variationKey === decodedRouteKey)) return;
    let cancelled = false;
    const findByKey = async () => {
      const page = await listVariationItems();
      if (cancelled) return;
      const found = page.items.find(i => i.variationKey === decodedRouteKey);
      if (found) setKeyFetchedItems(prev => [...prev, found]);
    };
    void findByKey();
    return () => { cancelled = true; };
  }, [decodedRouteKey, stateItem, items, keyFetchedItems]);

  const handleRowClick = useCallback((item: VariationItem) => {
    navigate(`/cert/variations/${encodeURIComponent(item.variationKey)}`, {
      state: { item },
    });
  }, [navigate]);

  const handleDrawerClose = useCallback(() => {
    navigate('/cert/variations');
  }, [navigate]);

  /** Drawer reports a successful saveDraft / deleteDraft / submit →
   *  keep the row chip + drawer in sync without a full list refetch.
   *  Updates items[] AND keyFetchedItems[] (covers both sources). */
  const handleItemUpdated = useCallback((updated: VariationItem) => {
    setItems(prev => prev.map(i => i.variationKey === updated.variationKey ? updated : i));
    setKeyFetchedItems(prev => prev.map(i => i.variationKey === updated.variationKey ? updated : i));
  }, []);

  return (
    <div className="flex flex-col h-full gap-4 p-4 min-h-0">
      <header className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 pb-3 shrink-0">
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
        <div className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900 rounded px-3 py-2 shrink-0">
          {error}
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">No variations in this view.</div>
      )}

      {items.length > 0 && (
        <VariationItemsTable
          items={items}
          onRowClick={handleRowClick}
          onLoadMore={() => { void loadMore(); }}
          hasMore={!!nextCursor}
          isLoadingMore={loadingMore}
        />
      )}

      <VariationDetailDrawer
        item={selectedItem}
        onClose={handleDrawerClose}
        onItemUpdated={handleItemUpdated}
      />
    </div>
  );
};
