import { useCallback, useEffect, useState } from 'react';
import type { ServerPermissions } from '../context/server-context';

const AUTH_MODE_TOKEN = 'token' as const;
const AUTH_MODE_CLIENT_CREDENTIALS = 'client_credentials' as const;

export type AuthMode = typeof AUTH_MODE_TOKEN | typeof AUTH_MODE_CLIENT_CREDENTIALS;

export interface ServerFormData {
  readonly name: string;
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  readonly token: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl: string;
  readonly scope: string;
  readonly permissions: ServerPermissions;
}

interface ServerConnectionModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (data: ServerFormData) => void;
  /** Pre-fill for editing an existing connection. */
  readonly initial?: ServerFormData;
  readonly title?: string;
  /** Whether a proxy backend is available (required for Client Credentials). */
  readonly hasProxy?: boolean;
}

const inputClass = 'w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

const toggleBtnClass = (active: boolean, color: 'blue' | 'red' = 'blue') =>
  `px-3 py-1.5 text-sm rounded-md border font-medium transition-colors ${
    active
      ? `bg-${color}-600 text-white border-${color}-600`
      : 'bg-transparent text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
  }`;

/** Modal dialog for adding or editing an external server connection. */
export const ServerConnectionModal = ({
  isOpen,
  onClose,
  onSubmit,
  initial,
  title = 'Add Server Connection',
  hasProxy = false
}: ServerConnectionModalProps) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [authMode, setAuthMode] = useState<AuthMode>(initial?.authMode ?? AUTH_MODE_TOKEN);
  const [token, setToken] = useState(initial?.token ?? '');
  const [clientId, setClientId] = useState(initial?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState(initial?.clientSecret ?? '');
  const [tokenUrl, setTokenUrl] = useState(initial?.tokenUrl ?? '');
  const [scope, setScope] = useState(initial?.scope ?? '');
  const [canAdd, setCanAdd] = useState(initial?.permissions.canAdd ?? false);
  const [canEdit, setCanEdit] = useState(initial?.permissions.canEdit ?? false);
  const [canDelete, setCanDelete] = useState(initial?.permissions.canDelete ?? false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      const trimmedUrl = baseUrl.trim().replace(/\/+$/, '');
      if (!trimmedUrl) {
        setError('Server URL is required');
        return;
      }
      if (!name.trim()) {
        setError('Connection name is required');
        return;
      }

      try {
        new URL(trimmedUrl);
      } catch {
        setError('Invalid URL format');
        return;
      }

      if (authMode === AUTH_MODE_CLIENT_CREDENTIALS) {
        if (!clientId.trim()) { setError('Client ID is required'); return; }
        if (!clientSecret.trim()) { setError('Client Secret is required'); return; }
        if (!tokenUrl.trim()) { setError('Token URI is required'); return; }
        try {
          new URL(tokenUrl.trim());
        } catch {
          setError('Invalid Token URI format');
          return;
        }
      }

      onSubmit({
        name: name.trim(),
        baseUrl: trimmedUrl,
        authMode,
        token: token.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        tokenUrl: tokenUrl.trim(),
        scope: scope.trim(),
        permissions: { canAdd, canEdit, canDelete }
      });
      setName('');
      setBaseUrl('');
      setAuthMode(AUTH_MODE_TOKEN);
      setToken('');
      setClientId('');
      setClientSecret('');
      setTokenUrl('');
      setScope('');
      setCanAdd(false);
      setCanEdit(false);
      setCanDelete(false);
    },
    [name, baseUrl, authMode, token, clientId, clientSecret, tokenUrl, scope, canAdd, canEdit, canDelete, onSubmit]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="server-name" className={labelClass}>Connection Name</label>
            <input
              id="server-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., My MLS Server"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="server-url" className={labelClass}>Server URL</label>
            <input
              id="server-url"
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/odata"
              className={inputClass}
            />
            <p className={hintClass}>The OData service root URI (without trailing slash)</p>
          </div>

          <fieldset>
            <legend className={labelClass}>Authentication</legend>
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => setAuthMode(AUTH_MODE_TOKEN)}
                className={toggleBtnClass(authMode === AUTH_MODE_TOKEN)}>
                Bearer Token
              </button>
              <button
                type="button"
                disabled={!hasProxy}
                onClick={() => setAuthMode(AUTH_MODE_CLIENT_CREDENTIALS)}
                className={`${toggleBtnClass(authMode === AUTH_MODE_CLIENT_CREDENTIALS)} ${!hasProxy ? 'opacity-40 cursor-not-allowed' : ''}`}
                title={!hasProxy ? 'Client Credentials requires a proxy backend (run the reference server or desktop app)' : undefined}>
                Client Credentials
              </button>
            </div>
            {!hasProxy && authMode === AUTH_MODE_TOKEN && (
              <p className={hintClass}>Client Credentials requires a running backend to proxy token requests</p>
            )}

            {authMode === AUTH_MODE_TOKEN ? (
              <div>
                <label htmlFor="server-token" className={labelClass}>
                  Bearer Token
                </label>
                <input
                  id="server-token"
                  type="password"
                  autoComplete="current-password"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder="Enter bearer token"
                  className={inputClass}
                />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="client-id" className={labelClass}>Client ID</label>
                    <input
                      id="client-id"
                      type="text"
                      autoComplete="username"
                      value={clientId}
                      onChange={e => setClientId(e.target.value)}
                      placeholder="Enter client ID"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="client-secret" className={labelClass}>Client Secret</label>
                    <input
                      id="client-secret"
                      type="password"
                      autoComplete="current-password"
                      value={clientSecret}
                      onChange={e => setClientSecret(e.target.value)}
                      placeholder="Enter client secret"
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="token-url" className={labelClass}>Token URI</label>
                    <input
                      id="token-url"
                      type="text"
                      value={tokenUrl}
                      onChange={e => setTokenUrl(e.target.value)}
                      placeholder="https://auth.example.com/token"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="scope" className={labelClass}>
                      Scope <span className="text-gray-400 font-normal">(optional)</span>
                    </label>
                    <input
                      id="scope"
                      type="text"
                      value={scope}
                      onChange={e => setScope(e.target.value)}
                      placeholder="e.g., api"
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend className={`${labelClass} mb-2`}>Allowed Operations</legend>
            <div className="flex gap-2">
              <button type="button" onClick={() => setCanAdd(v => !v)} className={toggleBtnClass(canAdd)}>Add</button>
              <button type="button" onClick={() => setCanEdit(v => !v)} className={toggleBtnClass(canEdit)}>Edit</button>
              <button type="button" onClick={() => setCanDelete(v => !v)} className={toggleBtnClass(canDelete, 'red')}>Delete</button>
            </div>
            <p className={hintClass}>Select which write operations this server supports</p>
          </fieldset>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">
              Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
