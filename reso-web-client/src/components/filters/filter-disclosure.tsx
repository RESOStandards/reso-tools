/**
 * Filters drawer — a controlled disclosure container with a separate
 * toggle button that callers can place anywhere in their layout.
 *
 * The toggle and the drawer are decoupled so the toggle can live in a
 * sticky search/sort row while the drawer sits in normal flow below.
 * State is controlled by the caller (URL or local) so the drawer can
 * sync with other view state.
 */

import type { ReactNode } from 'react';

// ── Toggle button ────────────────────────────────────────────────────────

interface FilterToggleButtonProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly activeCount?: number;
}

export const FilterToggleButton = ({
  open,
  onToggle,
  activeCount = 0
}: FilterToggleButtonProps) => (
  <button
    type="button"
    onClick={onToggle}
    aria-expanded={open}
    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition-colors ${
      open
        ? 'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800'
        : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
    }`}
  >
    <svg
      className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
    Filters
    {activeCount > 0 && (
      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold bg-blue-600 text-white">
        {activeCount}
      </span>
    )}
  </button>
);

// ── Drawer container ─────────────────────────────────────────────────────

interface FilterDrawerProps {
  readonly open: boolean;
  readonly children: ReactNode;
}

export const FilterDrawer = ({ open, children }: FilterDrawerProps) => {
  if (!open) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/40 px-4 py-4">
      {children}
    </div>
  );
};
