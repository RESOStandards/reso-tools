/**
 * Hook: fetch the currently signed-in provider's systems (USIs) from
 * the cert API and cache them for the session.
 *
 * Used by the cert config-builder to enforce the provider lock — when
 * a non-admin user is signed in, their provider UOI is fixed to
 * `user.uoi` and the system identifier is constrained to whatever
 * USIs their organization has configured. With one USI the field
 * silently picks it; with several the form must show a select.
 *
 * Returns null/empty for admin users and for unauthenticated sessions —
 * neither has a "current provider" to resolve.
 */

import { useEffect, useState } from 'react';
import { fetchOrganizationDetail, type CertOrganizationSystem } from '../api/cert-client.js';
import { useAuth } from './use-auth.js';

interface UseCurrentUserSystemsResult {
  readonly systems: ReadonlyArray<CertOrganizationSystem>;
  readonly isLoading: boolean;
  readonly error: string | null;
}

/** Module-level cache keyed by UOI so multiple consumers don't refetch. */
const cache = new Map<string, ReadonlyArray<CertOrganizationSystem>>();

export const useCurrentUserSystems = (): UseCurrentUserSystemsResult => {
  const { user, isAdmin } = useAuth();
  const uoi = user?.uoi ?? null;
  const apiKey = user?.token ?? null;

  const [systems, setSystems] = useState<ReadonlyArray<CertOrganizationSystem>>(
    () => (uoi ? cache.get(uoi) ?? [] : []),
  );
  const [isLoading, setIsLoading] = useState(!!uoi && !cache.has(uoi) && !isAdmin);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Admins aren't subject to the provider lock; skip the fetch.
    if (!uoi || isAdmin) {
      setSystems([]);
      setIsLoading(false);
      return;
    }

    const cached = cache.get(uoi);
    if (cached) {
      setSystems(cached);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchOrganizationDetail(apiKey, uoi)
      .then((detail) => {
        if (cancelled) return;
        const next = detail.systems ?? [];
        cache.set(uoi, next);
        setSystems(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load systems');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [uoi, isAdmin, apiKey]);

  return { systems, isLoading, error };
};
