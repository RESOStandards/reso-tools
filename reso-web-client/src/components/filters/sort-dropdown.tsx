/**
 * Sort dropdown — generic over the option value type. Caller owns the
 * options list and current value. Used for any list with a server-side
 * sort key.
 */

export interface SortOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SortDropdownProps<T extends string> {
  readonly value: T;
  readonly options: ReadonlyArray<SortOption<T>>;
  readonly onChange: (value: T) => void;
}

export const SortDropdown = <T extends string>({
  value,
  options,
  onChange
}: SortDropdownProps<T>) => (
  <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
    <span className="hidden sm:inline">Sort</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  </label>
);
