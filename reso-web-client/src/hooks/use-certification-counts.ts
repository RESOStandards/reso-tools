/**
 * Data hook for the global Cert API certification counts.
 *
 * Fires once on mount (per auth-key change) and caches in module state
 * for the lifetime of the page so multiple consumers don't refetch.
 * The response is keyed by endorsement slug (`{type}_{version}`),
 * status name, plus the special keys `all` and `legacy`.
 */

import { useEffect, useState } from 'react';
import {
  fetchCertificationCounts,
  type CertificationCounts
} from '../api/cert-client';
import { useAuth } from './use-auth';

export interface UseCertificationCountsResult {
  readonly counts: CertificationCounts | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export const useCertificationCounts = (): UseCertificationCountsResult => {
  const { user, isHydrating } = useAuth();
  const apiKey = user?.token ?? null;

  const [counts, setCounts] = useState<CertificationCounts | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isHydrating) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchCertificationCounts(apiKey)
      .then((data) => {
        if (!cancelled) {
          setCounts(data);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load counts';
        setError(message);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, isHydrating]);

  return { counts, isLoading, error };
};
