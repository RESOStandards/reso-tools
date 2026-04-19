/**
 * Collapsible request details panel for cert pipeline steps.
 *
 * Shows HTTP method, URL (copyable), status, and response body
 * in a monospace dark panel. Closed by default — click the label
 * to expand.
 */

import { useState } from 'react';

export interface RequestDetail {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly error?: string;
  readonly responseBody?: string;
}

const CopyButton = ({ text }: { readonly text: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center ml-1 text-gray-500 hover:text-blue-400 cursor-pointer"
      title="Copy"
    >
      {copied ? (
        <svg className="w-3 h-3 text-green-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
          <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z" />
          <path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v6h-4.586l1.293-1.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L10.414 13H15v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" />
        </svg>
      )}
    </button>
  );
};

const statusColor = (status?: number): string => {
  if (!status) return 'text-gray-400';
  if (status >= 200 && status < 300) return 'text-green-400';
  if (status >= 400) return 'text-red-400';
  return 'text-amber-400';
};

export const RequestDetailsPanel = ({ details }: { readonly details: ReadonlyArray<RequestDetail> }) => {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  if (details.length === 0) return null;

  const toggle = (index: number) => {
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setExpanded(next);
  };

  return (
    <div className="mt-1.5 space-y-1">
      {details.map((detail, i) => {
        const isOpen = expanded.has(i);
        const label = `${detail.method} ${detail.url}`;
        const hasBody = detail.responseBody || detail.error;

        return (
          <div key={i}>
            <button
              type="button"
              onClick={() => toggle(i)}
              className="flex items-center gap-1.5 text-[11px] font-mono text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 cursor-pointer group"
            >
              <svg
                className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
              </svg>
              <span className="truncate max-w-[400px]">{label}</span>
              {detail.status != null && (
                <span className={`${statusColor(detail.status)} font-semibold`}>{detail.status}</span>
              )}
            </button>

            {isOpen && (
              <div className="mt-1 ml-4 p-3 bg-gray-900 dark:bg-gray-950 rounded-lg border border-gray-700 text-[11px] font-mono text-gray-300 space-y-1.5 overflow-x-auto">
                <div className="flex items-center gap-1">
                  <span className="text-blue-400">{detail.method}</span>
                  <span className="text-gray-200 break-all">{detail.url}</span>
                  <CopyButton text={detail.url} />
                </div>
                {detail.status != null && (
                  <div>
                    <span className="text-gray-500">Status: </span>
                    <span className={statusColor(detail.status)}>{detail.status}</span>
                  </div>
                )}
                {detail.error && (
                  <div>
                    <span className="text-gray-500">Error: </span>
                    <span className="text-red-400">{detail.error}</span>
                    <CopyButton text={detail.error} />
                  </div>
                )}
                {detail.responseBody && (
                  <div>
                    <span className="text-gray-500">Response:</span>
                    <CopyButton text={detail.responseBody} />
                    <pre className="mt-1 text-gray-400 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                      {detail.responseBody.length > 500
                        ? detail.responseBody.slice(0, 500) + '...'
                        : detail.responseBody}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
