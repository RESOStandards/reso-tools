import { useEffect, useRef, type RefObject } from 'react';

interface UseInfiniteScrollOptions {
  /** True when more items are available beyond what's currently rendered. */
  readonly hasMore: boolean;
  /** True while a load is in flight — prevents duplicate triggers. */
  readonly isLoading: boolean;
  /** Called when the sentinel enters the viewport. */
  readonly onLoadMore: () => void;
  /**
   * How far before the sentinel reaches the viewport edge to fire the
   * load. Larger values prefetch more eagerly. Defaults to 240px so
   * the next page lands before the user actually hits the end.
   */
  readonly rootMargin?: string;
}

/**
 * Hook that wires an IntersectionObserver to a caller-owned sentinel
 * element. The caller renders the sentinel however it likes (loading
 * spinner, "end of list" message, etc.) and attaches the returned ref
 * to it. When the sentinel scrolls into view (with `rootMargin`
 * pre-trigger), `onLoadMore` fires once.
 *
 * Re-binds whenever any input changes, so callers can pass freshly
 * captured `onLoadMore` closures without worrying about staleness.
 *
 * Returns a generic `RefObject<HTMLDivElement | null>` because the
 * sentinel is almost always a `<div>`. Cast at the call site if you
 * need a different element type.
 */
export const useInfiniteScroll = ({
  hasMore,
  isLoading,
  onLoadMore,
  rootMargin = '240px'
}: UseInfiniteScrollOptions): RefObject<HTMLDivElement | null> => {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !isLoading && hasMore) {
          onLoadMore();
        }
      },
      { rootMargin }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, onLoadMore, rootMargin]);

  return sentinelRef;
};
