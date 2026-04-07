/**
 * Data hook for the public Endorsements list.
 *
 * Fetches from POST /api/v1/certification_reports/filter via the
 * existing /api/proxy pipe to certqa.reso.org. Owns server-side
 * pagination via the `from` cursor — each call to `loadMore()` issues
 * one network request and appends the new page to the accumulated set.
 *
 * Filter state (status, type, search, showMyResults) is part of the
 * hook input, not a post-fetch filter. Changing any filter resets the
 * accumulated set and re-fetches from page 1. An AbortController
 * prevents a stale in-flight request from overwriting a fresher one.
 *
 * Sign-in state matters but isn't required: the hook tries the user's
 * API key when signed in, attempts an anonymous call when not, and
 * falls back to fixtures only if both paths fail (network error,
 * unreachable, etc.). The fallback is exposed via `source` so the page
 * can show a small badge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CertApiAuthError,
  fetchEndorsements,
  type FetchReportsOptions,
  type FetchReportsResponse
} from '../api/cert-client';
import { ENDORSEMENT_FIXTURES, type Endorsement } from '../api/cert-fixtures';
import { responseToEndorsements } from '../api/endorsement-adapter';
import { useAuth } from './use-auth';

export type EndorsementsSource = 'live' | 'fixtures';

export interface UseEndorsementsInput {
  readonly statusFilter?: ReadonlyArray<string>;
  readonly endorsementFilter?: ReadonlyArray<string>;
  readonly searchKey?: string;
  readonly showMyResults?: boolean;
  /** Sort direction. Defaults to "desc" (most recent / Z→A first). */
  readonly sortBy?: 'asc' | 'desc';
  /** When true, sort by timestamp; when false, sort by name. */
  readonly sortByTimestamp?: boolean;
}

export interface UseEndorsementsResult {
  readonly endorsements: ReadonlyArray<Endorsement>;
  /** True before the first page lands. Use this to gate the initial skeleton. */
  readonly isLoadingInitial: boolean;
  /** True while a `loadMore()` request is in flight. */
  readonly isLoadingMore: boolean;
  /** True if there are more pages to fetch from the server. */
  readonly hasMore: boolean;
  readonly source: EndorsementsSource;
  /** Non-fatal — the call failed but we have fixtures to show instead. */
  readonly fallbackError: string | null;
  /** Trigger the next page fetch. No-op if already loading or exhausted. */
  loadMore: () => void;
  /** Force a fresh first-page fetch (e.g. after sign-in or sign-out). */
  refetch: () => void;
}

/** Empty arrays are normalized to a shared frozen reference so the
 *  options memo below has stable identity when nothing is filtered. */
const EMPTY_ARRAY: ReadonlyArray<string> = Object.freeze([]);

/**
 * Stable JSON key for an array of filter strings — used to drive
 * effect re-runs by *value* rather than by reference, so callers
 * don't have to memoize their input arrays.
 */
const arrayKey = (arr: ReadonlyArray<string> | undefined): string =>
  arr && arr.length > 0 ? [...arr].sort().join(',') : '';

export const useEndorsements = (
  input: UseEndorsementsInput = {}
): UseEndorsementsResult => {
  const { user, isHydrating } = useAuth();
  const apiKey = user?.token ?? null;

  const statusFilter = input.statusFilter ?? EMPTY_ARRAY;
  const endorsementFilter = input.endorsementFilter ?? EMPTY_ARRAY;
  const searchKey = input.searchKey ?? '';
  const showMyResults = input.showMyResults ?? false;
  const sortBy = input.sortBy ?? 'desc';
  const sortByTimestamp = input.sortByTimestamp ?? true;

  // Stable per-value keys so effect deps fire only when content changes,
  // not when caller passes a new array reference for the same values.
  const statusKey = arrayKey(statusFilter);
  const endorsementKey = arrayKey(endorsementFilter);

  const [endorsements, setEndorsements] = useState<ReadonlyArray<Endorsement>>(
    []
  );
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextFrom, setNextFrom] = useState<number | null>(0);
  const [source, setSource] = useState<EndorsementsSource>('live');
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const [refetchCounter, setRefetchCounter] = useState(0);

  // Tracks the latest abort controller so a new fetch can cancel its
  // predecessors and we don't race responses against each other.
  const abortRef = useRef<AbortController | null>(null);

  // Stable options object derived from the primitive filter values.
  // Recreated only when one of the filters actually changes.
  const baseOptions = useMemo<FetchReportsOptions>(
    () => ({
      sortBy,
      sortByTimestamp,
      ...(statusFilter.length > 0 ? { statusFilter } : {}),
      ...(endorsementFilter.length > 0 ? { endorsementFilter } : {}),
      ...(searchKey ? { searchKey } : {}),
      ...(showMyResults ? { showMyResults: true } : {})
    }),
    // statusFilter / endorsementFilter intentionally excluded — we key
    // on the value-based string instead so reference-only changes don't
    // refire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusKey, endorsementKey, searchKey, showMyResults, sortBy, sortByTimestamp]
  );

  /** Internal: perform a single fetch at the given `from` cursor. */
  const fetchPage = useCallback(
    async (from: number, append: boolean): Promise<void> => {
      // Cancel any in-flight request for stale state
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoadingInitial(true);
        setFallbackError(null);
      }

      try {
        const response: FetchReportsResponse = await fetchEndorsements(
          apiKey,
          { ...baseOptions, from }
        );
        if (controller.signal.aborted) return;

        // eslint-disable-next-line no-console
        console.log(
          '[cert] /certification_reports/filter response:',
          { from, append, response }
        );

        const adapted = responseToEndorsements(response);
        const reportsByOrgsEmpty =
          !response.reportsByOrgs ||
          Object.keys(response.reportsByOrgs).length === 0;

        // Cursor: server returns lastUoiIndex; if absent or empty page,
        // we're done paginating.
        const newCursor: number | null = reportsByOrgsEmpty
          ? null
          : (response.lastUoiIndex ?? null);

        setNextFrom(newCursor);
        setEndorsements((prev) => (append ? [...prev, ...adapted] : adapted));
        setSource(adapted.length > 0 ? 'live' : append ? 'live' : 'fixtures');
        if (!append && adapted.length === 0) {
          // First page came back empty — fall back to fixtures so the
          // UI has something to render, but tag the source explicitly.
          setEndorsements(ENDORSEMENT_FIXTURES);
          setFallbackError('Cert API returned no records — showing fixtures');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        const message =
          err instanceof CertApiAuthError
            ? `Cert API error (${err.httpStatus}) — showing fixtures`
            : err instanceof Error
              ? `${err.message} — showing fixtures`
              : 'Cert API unreachable — showing fixtures';

        if (append) {
          // A loadMore() failed mid-stream — keep what we have, just
          // surface the error and stop pagination.
          setFallbackError(message);
          setNextFrom(null);
        } else {
          setEndorsements(ENDORSEMENT_FIXTURES);
          setSource('fixtures');
          setFallbackError(message);
          setNextFrom(null);
        }

        // eslint-disable-next-line no-console
        console.warn('[cert] endorsements fetch failed:', err);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingInitial(false);
          setIsLoadingMore(false);
        }
      }
    },
    [apiKey, baseOptions]
  );

  // Initial / reset fetch — fires whenever the filters or auth change.
  useEffect(() => {
    if (isHydrating) return;
    void fetchPage(0, false);
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchPage, isHydrating, refetchCounter]);

  const loadMore = useCallback(() => {
    if (nextFrom === null || isLoadingMore || isLoadingInitial) return;
    void fetchPage(nextFrom, true);
  }, [fetchPage, nextFrom, isLoadingMore, isLoadingInitial]);

  return {
    endorsements,
    isLoadingInitial,
    isLoadingMore,
    hasMore: nextFrom !== null,
    source,
    fallbackError,
    loadMore,
    refetch: () => setRefetchCounter((c) => c + 1)
  };
};
