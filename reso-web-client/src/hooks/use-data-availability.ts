/**
 * Hook: fetch the data availability report (per-field + per-lookup-value availability).
 *
 * GET /payload/data_availability/:reportId
 */

import { useEffect, useState } from 'react';
import { fetchDataAvailability, type DataAvailabilityReport } from '../api/cert-client.js';

export interface UseDataAvailabilityResult {
  readonly data: DataAvailabilityReport | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export const useDataAvailability = (
  reportId: string | undefined
): UseDataAvailabilityResult => {
  const [data, setData] = useState<DataAvailabilityReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportId) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchDataAvailability(reportId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [reportId]);

  return { data, isLoading, error };
};
