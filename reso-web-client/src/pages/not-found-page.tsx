import { useNavigate, useParams } from 'react-router';

const QUIPS = [
  'This listing has been delisted.',
  'Looks like that page moved without leaving a forwarding address.',
  'No matching records found in any MLS.',
  'That route expired before closing.',
  'This property is no longer available.',
];

/** 404 fallback page — also used for unknown resource routes. */
export const NotFoundPage = () => {
  const navigate = useNavigate();
  const { '*': splat, resource } = useParams();
  const path = resource ?? splat;
  const quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];

  return (
    <div className="h-full flex items-center justify-center pt-12">
      <div className="max-w-md text-center px-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 mb-4">
          <svg className="w-8 h-8 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <title>Not Found</title>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-1">Page Not Found</h1>
        <p className="text-sm italic text-gray-500 dark:text-gray-400 mb-3">{quip}</p>
        {path && (
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 font-mono bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
            /{path}
          </p>
        )}
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
