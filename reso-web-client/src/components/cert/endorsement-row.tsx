import type { Endorsement } from '../../api/cert-fixtures';
import { StatusPill } from './status-pill';

interface EndorsementRowProps {
  readonly endorsement: Endorsement;
}

/** Format an absolute ISO timestamp into a relative human label. */
const formatRelative = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.round(diffDay / 7)}w ago`;
  if (diffDay < 365) return `${Math.round(diffDay / 30)}mo ago`;
  return `${Math.round(diffDay / 365)}y ago`;
};

/** Format an absolute timestamp for the hover tooltip. */
const formatAbsolute = (iso: string): string => {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return iso;
  }
};

const formatNumber = (n: number | undefined): string =>
  n === undefined ? '—' : n.toLocaleString();

const isDD = (e: Endorsement): boolean => e.type === 'data_dictionary';

/**
 * One row in the public Endorsements list. Card-style, generous
 * whitespace, hover lift. Renders DD-specific stats inline when the
 * type is data_dictionary; otherwise just shows provider context.
 */
export const EndorsementRow = ({ endorsement }: EndorsementRowProps) => {
  const {
    type,
    typeLabel,
    version,
    status,
    providerName,
    systemName,
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

  const providerAndSystem = systemName
    ? `${providerName} · ${systemName}`
    : providerName;

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

  return (
    <article
      className="group flex items-center gap-4 px-5 py-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm transition-all"
      aria-labelledby={`endorsement-${endorsement.id}-title`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3
            id={`endorsement-${endorsement.id}-title`}
            className="text-[15px] font-semibold text-gray-900 dark:text-gray-100"
          >
            {typeLabel} <span className="text-gray-400 dark:text-gray-500 font-normal">{version}</span>
          </h3>
          {local && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
              Local
            </span>
          )}
        </div>

        <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400 truncate">
          {providerAndSystem}
        </p>

        {ddStatsAvailable && !showFailedStep && (
          <div className="mt-2 flex items-center gap-x-5 gap-y-1 flex-wrap text-xs text-gray-500 dark:text-gray-400">
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
                IDX{' '}
                <span className="text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                  {idxPercent}%
                </span>
              </span>
            )}
          </div>
        )}

        {showFailedStep && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Failed step:{' '}
            <span className="font-medium text-gray-700 dark:text-gray-300">
              {failedStep}
            </span>
          </p>
        )}
      </div>

      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <StatusPill status={status} />
        <time
          dateTime={statusTimestamp}
          title={formatAbsolute(statusTimestamp)}
          className="text-[11px] text-gray-400 dark:text-gray-500"
        >
          {formatRelative(statusTimestamp)}
        </time>
      </div>
    </article>
  );
};
