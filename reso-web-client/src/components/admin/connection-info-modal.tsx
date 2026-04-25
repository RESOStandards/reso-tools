/**
 * Connection Info modal for the active server connection.
 *
 * Works for any connection, not just the bundled local reference server. Sensitive
 * fields (bearer token, OAuth client secret) are masked by default with an eye
 * toggle to reveal. Copy buttons always operate on the unmasked value.
 *
 * For the bundled local server, default mock-OAuth credentials are shown since
 * its `/oauth/token` endpoint accepts any client_id / client_secret pair.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useServer } from '../../context/server-context';

const LOCAL_BEARER_TOKEN = 'admin-token';
const LOCAL_CLIENT_ID = 'reso-test-client';
const LOCAL_CLIENT_SECRET = 'reso-test-secret';
const REF_SERVER_GUIDE_URL = 'https://tools.reso.org/guides/reso-reference-server/';

const EyeOpen = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
    <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
    <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
  </svg>
);
const EyeClosed = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
    <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06l-1.745-1.745a10.029 10.029 0 003.3-4.38 1.651 1.651 0 000-1.185A10.004 10.004 0 009.999 3a9.956 9.956 0 00-4.744 1.194L3.28 2.22zM7.752 6.69l1.092 1.092a2.5 2.5 0 013.374 3.373l1.092 1.092a4 4 0 00-5.558-5.558z" clipRule="evenodd" />
    <path d="M10.748 13.93l2.523 2.523a9.987 9.987 0 01-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 010-1.186A10.007 10.007 0 012.839 6.02L6.07 9.252a4 4 0 004.678 4.678z" />
  </svg>
);
const CopyIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
    <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
    <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
  </svg>
);
const CheckIcon = () => (
  <svg className="w-4 h-4 text-green-600 dark:text-green-400" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.414 0z" clipRule="evenodd" />
  </svg>
);

interface CopyableProps {
  readonly value: string;
  /** When true, masks the value with a password mask and adds an eye toggle to reveal. */
  readonly sensitive?: boolean;
}

const Copyable = ({ value, sensitive = false }: CopyableProps) => {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const display = sensitive && !revealed ? '•'.repeat(Math.min(value.length || 8, 24)) : value;

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 px-3 py-2 text-xs font-mono rounded-md bg-gray-100 dark:bg-gray-900 text-gray-800 dark:text-gray-200 break-all">
        {display || <span className="text-gray-400 italic">(empty)</span>}
      </code>
      {sensitive && (
        <button
          type="button"
          onClick={() => setRevealed(r => !r)}
          tabIndex={-1}
          className="shrink-0 px-2 py-1.5 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
          title={revealed ? 'Hide' : 'Show'}
          aria-label={revealed ? 'Hide value' : 'Show value'}>
          {revealed ? <EyeOpen /> : <EyeClosed />}
        </button>
      )}
      <button
        type="button"
        onClick={handleCopy}
        disabled={!value}
        className="shrink-0 px-2 py-1.5 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title={copied ? 'Copied' : 'Copy to clipboard'}
        aria-label="Copy to clipboard">
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
};

const Field = ({ label, value, hint, sensitive }: { readonly label: string; readonly value: string; readonly hint?: string; readonly sensitive?: boolean }) => (
  <div>
    <div className="flex items-baseline justify-between mb-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</span>
      {hint && <span className="text-[11px] text-gray-400 dark:text-gray-500">{hint}</span>}
    </div>
    <Copyable value={value} sensitive={sensitive} />
  </div>
);

export const ConnectionInfoModal = ({ onClose }: { readonly onClose: () => void }) => {
  const { activeServer } = useServer();

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const isLocal = activeServer.type === 'local';
  const baseUrl = (activeServer.baseUrl || window.location.origin).replace(/\/$/, '');

  // Resolve credentials for display:
  //   Local: show the mock defaults so testers have a concrete value to plug in.
  //   External: show what's saved on the connection. Empty fields are rendered as "(empty)".
  const bearerToken = isLocal ? LOCAL_BEARER_TOKEN : (activeServer.token ?? '');
  const oauthTokenUrl = isLocal ? `${baseUrl}/oauth/token` : (activeServer.tokenUrl ?? '');
  const clientId = isLocal ? LOCAL_CLIENT_ID : (activeServer.clientId ?? '');
  const clientSecret = isLocal ? LOCAL_CLIENT_SECRET : (activeServer.clientSecret ?? '');

  const showBearerSection = isLocal || activeServer.authMode === 'token' || !!bearerToken;
  const showOauthSection = isLocal || activeServer.authMode === 'client_credentials' || !!clientId || !!oauthTokenUrl;

  // Render via portal so the modal always overlays the full viewport regardless of
  // where it's mounted in the React tree. Without this, transformed ancestors
  // (e.g. the sidebar's translate-x transition) trap `position: fixed` children.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={e => e.key === 'Escape' && onClose()}
      role="button"
      tabIndex={-1}
      aria-label="Close">
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-lg w-full mx-4 max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
        role="dialog"
        tabIndex={-1}
        aria-modal="true">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Connection Info</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{activeServer.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer text-2xl leading-none"
            aria-label="Close">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-5">
          <Field label="Service Root URL" value={baseUrl} hint="OData base" />

          {showBearerSection && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-5">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Bearer Token</h4>
              <div className="space-y-3">
                <Field label="Token" value={bearerToken} sensitive />
                <Field label="Header" value={bearerToken ? `Authorization: Bearer ${bearerToken}` : ''} sensitive hint="Ready to paste" />
              </div>
            </div>
          )}

          {showOauthSection && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-5">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">OAuth2 Client Credentials</h4>
              <div className="space-y-3">
                <Field label="Token URL" value={oauthTokenUrl} />
                <Field label="Client ID" value={clientId} />
                <Field label="Client Secret" value={clientSecret} sensitive />
                {activeServer.scope && <Field label="Scope" value={activeServer.scope} />}
              </div>
              {isLocal && (
                <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  The reference server's OAuth2 endpoint accepts any client ID / secret pair for testing. Use the values above or your own.
                </p>
              )}
            </div>
          )}

          {isLocal && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-5">
              <a
                href={REF_SERVER_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline">
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clipRule="evenodd" />
                  <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clipRule="evenodd" />
                </svg>
                Reference Server User Guide
              </a>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end p-5 border-t border-gray-200 dark:border-gray-700 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
