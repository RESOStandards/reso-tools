import { useEffect, useState } from 'react';
import { fetchFieldsForResource, fetchLookupsForResource } from '../api/metadata';
import { useServer } from '../context/server-context';
import type { ResoField, ResoLookup } from '../types';

export interface UseMetadataResult {
  readonly fields: ReadonlyArray<ResoField>;
  readonly lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>;
  readonly isLoading: boolean;
  readonly error: string | null;
}

/** Fetches and caches field definitions and lookups for a resource. */
export const useMetadata = (resource: string): UseMetadataResult => {
  const { activeServer, isLocal, hasLookupResource } = useServer();
  const [fields, setFields] = useState<ReadonlyArray<ResoField>>([]);
  const [lookups, setLookups] = useState<Readonly<Record<string, ReadonlyArray<ResoLookup>>>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const metaOptions = isLocal
      ? undefined
      : { baseUrl: activeServer.baseUrl, token: activeServer.token, hasLookupResource };

    const load = async () => {
      try {
        const [fieldsResult, lookupsResult] = await Promise.all([
          fetchFieldsForResource(resource, metaOptions),
          fetchLookupsForResource(resource, metaOptions)
        ]);
        if (!cancelled) {
          setFields(fieldsResult);
          setLookups(lookupsResult);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load metadata');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [resource, activeServer.id, isLocal, hasLookupResource]);

  return { fields, lookups, isLoading, error };
};
