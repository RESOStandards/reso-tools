/**
 * Hook: fetch global DD market averages from the cert API.
 *
 * Public endpoint, no auth needed. Cached globally — averages
 * change slowly (new certs trickle in) so one fetch per session
 * is sufficient.
 */

import { useEffect, useState } from 'react';
import { fetchMarketAverages, type MarketAverages } from '../api/cert-client.js';

export interface UseMarketAveragesResult {
  readonly averages: MarketAverages | null;
  readonly isLoading: boolean;
}

export const useMarketAverages = (): UseMarketAveragesResult => {
  const [averages, setAverages] = useState<MarketAverages | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchMarketAverages()
      .then((data) => {
        if (!cancelled) setAverages(data);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[cert] market averages fetch failed:', err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { averages, isLoading };
};
