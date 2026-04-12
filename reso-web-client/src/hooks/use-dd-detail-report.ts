/**
 * Hook: fetch the full DD detail report (field catalog + advertised counts).
 *
 * GET /certification_reports/data_dictionary/detail/:version/:recipientUoi/:providerUoi/:providerUsi?status=certified
 */

import { useEffect, useState } from 'react';
import { fetchDDDetailReport, type DDDetailReport } from '../api/cert-client.js';

export interface UseDDDetailReportResult {
  readonly data: DDDetailReport | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export const useDDDetailReport = (
  version: string | undefined,
  recipientUoi: string | undefined,
  providerUoi: string | undefined,
  providerUsi: string | undefined,
  status = 'certified'
): UseDDDetailReportResult => {
  const [data, setData] = useState<DDDetailReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!version || !recipientUoi || !providerUoi || !providerUsi) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchDDDetailReport(version, recipientUoi, providerUoi, providerUsi, status)
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
  }, [version, recipientUoi, providerUoi, providerUsi, status]);

  return { data, isLoading, error };
};
