import { useNavigate } from 'react-router';

const QUIPS = [
  'Well, that listing fell through.',
  'This page failed its home inspection.',
  'Looks like we hit a load-bearing bug.',
  'That route is no longer on the market.',
  'Under contract with an error handler.',
];

/**
 * Reusable friendly error display with an icon, quip, server message block,
 * and navigation buttons. Drop this in anywhere you'd show a raw error string.
 */
export const FriendlyError = ({ title = 'Something went wrong', message }: {
  readonly title?: string;
  readonly message: string;
}) => {
  const navigate = useNavigate();
  const quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];

  return (
    <div className="h-full flex items-center justify-center pt-12">
      <div className="max-w-md text-center px-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 mb-4">
          <svg className="w-8 h-8 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <title>Error</title>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-1">{title}</h1>
        <p className="text-sm italic text-gray-500 dark:text-gray-400 mb-3">{quip}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-8 font-mono bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">{message}</p>
        <div className="flex items-center justify-center gap-3 mb-6">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Go Back
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            Dashboard
          </button>
        </div>
        <a
          href="mailto:support@reso.org"
          className="text-sm text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          Contact Support
        </a>
      </div>
    </div>
  );
};
