/**
 * Live / Fixtures source badge. Cert-specific because the live ↔ fixture
 * fallback is a Cert-section concern — the OData browser doesn't have
 * fixture data.
 */

import type { EndorsementsSource } from '../../hooks/use-endorsements';

interface SourceBadgeProps {
  readonly source: EndorsementsSource;
  readonly title?: string;
}

export const SourceBadge = ({ source, title }: SourceBadgeProps) =>
  source === 'live' ? (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider bg-green-50 text-green-700 ring-1 ring-green-200/70 dark:bg-green-900/30 dark:text-green-300 dark:ring-green-900/40"
      title={title ?? 'Live data from certqa.reso.org'}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      Live
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider bg-amber-50 text-amber-700 ring-1 ring-amber-200/70 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-900/40"
      title={title ?? 'Showing fixture data'}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      Fixtures
    </span>
  );
