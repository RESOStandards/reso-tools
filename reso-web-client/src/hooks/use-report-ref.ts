/**
 * React hook for resolving a report reference (path or URL) to its parsed content.
 */

import { useEffect, useState } from 'react';
import { resolveReportRef, ReportMissingError } from '../services/report-ref';

export interface ReportRefState<T = unknown> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
  /** True when the error is specifically a missing local file (opportunity to prompt the user to clean up). */
  readonly missing: boolean;
}

/**
 * Resolve a report ref when it changes. Returns `{ data, loading, error, missing }`.
 * When `ref` is undefined, no fetch happens and state stays at initial.
 */
export const useReportRef = <T = unknown>(ref: string | undefined, authHeader?: string): ReportRefState<T> => {
  const [state, setState] = useState<ReportRefState<T>>({ data: null, loading: false, error: null, missing: false });

  useEffect(() => {
    if (!ref) {
      setState({ data: null, loading: false, error: null, missing: false });
      return;
    }

    let cancelled = false;
    setState({ data: null, loading: true, error: null, missing: false });

    resolveReportRef(ref, authHeader)
      .then(data => {
        if (cancelled) return;
        setState({ data: data as T, loading: false, error: null, missing: false });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error: err,
          missing: err instanceof ReportMissingError,
        });
      });

    return () => { cancelled = true; };
  }, [ref, authHeader]);

  return state;
};
