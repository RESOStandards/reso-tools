/**
 * Hook that fetches the Cert API organization directory and exposes
 * lookups for both organization display names and provider system
 * (product) names.
 *
 * The /filter endpoint only carries UOI keys and provider USIs, so
 * without these lookups the UI reads as raw IDs to non-technical
 * users. The directory is small (~few hundred KB) and changes
 * rarely, so we fetch once per page load and cache in module state
 * shared across consumers.
 */

import { useEffect, useState } from 'react';
import { fetchOrganizations } from '../api/cert-client';
import { useAuth } from './use-auth';

interface DirectoryCache {
  readonly names: ReadonlyMap<string, string>;
  /** Key shape: `${providerUoi}:${usi}` */
  readonly systems: ReadonlyMap<string, string>;
}

let cache: DirectoryCache | null = null;
let rawOrgs: ReadonlyArray<import('../api/cert-client').CertOrganization> | null = null;
let inFlight: Promise<DirectoryCache> | null = null;

const systemKey = (providerUoi: string, usi: string): string =>
  `${providerUoi}:${usi}`;

const loadDirectory = async (_apiKey: string | null): Promise<DirectoryCache> => {
  if (cache) return cache;
  if (inFlight) return inFlight;

  inFlight = fetchOrganizations(null).then((orgs) => {
    rawOrgs = orgs;
    const names = new Map<string, string>();
    const systems = new Map<string, string>();
    for (const org of orgs) {
      if (org.id && org.name) names.set(org.id, org.name);
      if (org.systems) {
        for (const sys of org.systems) {
          if (sys.usi && sys.systemName) {
            systems.set(systemKey(org.id, sys.usi), sys.systemName);
          }
        }
      }
    }
    cache = { names, systems };
    inFlight = null;
    return cache;
  });

  return inFlight;
};

/** Prefetch the org directory in the background (call early, e.g. on dashboard mount). */
export const prefetchOrganizations = (apiKey: string | null): void => {
  loadDirectory(apiKey).catch(() => {});
};

/** Get the raw orgs list from cache, or fetch if not yet loaded. */
export const getOrganizations = async (apiKey: string | null): Promise<ReadonlyArray<import('../api/cert-client').CertOrganization>> => {
  await loadDirectory(apiKey);
  return rawOrgs ?? [];
};

export interface UseOrganizationNamesResult {
  readonly lookup: (uoi: string | undefined | null) => string | undefined;
  readonly lookupSystem: (
    providerUoi: string | undefined | null,
    providerUsi: string | undefined | null
  ) => string | undefined;
  readonly isLoading: boolean;
}

export const useOrganizationNames = (): UseOrganizationNamesResult => {
  const { user, isHydrating } = useAuth();
  const apiKey = user?.token ?? null;

  const [directory, setDirectory] = useState<DirectoryCache | null>(cache);
  const [isLoading, setIsLoading] = useState(cache === null);

  useEffect(() => {
    if (isHydrating) return;
    if (cache) {
      setDirectory(cache);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    loadDirectory(apiKey)
      .then((d) => {
        if (!cancelled) {
          setDirectory(d);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, isHydrating]);

  const lookup = (uoi: string | undefined | null): string | undefined => {
    if (!uoi) return undefined;
    return directory?.names.get(uoi);
  };

  const lookupSystem = (
    providerUoi: string | undefined | null,
    providerUsi: string | undefined | null
  ): string | undefined => {
    if (!providerUoi || !providerUsi) return undefined;
    return directory?.systems.get(systemKey(providerUoi, providerUsi));
  };

  return { lookup, lookupSystem, isLoading };
};
