/**
 * Reusable facet filter primitives.
 *
 * - `FacetButton`: a single toggleable filter button with optional count badge
 * - `FacetGroup`: a labeled row of facet buttons
 *
 * Both are generic over the option value type so they work for endorsement
 * keys, status names, date presets, etc. Stateless — caller owns selection
 * state and toggle handler.
 */

import type { ReactNode } from 'react';

export interface FacetOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Optional count badge — undefined hides the badge entirely. */
  readonly count?: number;
  /** Hide this option entirely (typically when count === 0). */
  readonly hidden?: boolean;
  /** Disable but still show (e.g. mutually exclusive states). */
  readonly disabled?: boolean;
}

interface FacetButtonProps {
  readonly label: string;
  readonly count?: number;
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

export const FacetButton = ({
  label,
  count,
  active,
  disabled,
  onClick
}: FacetButtonProps) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    disabled={disabled}
    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
      active
        ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
        : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
    } disabled:opacity-50 disabled:cursor-not-allowed`}
  >
    <span>{label}</span>
    {typeof count === 'number' && (
      <span
        className={`inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums ${
          active
            ? 'bg-white/20 text-white'
            : 'bg-gray-100 text-gray-700 dark:bg-gray-600/70 dark:text-gray-100'
        }`}
      >
        {count.toLocaleString()}
      </span>
    )}
  </button>
);

interface FacetGroupProps<T extends string> {
  readonly label: ReactNode;
  readonly options: ReadonlyArray<FacetOption<T>>;
  readonly selected: ReadonlySet<T>;
  readonly onToggle: (value: T) => void;
  /** Optional trailing slot — e.g. a "Show all" link. */
  readonly trailing?: ReactNode;
}

export const FacetGroup = <T extends string>({
  label,
  options,
  selected,
  onToggle,
  trailing
}: FacetGroupProps<T>) => {
  const visible = options.filter((o) => !o.hidden);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 min-w-16">
        {label}
      </span>
      {visible.map((opt) => (
        <FacetButton
          key={opt.value}
          label={opt.label}
          count={opt.count}
          active={selected.has(opt.value)}
          disabled={opt.disabled}
          onClick={() => onToggle(opt.value)}
        />
      ))}
      {trailing}
    </div>
  );
};
