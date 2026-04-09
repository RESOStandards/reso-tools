/**
 * Hook: fetch all cert report summaries for an org from the cert API.
 *
 * Returns the raw array from /certification_reports/summary/:uoi,
 * cached per UOI so repeated renders do not re-fetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCertReportSummary,
  type CertReportSummary,
} from '../api/cert-client.js';
import { useAuth } from './use-auth.js';

const cache = new Map<string, ReadonlyArray<CertReportSummary>>();

export interface UseCertReportSummaryResult {
  readonly reports: ReadonlyArray<CertReportSummary>;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export const useCertReportSummary = (
  uoi: string | undefined
): UseCertReportSummaryResult => {
  const { user } = useAuth();
  const apiKey = user?.token ?? null;

  const [reports, setReports] = useState<ReadonlyArray<CertReportSummary>>(
    () => (uoi ? cache.get(uoi) ?? [] : [])
  );
  const [isLoading, setIsLoading] = useState(reports.length === 0 && !!uoi);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchSummary = useCallback(
    async (targetUoi: string) => {
      const cached = cache.get(targetUoi);
      if (cached) {
        setReports(cached);
        setIsLoading(false);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setError(null);

      try {
        const result = await fetchCertReportSummary(apiKey, targetUoi);
        if (controller.signal.aborted) return;

        cache.set(targetUoi, result);
        setReports(result);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        // eslint-disable-next-line no-console
        console.warn('[cert] report summary fetch failed:', err);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    [apiKey]
  );

  useEffect(() => {
    if (!uoi) return;
    void fetchSummary(uoi);
    return () => {
      abortRef.current?.abort();
    };
  }, [uoi, fetchSummary]);

  return { reports, isLoading, error };
};
