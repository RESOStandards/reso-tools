/**
 * One endorsement inside a recipient group card.
 *
 * The parent card already shows the recipient organization, so this
 * sub-row leads with the *endorsement type+version* and treats provider
 * context, status, and date as supporting metadata. Stats sit under the
 * headline as bold tabular numerals so they read at a glance.
 *
 * Whole row is clickable — drilldown to the Summary report is the
 * single 1-click action this row offers.
 */

import { useNavigate } from 'react-router';
import type { Endorsement } from '../../api/cert-fixtures';
import { StatusPill } from './status-pill';

interface EndorsementSubRowProps {
  readonly endorsement: Endorsement;
  readonly onSelect?: (endorsement: Endorsement) => void;
}

const formatRelative = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffDay = Math.round((Date.now() - then) / 86_400_000);
  if (diffDay < 1) return 'today';
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.round(diffDay / 7)}w ago`;
  if (diffDay < 365) return `${Math.round(diffDay / 30)}mo ago`;
  return `${Math.round(diffDay / 365)}y ago`;
};

const formatAbsoluteShort = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

const formatAbsoluteFull = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
};

const formatNumber = (n: number | undefined): string =>
  n === undefined ? '—' : n.toLocaleString();

const isDD = (e: Endorsement): boolean => e.type === 'data_dictionary';

const TWO_YEARS_MS = 2 * 365.25 * 86_400_000;

/** Returns true if the endorsement date is older than two years. */
const isExpiringSoon = (iso: string): boolean => {
  const then = new Date(iso).getTime();
  return !Number.isNaN(then) && Date.now() - then > TWO_YEARS_MS;
};

export const EndorsementSubRow = ({
  endorsement,
  onSelect
}: EndorsementSubRowProps) => {
  const navigate = useNavigate();
  const {
    typeLabel,
    version,
    status,
    providerName,
    providerUoi,
    systemName,
    recipientUoi,
    statusTimestamp,
    local,
    failedStep,
    standardResourcesCount,
    localResourcesCount,
    standardFieldsCount,
    localFieldsCount,
    standardLookupsCount,
    localLookupsCount,
    idxFieldsCount,
    totalStandardIdxFieldsCount
  } = endorsement;

  // Show provider context only when the provider is a distinct,
  // resolved organization (not just a raw UOI fallback). When the
  // system name is also known, render it in a muted secondary tone
  // so the provider name reads first. Suppress the line entirely if
  // we only have a system name without a provider — that case
  // surfaces noise like "via FBS" without context.
  const providerDifferentFromRecipient =
    providerUoi && recipientUoi && providerUoi !== recipientUoi;
  const providerNameResolved =
    providerName && providerName !== providerUoi;
  const showProviderLine =
    providerDifferentFromRecipient && providerNameResolved;

  const ddStatsAvailable =
    isDD(endorsement) &&
    standardResourcesCount !== undefined &&
    standardFieldsCount !== undefined;

  const idxPercent =
    idxFieldsCount !== undefined && totalStandardIdxFieldsCount
      ? Math.round((idxFieldsCount / totalStandardIdxFieldsCount) * 100)
      : null;

  const showFailedStep =
    failedStep && (status === 'failed' || status === 'in_review');

  const handleClick = () => {
    if (onSelect) {
      onSelect(endorsement);
    } else {
      navigate(`/cert/orgs/${encodeURIComponent(endorsement.recipientUoi)}/detail/${encodeURIComponent(endorsement.id)}`);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group w-full text-left px-5 py-3.5 flex items-start gap-4 cursor-pointer hover:bg-gray-50/70 dark:hover:bg-gray-700/30 transition-colors focus:outline-none focus:bg-gray-50/70 dark:focus:bg-gray-700/30"
    >
      <div className="flex-1 min-w-0">
        {/* Headline: type + version */}
        <div className="flex items-baseline gap-x-2.5 gap-y-0.5 flex-wrap">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {typeLabel}{' '}
            <span className="text-gray-500 dark:text-gray-400 font-normal">
              {version}
            </span>
          </h4>
          {local && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
              title="Run from a local CLI runner"
            >
              Local
            </span>
          )}
          {isExpiringSoon(statusTimestamp) && status === 'certified' && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 cursor-help"
              title="RESO endorsements are valid for two years from the date of certification. Endorsements older than two years will transition to Legacy status and will need to be renewed to remain current. This update is part of RESO's versioning policy, which helps ensure that certified implementations reflect the latest standards."
            >
              Expiring Soon
            </span>
          )}
        </div>
        {/* Provider branding — own line for prominence */}
        {showProviderLine && (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs">
            <span className="text-gray-500 dark:text-gray-500">Provided by</span>
            <span className="font-semibold text-gray-700 dark:text-gray-200">
              {providerName}
            </span>
            {systemName && (
              <>
                <span className="text-gray-300 dark:text-gray-600">&middot;</span>
                <span className="font-medium text-gray-500 dark:text-gray-400">
                  {systemName}
                </span>
              </>
            )}
          </div>
        )}

        {/* Stats — bold but not overpowering */}
        {ddStatsAvailable && !showFailedStep && (
          <div className="mt-1.5 flex items-center gap-x-5 gap-y-0.5 flex-wrap text-xs text-gray-600 dark:text-gray-400">
            <span>
              <span className="text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {formatNumber((standardResourcesCount ?? 0) + (localResourcesCount ?? 0))}
              </span>{' '}
              resources
            </span>
            <span>
              <span className="text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {formatNumber((standardFieldsCount ?? 0) + (localFieldsCount ?? 0))}
              </span>{' '}
              fields
            </span>
            <span>
              <span className="text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {formatNumber((standardLookupsCount ?? 0) + (localLookupsCount ?? 0))}
              </span>{' '}
              lookups
            </span>
            {idxPercent !== null && (
              <span>
                <span className="text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                  {idxPercent}%
                </span>{' '}
                of {totalStandardIdxFieldsCount} IDX fields
              </span>
            )}
          </div>
        )}

        {showFailedStep && (
          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
            Failed step:{' '}
            <span className="font-medium text-gray-700 dark:text-gray-300">
              {failedStep}
            </span>
          </p>
        )}
      </div>

      {/* Status + date side-by-side; "View details" affordance below.
          The date is *when* the status happened, so they read as one
          unit at the top. */}
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <div className="flex items-center gap-2.5">
          <StatusPill status={status} size="sm" />
          <time
            dateTime={statusTimestamp}
            title={formatAbsoluteFull(statusTimestamp)}
            className="text-sm font-medium text-gray-700 dark:text-gray-200 tabular-nums"
          >
            {formatAbsoluteShort(statusTimestamp)}
          </time>
        </div>
        <span className="text-[11px] text-gray-600 dark:text-gray-400 tabular-nums">
          {formatRelative(statusTimestamp)}
        </span>
        <span className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 group-hover:bg-blue-100 dark:group-hover:bg-blue-900/50 transition-colors">
          View Details
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 010-1.06l3.71-3.71-3.71-3.71a.75.75 0 111.06-1.06l4.24 4.24a.75.75 0 010 1.06l-4.24 4.24a.75.75 0 01-1.06 0z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </div>
    </button>
  );
};
