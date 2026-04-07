/**
 * Date range preset chips — primary date control for the public list.
 *
 * Real estate execs reviewing certs don't want a dual-calendar picker;
 * they want "last 30 days" / "this year" / "all time". A "Custom"
 * disclosure can be added later for power users — left as a TODO so
 * tonight's surface stays calm.
 *
 * Presets are computed on demand from a stable reference date so the
 * URL state stays semantic ("preset=30d") rather than absolute, which
 * keeps shared links interpretable a week later.
 */

import { FacetButton } from './facet-group';

export type DateRangePreset = 'all' | '30d' | '90d' | '1y' | 'custom';

export interface DateRange {
  readonly from: string; // ISO
  readonly to: string;   // ISO
}

interface DatePresetEntry {
  readonly value: DateRangePreset;
  readonly label: string;
  /** Days back from now; undefined means "no range" (all time). */
  readonly daysBack?: number;
}

const PRESETS: ReadonlyArray<DatePresetEntry> = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: 'Last 30 days', daysBack: 30 },
  { value: '90d', label: 'Last 3 months', daysBack: 90 },
  { value: '1y',  label: 'Last 12 months', daysBack: 365 },
  { value: 'custom', label: 'Custom' }
];

/** Resolve a preset value to an absolute date range. Returns null for `all`. */
export const resolveDatePreset = (preset: DateRangePreset): DateRange | null => {
  const entry = PRESETS.find((p) => p.value === preset);
  if (!entry || entry.daysBack === undefined) return null;
  const now = new Date();
  const start = new Date(now.getTime() - entry.daysBack * 86_400_000);
  // Match the old cert app's range semantics: start of day → end of day
  const startISO = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
    0, 0, 0
  ).toISOString();
  const endISO = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23, 59, 59
  ).toISOString();
  return { from: startISO, to: endISO };
};

interface DateRangePresetsProps {
  readonly value: DateRangePreset;
  readonly customFrom?: string;
  readonly customTo?: string;
  readonly onChange: (preset: DateRangePreset) => void;
  readonly onCustomChange?: (from: string, to: string) => void;
}

export const DateRangePresets = ({
  value,
  customFrom = '',
  customTo = '',
  onChange,
  onCustomChange
}: DateRangePresetsProps) => (
  <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 min-w-16">
        Date
      </span>
      {PRESETS.map((p) => (
        <FacetButton
          key={p.value}
          label={p.label}
          active={value === p.value}
          onClick={() => onChange(p.value)}
        />
      ))}
    </div>
    {value === 'custom' && (
      <div className="flex flex-wrap items-center gap-2 pl-16">
        <input
          type="date"
          value={customFrom}
          onChange={(e) => onCustomChange?.(e.target.value, customTo)}
          className="text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-[11px] text-gray-400 dark:text-gray-500">to</span>
        <input
          type="date"
          value={customTo}
          onChange={(e) => onCustomChange?.(customFrom, e.target.value)}
          className="text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
    )}
  </div>
);

export const datePresetLabel = (value: DateRangePreset): string =>
  PRESETS.find((p) => p.value === value)?.label ?? value;
