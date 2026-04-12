/**
 * Shared metadata browser sub-components.
 *
 * Used by both the live server metadata page (metadata-page.tsx) and
 * the cert Server Explorer (server-explorer.tsx) to keep visual parity.
 */

import type { ReactNode } from 'react';

// ── Badge ────────────────────────────────────────────────────────────

const BADGE_COLORS: Readonly<Record<string, string>> = {
  gray: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  green: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

export const Badge = ({ label, color = 'gray' }: { readonly label: string; readonly color?: string }) => (
  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${BADGE_COLORS[color] ?? BADGE_COLORS.gray}`}>
    {label}
  </span>
);

// ── Filter pill button ──────────────────────────────────────────────

export const FilterPill = ({
  label,
  count,
  active,
  onClick,
}: {
  readonly label: string;
  readonly count?: number;
  readonly active: boolean;
  readonly onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
      active
        ? 'bg-blue-600 text-white'
        : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
    }`}
  >
    {label}
    {count !== undefined && (
      <span className={`tabular-nums ${active ? 'text-blue-200' : 'text-gray-400 dark:text-gray-500'}`}>
        ({count})
      </span>
    )}
  </button>
);

// ── Search input ────────────────────────────────────────────────────

export const SearchInput = ({
  value,
  onChange,
  placeholder = 'Search fields…',
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}) => (
  <div className="relative flex-1 min-w-[200px]">
    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
    </svg>
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  </div>
);

// ── Field row ───────────────────────────────────────────────────────

/** Expand/collapse chevron indicator. */
const ExpandChevron = ({ expanded }: { readonly expanded: boolean }) => (
  <svg
    className={`w-3 h-3 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
    fill="currentColor"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
  </svg>
);

export const FieldRow = ({
  fieldName,
  expanded,
  onClick,
  badges,
  trailing,
  striped = false,
}: {
  readonly fieldName: string;
  readonly expanded: boolean;
  readonly onClick: () => void;
  /** Badge elements shown after the field name (type, RESO/local, etc.) */
  readonly badges?: ReactNode;
  /** Right-aligned trailing content (availability %, max length, etc.) */
  readonly trailing?: ReactNode;
  readonly striped?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full text-left px-4 py-3 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-colors cursor-pointer ${
      striped ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''
    }`}
  >
    <div className="flex items-center gap-3">
      <ExpandChevron expanded={expanded} />
      <span className="font-medium text-sm text-gray-900 dark:text-gray-100 min-w-0 truncate sm:max-w-[35%]">
        {fieldName}
      </span>
      {badges && (
        <div className="hidden sm:flex items-center gap-3 flex-1 min-w-0 justify-end">
          {badges}
        </div>
      )}
      {trailing}
    </div>
  </button>
);

// ── Resource sidebar button ─────────────────────────────────────────

export const ResourceButton = ({
  name,
  count,
  active,
  onClick,
  trailing,
}: {
  readonly name: string;
  readonly count?: number;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly trailing?: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
      active
        ? 'bg-blue-600 text-white'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
    }`}
  >
    <span className="font-medium truncate">{name}</span>
    <div className="flex items-center gap-2 shrink-0">
      {trailing}
      {count !== undefined && (
        <span className={`text-xs tabular-nums ${active ? 'text-blue-200' : 'text-gray-400 dark:text-gray-500'}`}>
          ({count})
        </span>
      )}
    </div>
  </button>
);

// ── Availability bar ────────────────────────────────────────────────

/** Color class for an availability percentage. */
export const availColorClass = (pct: number): string =>
  pct >= 75 ? 'text-green-600 dark:text-green-400'
    : pct >= 25 ? 'text-amber-600 dark:text-amber-400'
    : 'text-red-600 dark:text-red-400';

export const AvailBar = ({ pct: value }: { readonly pct: number }) => (
  <div className="flex items-center gap-2">
    <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full ${
          value >= 75 ? 'bg-green-500' : value >= 25 ? 'bg-amber-500' : 'bg-red-500'
        }`}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
    <span className={`text-xs font-semibold tabular-nums w-10 text-right ${availColorClass(value)}`}>
      {Math.round(value)}%
    </span>
  </div>
);
