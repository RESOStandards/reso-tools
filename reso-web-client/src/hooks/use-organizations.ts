import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrganizationsResponse, ResoOrganization } from '../types';

const ORGS_URL = 'https://services.reso.org/orgs?showEndorsements=true';

/** Module-level cache so data persists across component mounts. */
let cached: { data: OrganizationsResponse; fetchedAt: number } | null = null;

/** Fetch and cache RESO Organizations and Endorsements data. Reusable across pages. */
export const useOrganizations = () => {
  const [organizations, setOrganizations] = useState<ReadonlyArray<ResoOrganization>>(cached?.data.Organizations ?? []);
  const [generatedOn, setGeneratedOn] = useState<string | null>(cached?.data.GeneratedOn ?? null);
  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (force = false) => {
    if (cached && !force) {
      setOrganizations(cached.data.Organizations);
      setGeneratedOn(cached.data.GeneratedOn);
      setIsLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(ORGS_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = (await res.json()) as OrganizationsResponse;
      cached = { data: json, fetchedAt: Date.now() };
      setOrganizations(json.Organizations);
      setGeneratedOn(json.GeneratedOn);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message ?? 'Failed to fetch organizations');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refresh = useCallback(() => fetchData(true), [fetchData]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  return { organizations, generatedOn, isLoading, error, refresh };
};
