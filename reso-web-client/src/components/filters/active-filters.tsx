/**
 * Active filter pills bar.
 *
 * Displays the currently-applied filters as removable pills with a
 * "Clear all" affordance. Caller composes the pill list (since labels
 * may need lookups against catalogs that the bar shouldn't know about)
 * and provides the clear-all handler.
 */

export interface ActiveFilterPillSpec {
  readonly key: string;
  readonly label: string;
  readonly onRemove: () => void;
}

interface ActiveFiltersProps {
  readonly pills: ReadonlyArray<ActiveFilterPillSpec>;
  readonly onClearAll: () => void;
}

export const ActiveFilterPill = ({
  label,
  onRemove
}: {
  readonly label: string;
  readonly onRemove: () => void;
}) => (
  <span className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 ring-1 ring-blue-200/70 dark:ring-blue-900/40">
    {label}
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${label}`}
      className="ml-0.5 w-4 h-4 rounded-full inline-flex items-center justify-center hover:bg-blue-200/60 dark:hover:bg-blue-800/40"
    >
      <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <path d="M3.22 3.22a.75.75 0 011.06 0L6 4.94l1.72-1.72a.75.75 0 111.06 1.06L7.06 6l1.72 1.72a.75.75 0 11-1.06 1.06L6 7.06 4.28 8.78a.75.75 0 01-1.06-1.06L4.94 6 3.22 4.28a.75.75 0 010-1.06z" />
      </svg>
    </button>
  </span>
);

export const ActiveFilters = ({ pills, onClearAll }: ActiveFiltersProps) => {
  if (pills.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {pills.map((p) => (
        <ActiveFilterPill key={p.key} label={p.label} onRemove={p.onRemove} />
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="ml-1 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
      >
        Clear all
      </button>
    </div>
  );
};
