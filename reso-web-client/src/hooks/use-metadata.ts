import { useEffect, useState } from 'react';
import { fetchFieldsForResource } from '../api/metadata';
import { useServer } from '../context/server-context';
import type { ResoField } from '../types';

export interface UseMetadataResult {
  readonly fields: ReadonlyArray<ResoField>;
  readonly isLoading: boolean;
  readonly error: string | null;
}

/** Fetches and caches field definitions for a resource from $metadata. */
export const useMetadata = (resource: string): UseMetadataResult => {
  const { activeServer, isLocal, currentToken } = useServer();
  const [fields, setFields] = useState<ReadonlyArray<ResoField>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const metaOptions = isLocal
      ? undefined
      : { baseUrl: activeServer.baseUrl, token: currentToken ?? activeServer.token };

    const load = async () => {
      try {
        const fieldsResult = await fetchFieldsForResource(resource, metaOptions);
        if (!cancelled) setFields(fieldsResult);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load metadata');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [resource, activeServer.id, isLocal, currentToken]);

  return { fields, isLoading, error };
};
