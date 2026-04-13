/**
 * Hook: fetch performance metrics for a cert report.
 *
 * GET /payload/performance/provider-metrics/:reportId
 * Returns provider vs. industry performance comparison.
 * If the provider has opted out, performanceReport resource data
 * will be absent but marketAverage is always present.
 */

import { useEffect, useState } from 'react';
import { fetchPerformanceMetrics, type PerformanceMetricsReport } from '../api/cert-client.js';

export interface UsePerformanceMetricsResult {
  readonly data: PerformanceMetricsReport | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export const usePerformanceMetrics = (
  reportId: string | undefined
): UsePerformanceMetricsResult => {
  const [data, setData] = useState<PerformanceMetricsReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportId) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchPerformanceMetrics(reportId)
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
