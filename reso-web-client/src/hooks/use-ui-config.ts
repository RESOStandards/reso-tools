import { useEffect, useState } from 'react';
import { fetchFieldGroups, fetchSummaryFields, fetchUiConfig } from '../api/config';
import { useServer } from '../context/server-context';
import type { FieldGroups, SummaryFieldsConfig, UiConfig } from '../types';

export interface UseUiConfigResult {
  readonly config: UiConfig | null;
  readonly fieldGroups: FieldGroups | null;
  readonly summaryFieldsConfig: SummaryFieldsConfig | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

/** Fetches and caches the UI config, field groups, and default summary fields. */
export const useUiConfig = (): UseUiConfigResult => {
  const { activeServer, isLocal } = useServer();
  const [config, setConfig] = useState<UiConfig | null>(null);
  const [fieldGroups, setFieldGroups] = useState<FieldGroups | null>(null);
  const [summaryFieldsConfig, setSummaryFieldsConfig] = useState<SummaryFieldsConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    const load = async () => {
      try {
        const [uiConfig, groups, summaryFields] = await Promise.all([
          fetchUiConfig(isLocal),
          fetchFieldGroups(),
          fetchSummaryFields(),
        ]);
        if (!cancelled) {
          setConfig(uiConfig);
          setFieldGroups(groups);
          setSummaryFieldsConfig(summaryFields);
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

  return { config, fieldGroups, summaryFieldsConfig, isLoading, error };
};
