/**
 * Hook: fetch a single organization's detail from the cert API and
 * return it in the canonical RESO OUID shape.
 *
 * Uses the /organization?uoi=X endpoint on certqa.reso.org, adapted
 * to ResoOrganization via cert-org-adapter. Caches per UOI so
 * repeated renders do not re-fetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOrganizationDetail } from '../api/cert-client.js';
import { certOrgToResoOrganization } from '../api/cert-org-adapter.js';
import { useAuth } from './use-auth.js';
import type { ResoOrganization } from '../types.js';

/** Module-level cache keyed by UOI. */
const cache = new Map<string, ResoOrganization>();

export interface UseCertOrgDetailResult {
  readonly org: ResoOrganization | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export const useCertOrgDetail = (uoi: string | undefined): UseCertOrgDetailResult => {
  const { user } = useAuth();
  const apiKey = user?.token ?? null;

  const [org, setOrg] = useState<ResoOrganization | null>(
    () => (uoi ? cache.get(uoi) ?? null : null)
  );
  const [isLoading, setIsLoading] = useState(!org && !!uoi);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchDetail = useCallback(async (targetUoi: string) => {
    const cached = cache.get(targetUoi);
    if (cached) {
      setOrg(cached);
      setIsLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const detail = await fetchOrganizationDetail(apiKey, targetUoi);
      if (controller.signal.aborted) return;

      const adapted = certOrgToResoOrganization(detail);
      cache.set(targetUoi, adapted);
      setOrg(adapted);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // eslint-disable-next-line no-console
      console.warn('[cert] org detail fetch failed:', err);
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, [apiKey]);

  useEffect(() => {
    if (!uoi) return;
    void fetchDetail(uoi);
    return () => {
      abortRef.current?.abort();
    };
  }, [uoi, fetchDetail]);

  return { org, isLoading, error };
};
