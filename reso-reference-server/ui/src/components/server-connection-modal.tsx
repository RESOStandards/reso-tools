import { useCallback, useState } from 'react';
import type { ServerPermissions } from '../context/server-context';

export interface ServerFormData {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly permissions: ServerPermissions;
}

interface ServerConnectionModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (data: ServerFormData) => void;
  /** Pre-fill for editing an existing connection. */
  readonly initial?: ServerFormData;
  readonly title?: string;
}

/** Modal dialog for adding or editing an external server connection. */
export const ServerConnectionModal = ({
  isOpen,
  onClose,
  onSubmit,
  initial,
  title = 'Add Server Connection'
}: ServerConnectionModalProps) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [token, setToken] = useState(initial?.token ?? '');
  const [canAdd, setCanAdd] = useState(initial?.permissions.canAdd ?? false);
  const [canEdit, setCanEdit] = useState(initial?.permissions.canEdit ?? false);
  const [canDelete, setCanDelete] = useState(initial?.permissions.canDelete ?? false);
  const [error, setError] = useState<string | null>(null);

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

      onSubmit({
        name: name.trim(),
        baseUrl: trimmedUrl,
        token: token.trim(),
        permissions: { canAdd, canEdit, canDelete }
      });
      setName('');
      setBaseUrl('');
      setToken('');
      setCanAdd(false);
      setCanEdit(false);
      setCanDelete(false);
    },
    [name, baseUrl, token, canAdd, canEdit, canDelete, onSubmit]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4">
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
            <label htmlFor="server-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Connection Name
            </label>
            <input
              id="server-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., My MLS Server"
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div>
            <label htmlFor="server-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Server URL
            </label>
            <input
              id="server-url"
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/odata"
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The OData service root URI (without trailing slash)
            </p>
          </div>

          <div>
            <label htmlFor="server-token" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Bearer Token <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              id="server-token"
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Enter bearer token"
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <fieldset>
            <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Allowed Operations
            </legend>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCanAdd(v => !v)}
                className={`px-3 py-1.5 text-sm rounded-md border font-medium transition-colors ${
                  canAdd
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-transparent text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                }`}>
                Add
              </button>
              <button
                type="button"
                onClick={() => setCanEdit(v => !v)}
                className={`px-3 py-1.5 text-sm rounded-md border font-medium transition-colors ${
                  canEdit
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-transparent text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                }`}>
                Edit
              </button>
              <button
                type="button"
                onClick={() => setCanDelete(v => !v)}
                className={`px-3 py-1.5 text-sm rounded-md border font-medium transition-colors ${
                  canDelete
                    ? 'bg-red-600 text-white border-red-600'
                    : 'bg-transparent text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                }`}>
                Delete
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Select which write operations this server supports
            </p>
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
