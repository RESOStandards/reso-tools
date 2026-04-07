import type { EndorsementStatus } from '../../api/cert-fixtures';

interface StatusStyle {
  readonly label: string;
  /** Tailwind class string for light + dark mode. */
  readonly className: string;
}

/** Visual style + label for each status. Order here also drives the
 *  default sort priority elsewhere — actionable states first. */
const STATUS_STYLES: Record<EndorsementStatus, StatusStyle> = {
  failed: {
    label: 'Failed',
    className:
      'bg-red-50 text-red-700 ring-1 ring-red-200/70 dark:bg-red-900/30 dark:text-red-300 dark:ring-red-900/40'
  },
  in_review: {
    label: 'In Review',
    className:
      'bg-amber-50 text-amber-800 ring-1 ring-amber-200/70 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-900/40'
  },
  in_progress: {
    label: 'In Progress',
    className:
      'bg-blue-50 text-blue-700 ring-1 ring-blue-200/70 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-900/40'
  },
  pending: {
    label: 'Pending',
    className:
      'bg-purple-50 text-purple-700 ring-1 ring-purple-200/70 dark:bg-purple-900/30 dark:text-purple-300 dark:ring-purple-900/40'
  },
  active: {
    label: 'Active',
    className:
      'bg-green-50 text-green-700 ring-1 ring-green-200/70 dark:bg-green-900/30 dark:text-green-300 dark:ring-green-900/40'
  },
  closed: {
    label: 'Closed',
    className:
      'bg-gray-100 text-gray-700 ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700'
  },
  expired: {
    label: 'Expired',
    className:
      'bg-gray-100 text-gray-500 ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-500 dark:ring-gray-700'
  }
};

interface StatusPillProps {
  readonly status: EndorsementStatus;
  readonly size?: 'sm' | 'md';
}

export const StatusPill = ({ status, size = 'md' }: StatusPillProps) => {
  const style = STATUS_STYLES[status];
  const sizeClass =
    size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1';
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${sizeClass} ${style.className}`}
    >
      {style.label}
    </span>
  );
};

/** Status priority used for the default sort — most actionable first. */
export const STATUS_SORT_ORDER: ReadonlyArray<EndorsementStatus> = [
  'failed',
  'in_review',
  'in_progress',
  'pending',
  'active',
  'closed',
  'expired'
];

export const statusLabel = (status: EndorsementStatus): string =>
  STATUS_STYLES[status].label;
