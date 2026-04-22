/**
 * Connection Manager Overlay — modal for managing all saved server connections.
 *
 * Opened from the server switcher when the user has >5 connections or clicks
 * "Manage Connections." Shows an always-visible search bar, MRU-ordered connection
 * cards with inline editing, masked credential fields, and CRUD actions.
 */

import { useCallback, useEffect, useState } from 'react';
import { MaskedInput } from './masked-input';
import { ExportDialog } from './cert/export-dialog';
import { ImportDiffView } from './cert/import-diff-view';
import { readImportFile, analyzeImport, type ImportAnalysis } from '../services/connection-io';
import {
  loadConnectionsMRU,
  saveConnection,
  deleteConnection,
  storeCredentials,
  getCredentials,
  removeCredentials,
  hasCredentials,
  searchConnections,
  touchMRU,
  profilesForConnection,
  maskSecret,
  type SavedConnection,
  type StoredCredentials,
} from '../services/connection-manager';

interface ConnectionManagerOverlayProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSelect: (connection: SavedConnection, credentials: StoredCredentials | null) => void;
}

type EditingState = {
  readonly id: string | null;
  name: string;
  url: string;
  authMode: 'token' | 'client_credentials';
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scope: string;
  authToken: string;
  originatingSystemName: string;
};

const emptyForm = (): EditingState => ({
  id: null,
  name: '',
  url: '',
  authMode: 'token',
  clientId: '',
  clientSecret: '',
  tokenUrl: '',
  scope: '',
  authToken: '',
  originatingSystemName: '',
});

const inputClass = 'w-full px-2.5 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 outline-none';
const labelClass = 'block text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-0.5';

export const ConnectionManagerOverlay = ({ isOpen, onClose, onSelect }: ConnectionManagerOverlayProps) => {
  const [connections, setConnections] = useState<ReadonlyArray<SavedConnection>>([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [linkedProfiles, setLinkedProfiles] = useState<ReadonlyArray<string>>([]);
  const [showExport, setShowExport] = useState(false);
  const [importAnalysis, setImportAnalysis] = useState<ImportAnalysis | null>(null);

  const reload = useCallback(async () => {
    setConnections(await loadConnectionsMRU());
  }, []);

  useEffect(() => {
    if (isOpen) reload();
  }, [isOpen, reload]);

  // When delete confirmation opens, check for linked profiles
  useEffect(() => {
    if (!deleteConfirm) { setLinkedProfiles([]); return; }
    profilesForConnection(deleteConfirm).then(profiles =>
      setLinkedProfiles(profiles.map(p => p.name))
    );
  }, [deleteConfirm]);

  const filtered = searchConnections(connections, search);

  const handleSelect = useCallback(async (conn: SavedConnection) => {
    await touchMRU(conn.id);
    const creds = await getCredentials(conn.id);
    onSelect(conn, creds);
    onClose();
  }, [onSelect, onClose]);

  const handleEdit = useCallback(async (conn: SavedConnection) => {
    const creds = await getCredentials(conn.id);
    setEditing({
      id: conn.id,
      name: conn.name,
      url: conn.url,
      authMode: conn.authMode,
      clientId: conn.clientId ?? '',
      clientSecret: creds?.clientSecret ?? '',
      tokenUrl: conn.tokenUrl ?? '',
      scope: conn.scope ?? '',
      authToken: creds?.authToken ?? '',
      originatingSystemName: conn.originatingSystemName ?? '',
    });
    setShowNew(false);
  }, []);

  const handleSave = useCallback(async () => {
    const form = editing ?? emptyForm();
    const conn = await saveConnection({
      id: form.id ?? undefined,
      name: form.name,
      url: form.url,
      authMode: form.authMode,
      clientId: form.authMode === 'client_credentials' ? form.clientId : undefined,
      tokenUrl: form.authMode === 'client_credentials' ? form.tokenUrl : undefined,
      scope: form.authMode === 'client_credentials' ? form.scope : undefined,
      originatingSystemName: form.originatingSystemName || undefined,
    });

    const creds: StoredCredentials = form.authMode === 'token'
      ? { authToken: form.authToken }
      : { clientSecret: form.clientSecret };
    if (creds.authToken || creds.clientSecret) {
      await storeCredentials(conn.id, creds);
    }

    setEditing(null);
    setShowNew(false);
    await reload();
  }, [editing, reload]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteConnection(id);
    setDeleteConfirm(null);
    await reload();
  }, [reload]);

  const handleClearCredentials = useCallback(async (id: string) => {
    await removeCredentials(id);
    await reload();
  }, [reload]);

  const handleNew = useCallback(() => {
    setEditing(emptyForm());
    setShowNew(true);
  }, []);

  const handleImport = useCallback(async () => {
    const payload = await readImportFile();
    if (!payload) return;
    const analysis = await analyzeImport(payload);
    setImportAnalysis(analysis);
  }, []);

  const handleImportComplete = useCallback(async () => {
    setImportAnalysis(null);
    await reload();
  }, [reload]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl max-h-[80vh] bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Connections</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700/50">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, URL, or system name..."
            className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>

        {/* Connection list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {filtered.length === 0 && !showNew && (
            <p className="text-center py-8 text-sm text-gray-400 dark:text-gray-500">
              {connections.length === 0 ? 'No saved connections.' : 'No matches found.'}
            </p>
          )}

          {filtered.map(conn => (
            editing?.id === conn.id ? (
              <ConnectionForm
                key={conn.id}
                form={editing}
                onChange={setEditing}
                onSave={handleSave}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <ConnectionCard
                key={conn.id}
                connection={conn}
                onSelect={() => handleSelect(conn)}
                onEdit={() => handleEdit(conn)}
                onDelete={() => setDeleteConfirm(conn.id)}
                onClearCredentials={() => handleClearCredentials(conn.id)}
              />
            )
          ))}

          {/* New connection form */}
          {showNew && editing && !editing.id && (
            <ConnectionForm
              form={editing}
              onChange={setEditing}
              onSave={handleSave}
              onCancel={() => { setShowNew(false); setEditing(null); }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleNew}
              disabled={showNew}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors disabled:opacity-40"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M8.75 3.75a.75.75 0 00-1.5 0v3.5h-3.5a.75.75 0 000 1.5h3.5v3.5a.75.75 0 001.5 0v-3.5h3.5a.75.75 0 000-1.5h-3.5v-3.5z" />
              </svg>
              Add
            </button>
            <button
              type="button"
              onClick={handleImport}
              className="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => setShowExport(true)}
              className="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Export
            </button>
          </div>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {connections.length} connection{connections.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete Connection</h3>
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
              This will remove the connection and its saved credentials.
            </p>
            {linkedProfiles.length > 0 && (
              <div className="p-2.5 mb-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-800 dark:text-amber-300">
                <p className="font-medium mb-1">The following cert profiles will lose their connection:</p>
                <ul className="list-disc list-inside">
                  {linkedProfiles.map(name => <li key={name}>{name}</li>)}
                </ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDelete(deleteConfirm)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export dialog */}
      <ExportDialog isOpen={showExport} onClose={() => setShowExport(false)} />

      {/* Import diff view */}
      {importAnalysis && (
        <ImportDiffView
          analysis={importAnalysis}
          onComplete={handleImportComplete}
          onCancel={() => setImportAnalysis(null)}
        />
      )}
    </div>
  );
};

// ── Connection Card ──────────────────────────────────────────────────

const ConnectionCard = ({
  connection: conn,
  onSelect,
  onEdit,
  onDelete,
  onClearCredentials,
}: {
  readonly connection: SavedConnection;
  readonly onSelect: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onClearCredentials: () => void;
}) => {
  const [hasCreds, setHasCreds] = useState(false);
  useEffect(() => { hasCredentials(conn.id).then(setHasCreds); }, [conn.id]);

  return (
    <div className="group flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:bg-gray-50/50 dark:hover:bg-gray-700/30 transition-colors">
      <button type="button" onClick={onSelect} className="flex items-center gap-3 min-w-0 flex-1 text-left">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${conn.authMode === 'client_credentials' ? 'bg-purple-400' : 'bg-blue-400'}`} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{conn.name}</div>
          <div className="truncate text-xs text-gray-500 dark:text-gray-400">{conn.url}</div>
          {conn.originatingSystemName && (
            <div className="text-[10px] text-gray-400 dark:text-gray-500">{conn.originatingSystemName}</div>
          )}
        </div>
      </button>

      <div className="flex items-center gap-1 ml-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {hasCreds && (
          <button
            type="button"
            onClick={onClearCredentials}
            className="p-1 text-gray-400 hover:text-amber-500 dark:hover:text-amber-400"
            title="Clear credentials"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path fillRule="evenodd" d="M8 1a3.5 3.5 0 00-3.5 3.5V7A1.5 1.5 0 003 8.5v5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5v-5A1.5 1.5 0 0011.5 7V4.5A3.5 3.5 0 008 1zm2 6V4.5a2 2 0 10-4 0V7h4z" clipRule="evenodd" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="p-1 text-gray-400 hover:text-blue-500 dark:hover:text-blue-400"
          title="Edit"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M13.488 2.513a1.75 1.75 0 00-2.475 0L3.22 10.303a.75.75 0 00-.178.31l-.893 3.125a.75.75 0 00.926.926l3.125-.893a.75.75 0 00.31-.178l7.79-7.793a1.75 1.75 0 000-2.475l-.812-.812zM11.72 3.22a.25.25 0 01.354 0l.812.812a.25.25 0 010 .354L12 5.272 10.728 4l.992-.78z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
          title="Delete"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 000 1.5h.3l.815 8.15A1.5 1.5 0 005.357 15h5.285a1.5 1.5 0 001.493-1.35l.815-8.15h.3a.75.75 0 000-1.5H11v-.75A2.25 2.25 0 008.75 1h-1.5A2.25 2.25 0 005 3.25zm2.25-.75a.75.75 0 00-.75.75V4h3v-.75a.75.75 0 00-.75-.75h-1.5z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  );
};

// ── Connection Form ──────────────────────────────────────────────────

const ConnectionForm = ({
  form,
  onChange,
  onSave,
  onCancel,
}: {
  readonly form: EditingState;
  readonly onChange: (form: EditingState) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) => {
  const update = (field: string, value: string) => onChange({ ...form, [field]: value });
  const canSave = form.name.trim() && form.url.trim() && (
    form.authMode === 'token' ? form.authToken.trim() : (form.clientId.trim() && form.clientSecret.trim() && form.tokenUrl.trim())
  );

  return (
    <div className="p-4 rounded-lg border-2 border-blue-300 dark:border-blue-600 bg-blue-50/30 dark:bg-blue-900/10 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Name</label>
          <input className={inputClass} value={form.name} onChange={e => update('name', e.target.value)} placeholder="e.g., Trestle Production" />
        </div>
        <div>
          <label className={labelClass}>Server URL</label>
          <input className={inputClass} value={form.url} onChange={e => update('url', e.target.value)} placeholder="https://api.example.com/odata" />
        </div>
      </div>

      <div>
        <label className={labelClass}>Auth Mode</label>
        <div className="flex gap-2">
          <button type="button" onClick={() => update('authMode', 'token')}
            className={`px-3 py-1 text-xs rounded-md border font-medium transition-colors ${form.authMode === 'token' ? 'bg-blue-600 text-white border-blue-600' : 'bg-transparent text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600'}`}>
            Bearer Token
          </button>
          <button type="button" onClick={() => update('authMode', 'client_credentials')}
            className={`px-3 py-1 text-xs rounded-md border font-medium transition-colors ${form.authMode === 'client_credentials' ? 'bg-blue-600 text-white border-blue-600' : 'bg-transparent text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600'}`}>
            Client Credentials
          </button>
        </div>
      </div>

      {form.authMode === 'token' ? (
        <div>
          <label className={labelClass}>Bearer Token</label>
          <MaskedInput value={form.authToken} onChange={v => update('authToken', v)} placeholder="Enter bearer token" className={`${inputClass} pr-9`} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Client ID</label>
            <input className={inputClass} value={form.clientId} onChange={e => update('clientId', e.target.value)} placeholder="Client ID" />
          </div>
          <div>
            <label className={labelClass}>Client Secret</label>
            <MaskedInput value={form.clientSecret} onChange={v => update('clientSecret', v)} placeholder="Client secret" className={`${inputClass} pr-9`} />
          </div>
          <div>
            <label className={labelClass}>Token URL</label>
            <input className={inputClass} value={form.tokenUrl} onChange={e => update('tokenUrl', e.target.value)} placeholder="https://auth.example.com/token" />
          </div>
          <div>
            <label className={labelClass}>Scope</label>
            <input className={inputClass} value={form.scope} onChange={e => update('scope', e.target.value)} placeholder="Optional" />
          </div>
        </div>
      )}

      <div>
        <label className={labelClass}>Originating System Name</label>
        <input className={inputClass} value={form.originatingSystemName} onChange={e => update('originatingSystemName', e.target.value)} placeholder="Optional — used for filtering" />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
          Cancel
        </button>
        <button type="button" onClick={onSave} disabled={!canSave}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
          {form.id ? 'Save Changes' : 'Add Connection'}
        </button>
      </div>
    </div>
  );
};
