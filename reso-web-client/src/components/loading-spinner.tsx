/** Centered loading spinner for content panes. */
export const LoadingSpinner = ({ label = 'Loading...' }: { readonly label?: string }) => (
  <div className="flex flex-col items-center justify-center gap-3 py-16 text-gray-400 dark:text-gray-500">
    <svg className="w-8 h-8 animate-spin" viewBox="0 0 24 24" fill="none">
      <title>{label}</title>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
    <span className="text-sm">{label}</span>
  </div>
);
