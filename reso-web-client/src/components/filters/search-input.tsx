/**
 * Search input with magnifier icon. Local input state lives in the
 * caller; this component is purely presentational so the parent can
 * control debouncing, history-push semantics, and "apply on Enter/blur"
 * behavior without this component knowing.
 */

interface SearchInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
  readonly onApply: () => void;
}

export const SearchInput = ({
  value,
  placeholder,
  onChange,
  onApply
}: SearchInputProps) => (
  <div className="relative flex-1">
    <svg
      className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
        clipRule="evenodd"
      />
    </svg>
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onApply();
      }}
      onBlur={onApply}
      placeholder={placeholder}
      className="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
    />
  </div>
);
