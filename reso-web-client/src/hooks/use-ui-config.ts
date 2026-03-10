import { useEffect, useState } from 'react';
import { fetchFieldGroups, fetchUiConfig } from '../api/config';
import { useServer } from '../context/server-context';
import type { FieldGroups, UiConfig } from '../types';

export interface UseUiConfigResult {
  readonly config: UiConfig | null;
  readonly fieldGroups: FieldGroups | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

/** Fetches and caches the UI config and field groups. */
export const useUiConfig = (): UseUiConfigResult => {
  const { activeServer, isLocal } = useServer();
  const [config, setConfig] = useState<UiConfig | null>(null);
  const [fieldGroups, setFieldGroups] = useState<FieldGroups | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    const load = async () => {
      try {
        const [uiConfig, groups] = await Promise.all([fetchUiConfig(isLocal), fetchFieldGroups()]);
        if (!cancelled) {
          setConfig(uiConfig);
          setFieldGroups(groups);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load UI config');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [activeServer.id, isLocal]);

  return { config, fieldGroups, isLoading, error };
};
