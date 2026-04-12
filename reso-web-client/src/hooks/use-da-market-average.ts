/**
 * Hook: fetch per-resource data availability market averages.
 *
 * POST /payload/data_availability/market-average with report IDs
 * returns per-resource industry averages and the provider's own
 * availability buckets.
 */

import { useEffect, useState } from 'react';
import { fetchDAMarketAverage, type DAMarketAverageResponse } from '../api/cert-client.js';

export interface UseDAMarketAverageResult {
  readonly data: DAMarketAverageResponse | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export const useDAMarketAverage = (
  reportIds: ReadonlyArray<string> | undefined
): UseDAMarketAverageResult => {
  const [data, setData] = useState<DAMarketAverageResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportIds || reportIds.length === 0) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchDAMarketAverage(reportIds)
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
  }, [reportIds?.join(',')]);

  return { data, isLoading, error };
};
