/**
 * DetailText — renders text with URLs as clickable links with friendly labels.
 *
 * Replaces raw URLs (OASIS specs, OData metadata, etc.) with human-readable
 * link text and a copy button. Used in job step details and failure reports.
 */

import { useState } from 'react';

/** Derive a user-friendly label from a URL. */
export const friendlyUrlLabel = (url: string): string => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    const last = path.split('/').pop() ?? '';
    if (last === '$metadata') return 'CSDL specification';
    if (/^odata-v4/i.test(last) || url.includes('oasis-open.org')) return 'OData specification';
    if (last === 'Lookup' || last === 'LookupResource') return 'Lookup Resource';
    if (!last) return parsed.hostname;
    return last;
  } catch {
    return url.length > 40 ? `${url.slice(0, 37)}...` : url;
  }
};

const URL_REGEX = /https?:\/\/[^\s,)]+/g;

export const DetailText = ({ text, className }: { readonly text: string; readonly className?: string }) => {
  const [copied, setCopied] = useState<string | null>(null);

  const parts = text.split(URL_REGEX);
  const urls = text.match(URL_REGEX) ?? [];

  if (urls.length === 0) return <p className={className}>{text}</p>;

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(url);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <p className={className}>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < urls.length && (
            <span className="inline-flex items-center gap-0.5">
              <a href={urls[i]} target="_blank" rel="noopener noreferrer" className="text-blue-500 dark:text-blue-400 hover:underline" title={urls[i]}>
                {friendlyUrlLabel(urls[i])}
              </a>
              <button
                type="button"
                onClick={() => handleCopy(urls[i])}
                className="inline-flex items-center ml-0.5 text-gray-400 hover:text-blue-500 cursor-pointer"
                title="Copy URL"
              >
                {copied === urls[i] ? (
                  <svg className="w-3 h-3 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z" />
                    <path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v6h-4.586l1.293-1.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L10.414 13H15v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" />
                  </svg>
                )}
              </button>
            </span>
          )}
        </span>
      ))}
    </p>
  );
};
