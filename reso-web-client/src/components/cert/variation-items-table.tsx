/**
 * Variations Review items table — virtualized list of pool rows for
 * the items-screen dashboard. Phase 3 of the items-screen rewrite
 * (#150).
 *
 * One row per VariationItem (variationKey, aggregated across all
 * (providerUoi, providerUsi, recipientUoi) tuples that flagged the
 * variation). Columns:
 *
 *   identity        ball-with-whom    orgs    age    myDraft?
 *
 * Infinite scroll via @tanstack/react-virtual + a near-end watcher
 * that calls `onLoadMore` when the user nears the bottom of the
 * scroll viewport.
 *
 * Click → row callback (the dashboard wires this to the detail
 * drawer in Phase 4).
 */

import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  VariationItem,
  VariationOutcome,
  VariationEditorRole,
} from '../../services/variations-service';

// ── Helpers ──────────────────────────────────────────────────────────

/** Compact relative-time formatter — "5d ago" / "3h ago" / "just now". */
const humanizeTimeAgo = (iso: string): string => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const deltaMs = Date.now() - t;
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

interface Pill {
  readonly label: string;
  readonly className: string;
}

/** Derive the "ball with whom" pill from item status + last editor
 *  role. Status drives the bucket; lastEditorRole disambiguates within
 *  pending (admin vs provider acted last). */
const ballWithWhom = (item: VariationItem): Pill => {
  if (item.status === 'resolved') {
    return {
      label: outcomeLabel(item.outcome),
      className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    };
  }
  if (item.status === 'ft-submitted') {
    return {
      label: 'FT WG Review',
      className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    };
  }
  // status === 'pending' — admin queue or returned to provider
  const lastRole: VariationEditorRole | undefined = item.lastEditorRole;
  if (lastRole === 'admin' || lastRole === 'ft-admin') {
    return {
      label: 'Awaiting Provider',
      className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    };
  }
  // lastEditorRole is 'provider' or undefined → provider has the
  // initial submit; admin hasn't picked it up yet.
  return {
    label: 'Awaiting Admin',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  };
};

const outcomeLabel = (outcome: VariationOutcome | undefined): string => {
  if (!outcome) return 'Resolved';
  if (outcome === 'ignored') return 'Ignored';
  if (outcome === 'removed') return 'Removed';
  if (outcome === 'accepted') return 'Accepted';
  if (outcome === 'ft-mapped') return 'FT Mapped';
  return outcome;
};

/** Provenance tooltip — list provider/system/recipient triples. */
const provenanceTooltip = (item: VariationItem): string => {
  if (item.provenance.length === 0) return '';
  const lines = item.provenance.slice(0, 10).map(p => {
    const submitter = p.submittedByDisplayName ?? p.submittedByProviderUoi;
    return `${submitter} (${p.providerUsi}) → ${p.recipientUoi}`;
  });
  const more = item.provenance.length > 10 ? `\n+${item.provenance.length - 10} more` : '';
  return lines.join('\n') + more;
};

// ── Row ──────────────────────────────────────────────────────────────

interface VariationItemRowProps {
  readonly item: VariationItem;
  readonly onClick?: () => void;
}

const VariationItemRow = ({ item, onClick }: VariationItemRowProps) => {
  const pill = ballWithWhom(item);
  const orgCount = item.provenance.length;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 text-xs text-left border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer transition-colors"
    >
      <span className="flex-1 truncate font-mono text-gray-800 dark:text-gray-200">
        {item.resourceName}
        {item.fieldName ? <span className="text-gray-400 dark:text-gray-500"> · </span> : null}
        {item.fieldName}
        {item.lookupValue ? <span className="text-gray-400 dark:text-gray-500"> · </span> : null}
        {item.lookupValue}
      </span>
      <span className={`px-2 py-0.5 rounded-full font-medium ${pill.className}`}>
        {pill.label}
      </span>
      <span
        className="w-20 text-right text-gray-500 dark:text-gray-400 cursor-help"
        title={provenanceTooltip(item)}
      >
        {orgCount} org{orgCount === 1 ? '' : 's'}
      </span>
      <span className="w-20 text-right text-gray-400 dark:text-gray-500">
        {humanizeTimeAgo(item.lastUpdatedAt)}
      </span>
      <span className="w-24 text-right">
        {item.myDraft ? (
          <span className="px-2 py-0.5 rounded-full text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-900/20">
            Draft: {item.myDraft.action}
          </span>
        ) : null}
      </span>
    </button>
  );
};

// ── Table ────────────────────────────────────────────────────────────

interface VariationItemsTableProps {
  readonly items: ReadonlyArray<VariationItem>;
  readonly onRowClick?: (item: VariationItem) => void;
  readonly onLoadMore?: () => void;
  readonly hasMore?: boolean;
  readonly isLoadingMore?: boolean;
}

/** Distance from the end (in items) at which we prefetch the next
 *  page. Tuned to overscan + a small buffer so the user rarely sees
 *  a "loading more" pause while scrolling. */
const LOAD_MORE_THRESHOLD = 8;

export const VariationItemsTable = ({
  items,
  onRowClick,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: VariationItemsTableProps) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  // Near-end watcher → infinite scroll. Fires onLoadMore when the
  // last virtualized item is within LOAD_MORE_THRESHOLD of the end.
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    if (!hasMore || isLoadingMore || !onLoadMore) return;
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= items.length - LOAD_MORE_THRESHOLD) {
      onLoadMore();
    }
  }, [virtualItems, items.length, hasMore, isLoadingMore, onLoadMore]);

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-auto"
      style={{ contain: 'strict' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map(virtualRow => {
          const item = items[virtualRow.index];
          return (
            <div
              key={item.variationKey}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                paddingBottom: '4px',
              }}
            >
              <VariationItemRow
                item={item}
                onClick={onRowClick ? () => onRowClick(item) : undefined}
              />
            </div>
          );
        })}
      </div>
      {isLoadingMore && (
        <div className="text-xs text-gray-500 dark:text-gray-400 px-3 py-2">
          Loading more…
        </div>
      )}
    </div>
  );
};

// Re-export for callers that need the row label logic externally
// (e.g., the detail drawer header in Phase 4 will reuse the pill).
export { ballWithWhom, humanizeTimeAgo };
export type { Pill };
