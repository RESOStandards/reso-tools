import { useCallback, useRef, useState } from 'react';
import { fetchLookupsByName } from '../api/metadata';
import { useServer } from '../context/server-context';
import type { ResoField, ResoLookup } from '../types';
import { isEnumType } from '../types';

/**
 * Get the lookup/enum name for a field. Exported for use by pages that
 * need to build a list of lookup names to fetch. Works for both:
 * - Lookup Resource fields (have lookupName annotation)
 * - CSDL EnumType fields (non-Edm type, e.g. "org.reso.metadata.StandardStatus" → "StandardStatus")
 */
export const getLookupName = (field: ResoField): string | undefined => {
  if (field.lookupName) return field.lookupName;
  if (field.isExpansion || field.isCollection) return undefined;
  if (isEnumType(field.type)) {
    const dotIndex = field.type.lastIndexOf('.');
    return dotIndex >= 0 ? field.type.slice(dotIndex + 1) : field.type;
  }
  return undefined;
};

export interface UseLookupResult {
  /** Lookup values keyed by lookup name. Grows as more lookups are fetched. */
  readonly lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>;
  /** Fetch lookups for specific lookup names. Cached names resolve instantly. */
  readonly fetchLookups: (lookupNames: ReadonlyArray<string>) => Promise<void>;
  /** Whether any lookup fetch is currently in progress. */
  readonly isLoading: boolean;
  /** Map lookup values by field name (for components that key by field name like RecordForm). */
  readonly lookupsByField: (fields: ReadonlyArray<ResoField>) => Readonly<Record<string, ReadonlyArray<ResoLookup>>>;
}

/**
 * Lazy lookup fetcher. Components call fetchLookups() with the specific
 * lookup names they need. Results are cached — subsequent calls for the
 * same names are instant. No lookups are fetched until explicitly requested.
 */
export const useLookups = (): UseLookupResult => {
  const { activeServer, isLocal, currentToken } = useServer();
  const [lookups, setLookups] = useState<Readonly<Record<string, ReadonlyArray<ResoLookup>>>>({});
  const [isLoading, setIsLoading] = useState(false);
  /** Track which lookup names have already been requested to avoid duplicate fetches. */
  const requestedRef = useRef(new Set<string>());

  const fetchLookups = useCallback(async (lookupNames: ReadonlyArray<string>) => {
    // Filter to only names we haven't requested yet
    const needed = lookupNames.filter(name => !requestedRef.current.has(name));
    if (needed.length === 0) return;

    // Mark as requested immediately to prevent duplicate concurrent fetches
    for (const name of needed) requestedRef.current.add(name);

    const metaOptions = isLocal
      ? undefined
      : { baseUrl: activeServer.baseUrl, token: currentToken ?? activeServer.token };

    setIsLoading(true);
    try {
      const result = await fetchLookupsByName(needed, metaOptions);
      setLookups(prev => ({ ...prev, ...result }));
    } catch {
      // Remove from requested so they can be retried
      for (const name of needed) requestedRef.current.delete(name);
    } finally {
      setIsLoading(false);
    }
  }, [activeServer.baseUrl, activeServer.id, isLocal, currentToken]);

  /** Map fetched lookups from lookupName keys to fieldName keys. */
  const lookupsByField = useCallback(
    (fields: ReadonlyArray<ResoField>): Readonly<Record<string, ReadonlyArray<ResoLookup>>> => {
      const result: Record<string, ReadonlyArray<ResoLookup>> = {};
      for (const field of fields) {
        const name = getLookupName(field);
        if (name && lookups[name]) result[field.fieldName] = lookups[name];
      }
      return result;
    },
    [lookups]
  );

  return { lookups, fetchLookups, isLoading, lookupsByField };
};
