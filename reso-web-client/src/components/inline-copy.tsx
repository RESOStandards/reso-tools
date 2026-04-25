/**
 * InlineCopy — tiny clipboard-icon button for copying a value to the clipboard.
 *
 * Designed to live next to short text values (IDs, keys, system identifiers)
 * inside dense rows. Shows a green check briefly on copy.
 */

import { useState } from 'react';

interface InlineCopyProps {
  readonly value: string;
  readonly title?: string;
}

export const InlineCopy = ({ value, title = 'Copy to clipboard' }: InlineCopyProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      tabIndex={-1}
      className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors cursor-pointer"
      aria-label={copied ? 'Copied' : title}
      title={copied ? 'Copied' : title}>
      {copied ? (
        <svg className="w-3 h-3 text-green-600 dark:text-green-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
          <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
        </svg>
      )}
    </button>
  );
};

/**
 * Heuristic: should this field offer a copy affordance because its value is
 * typically an opaque identifier the user might want to paste elsewhere?
 *
 * Matches:
 *   - field names ending in "Key" or "Id"
 *   - field names starting with "OriginatingSystem" or "SourceSystem"
 */
export const isCopyableIdField = (fieldName: string): boolean => {
  if (/Key$|Id$/i.test(fieldName)) return true;
  if (/^OriginatingSystem|^SourceSystem/i.test(fieldName)) return true;
  return false;
};
