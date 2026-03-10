import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCollectionByUrl, queryCollection } from '../api/client.js';

const PAGE_SIZE = 25;

/** Patterns that indicate the server doesn't support the query, with user-friendly messages. */
const UNSUPPORTED_QUERY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/cannot find property/i, 'The server does not recognize a property used in this query. Try removing or adjusting your filter.'],
  [/not supported/i, 'This query uses features the server does not support. Try simplifying your filter.'],
  [/too complex/i, 'The server considers this query too complex. Try reducing the number of filters or simplifying conditions.'],
  [/invalid filter/i, 'The server rejected this filter expression. Check the syntax and try again.'],
  [/unknown property/i, 'The server does not recognize a property used in this query. Try removing or adjusting your filter.'],
  [/syntax error/i, 'The server could not parse this query. Check the filter syntax and try again.'],
];

/** Transforms raw server error messages into user-friendly descriptions. */
const humanizeError = (raw: string): string => {
  for (const [pattern, friendly] of UNSUPPORTED_QUERY_PATTERNS) {
    if (pattern.test(raw)) return `${friendly}\n\nServer response: ${raw}`;
  }
  return raw;
};

export interface UseCollectionResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly count: number | undefined;
  readonly isLoading: boolean;
  readonly hasMore: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
}

/** Fetches a resource collection with server-driven pagination via @odata.nextLink. */
export const useCollection = (
  resource: string,
  params: { $filter?: string; $orderby?: string; $select?: string; $expand?: string },
  /** When false, the hook defers fetching until enabled. Prevents race conditions with dependent data. */
  enabled = true
): UseCollectionResult => {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [count, setCount] = useState<number | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const nextLinkRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset when resource or params change
  useEffect(() => {
    setRows([]);
    setCount(undefined);
    setHasMore(true);
    setError(null);
    nextLinkRef.current = null;

    if (!enabled) return;

    const loadFirst = async () => {
      setIsLoading(true);
      try {
        abortRef.current?.abort();
        abortRef.current = new AbortController();

        // Use Prefer: odata.maxpagesize for server-driven pagination instead of $top.
        // $top limits the total result set; maxpagesize tells the server the preferred page size
        // while allowing it to return @odata.nextLink for subsequent pages.
        const result = await queryCollection(resource, {
          $filter: params.$filter || undefined,
          $orderby: params.$orderby || undefined,
          $select: params.$select || undefined,
          $expand: params.$expand || undefined,
          $count: true
        }, PAGE_SIZE);

        setRows([...result.value]);
        if (result['@odata.count'] !== undefined) {
          setCount(result['@odata.count']);
        }
        // Use server-provided nextLink for pagination
        nextLinkRef.current = result['@odata.nextLink'] ?? null;
        setHasMore(nextLinkRef.current !== null);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : ((err as { error?: { message?: string } })?.error?.message ?? 'Failed to load data');
        setError(humanizeError(msg));
      } finally {
        setIsLoading(false);
      }
    };

    loadFirst();

    return () => {
      abortRef.current?.abort();
    };
  }, [resource, params.$filter, params.$orderby, params.$select, params.$expand, enabled]);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore || !nextLinkRef.current) return;
    setIsLoading(true);
    try {
      // Follow the server-provided @odata.nextLink, preserving the page size preference
      const result = await fetchCollectionByUrl(nextLinkRef.current, PAGE_SIZE);

      setRows(prev => [...prev, ...result.value]);
      nextLinkRef.current = result['@odata.nextLink'] ?? null;
      setHasMore(nextLinkRef.current !== null);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : ((err as { error?: { message?: string } })?.error?.message ?? 'Failed to load more data');
      setError(humanizeError(msg));
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, hasMore]);

  return { rows, count, isLoading, hasMore, error, loadMore };
};
