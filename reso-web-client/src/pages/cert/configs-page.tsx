/**
 * Certification Config Manager — list, add, edit, delete, import/export
 * saved connection profiles and certification test configurations.
 */

import { useState, useEffect, useCallback } from 'react';
import { SearchInput } from '../../components/metadata/shared';
import {
  maskSecret,
  type SavedConnection,
  type StoredCredentials,
  storeCredentials,
  getCredentials,
  removeCredentials,
} from '../../services/config-storage';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';
const CARD = 'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4';

interface ConfigManagerAPI {
  readonly list: () => Promise<ReadonlyArray<SavedConnection>>;
  readonly save: (config: Record<string, unknown>) => Promise<SavedConnection>;
  readonly remove: (id: string) => Promise<boolean>;
  readonly importConfigs: (configs: ReadonlyArray<Record<string, unknown>>) => Promise<number>;
}

const getConfigManager = (): ConfigManagerAPI | null =>
  (window as unknown as Record<string, unknown>).configManager as ConfigManagerAPI | null;

const authLabel = (mode: string): string =>
  mode === 'client_credentials' ? 'Client Credentials' : 'Bearer Token';

export const ConfigsPage = () => {
  const [configs, setConfigs] = useState<ReadonlyArray<SavedConnection>>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const mgr = getConfigManager();
    if (!mgr) { setLoading(false); return; }
    const list = await mgr.list();
    setConfigs(list);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = useCallback(async (id: string) => {
    const mgr = getConfigManager();
    if (!mgr) return;
    await mgr.remove(id);
    await removeCredentials(id);
    setConfirmDelete(null);
    refresh();
  }, [refresh]);

  const handleExport = useCallback((config: SavedConnection) => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(config.name ?? 'config').replace(/[^a-zA-Z0-9-_ ]/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleExportAll = useCallback(() => {
    const blob = new Blob([JSON.stringify({ configs: [...configs] }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reso-saved-configs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [configs]);

  // Inline editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const startEdit = useCallback((config: SavedConnection) => {
    setEditingId(config.id);
    setEditName(config.name ?? '');
    setEditDescription(config.description ?? '');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    const mgr = getConfigManager();
    if (!mgr) return;
    const config = configs.find(c => c.id === editingId);
    if (!config) return;
    await mgr.save({ ...config, name: editName.trim(), description: editDescription.trim() });
    setEditingId(null);
    refresh();
  }, [editingId, editName, editDescription, configs, refresh]);

  const handleImport = useCallback(async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.multiple = true;
    input.onchange = async () => {
      const mgr = getConfigManager();
      if (!mgr || !input.files) return;
      const imported: Array<Record<string, unknown>> = [];
      for (const file of Array.from(input.files)) {
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          // Support single config or batch array
          if (Array.isArray(parsed.recipients)) {
            // BatchConfig format — expand to individual configs
            for (const r of parsed.recipients) {
              // Skip incomplete recipients (no UOI and no URL)
              if (!r.recipientUoi && !r.serviceRootUri) continue;
              const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
              imported.push({
                name: r.description || (r.recipientUoi ? `Recipient ${r.recipientUoi}` : `Imported ${timestamp}`),
                url: r.serviceRootUri,
                authMode: r.auth?.mode ?? 'token',
                clientId: r.auth?.clientId,
                tokenUrl: r.auth?.tokenUrl,
                scope: r.auth?.scope,
                providerUoi: parsed.providerUoi,
                providerUsi: r.providerUsi,
                recipientUoi: r.recipientUoi,
                certOptions: {
                  endorsements: r.endorsements,
                  ddOptions: r.ddOptions,
                  coreOptions: r.coreOptions,
                },
                isCert: true,
              });
              // Store credentials separately
              if (r.auth?.authToken || r.auth?.clientSecret) {
                const id = `${parsed.providerUoi}-${r.providerUsi}/${r.recipientUoi}`;
                await storeCredentials(id, {
                  authToken: r.auth?.authToken,
                  clientSecret: r.auth?.clientSecret,
                });
              }
            }
          } else if (parsed.configs && Array.isArray(parsed.configs)) {
            // Export All format — unwrap the configs array
            for (const c of parsed.configs) {
              // Strip wrapper metadata that shouldn't be on individual configs
              delete c.id;
              if (!c.isCert && c.providerUoi && c.recipientUoi) c.isCert = true;
              imported.push(c);
            }
          } else {
            // Single config — detect isCert from fields
            delete parsed.id; // strip any stale ID so a fresh one is generated
            if (!parsed.isCert && parsed.providerUoi && parsed.recipientUoi) {
              parsed.isCert = true;
            }
            imported.push(parsed);
          }
        } catch { /* skip bad files */ }
      }
      if (imported.length > 0) {
        await mgr.importConfigs(imported);
        refresh();
      }
    };
    input.click();
  }, [refresh]);

  // Filter configs by search query
  const filtered = search
    ? configs.filter(c => {
        const q = search.toLowerCase();
        return [c.name, c.url, c.providerUoi, c.providerName, c.recipientUoi, c.recipientName, c.systemName, c.providerUsi]
          .filter(Boolean)
          .some(field => field!.toLowerCase().includes(q));
      })
    : configs;

  const certConfigs = filtered.filter(c => c.isCert);
  const connectionConfigs = filtered.filter(c => !c.isCert);

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
        <div className={`${PAGE_CONTAINER} pt-6 pb-4`}>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
                Saved Configs
              </h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {loading ? 'Loading...' : `${configs.length} saved configuration${configs.length !== 1 ? 's' : ''}`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="min-w-[250px]">
                <SearchInput value={search} onChange={setSearch} placeholder="Search by name, URL, UOI..." />
              </div>
              <button
                type="button"
                onClick={handleImport}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors"
              >
                Import
              </button>
              {configs.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleExportAll()}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
                >
                  Export All
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className={`${PAGE_CONTAINER} pb-20`}>
        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500 py-8">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
            Loading configs...
          </div>
        )}

        {!loading && configs.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No saved configs yet.</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              Import a config file or save one from the test configuration builder.
            </p>
          </div>
        )}

        {/* Cert configs */}
        {certConfigs.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
              Certification Configs ({certConfigs.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {certConfigs.map(config => (
                <div key={config.id} className={CARD}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      {editingId === config.id ? (
                        <div className="space-y-1.5">
                          <input
                            type="text"
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            placeholder="Config name"
                            className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 outline-none"
                            onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null); }}
                            autoFocus
                          />
                          <input
                            type="text"
                            value={editDescription}
                            onChange={e => setEditDescription(e.target.value)}
                            placeholder="Description (optional)"
                            className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 outline-none"
                            onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null); }}
                          />
                          <div className="flex gap-1">
                            <button type="button" onClick={saveEdit} className="px-2 py-0.5 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 cursor-pointer">Save</button>
                            <button type="button" onClick={() => setEditingId(null)} className="px-2 py-0.5 text-[10px] font-medium rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 cursor-pointer">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                            {config.name || config.recipientName || config.recipientUoi || 'Unnamed'}
                          </h3>
                          {config.description && <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{config.description}</p>}
                          <p className="text-[11px] text-gray-400 dark:text-gray-500 font-mono truncate mt-0.5">
                            {config.url}
                          </p>
                        </>
                      )}
                    </div>
                    <span className={`shrink-0 ml-2 px-1.5 py-0.5 text-[10px] font-medium rounded ${
                      config.authMode === 'client_credentials'
                        ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                        : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    }`}>
                      {authLabel(config.authMode)}
                    </span>
                  </div>

                  <div className="mt-2 space-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {config.providerName && <p>Provider: {config.providerName}</p>}
                    {config.providerUoi && !config.providerName && <p>Provider: <span className="font-mono">{config.providerUoi}</span></p>}
                    {config.systemName && <p>System: {config.systemName}</p>}
                    {config.recipientName && <p>Recipient: {config.recipientName}</p>}
                    {config.recipientUoi && !config.recipientName && <p>Recipient: <span className="font-mono">{config.recipientUoi}</span></p>}
                    {config.clientId && <p>Client ID: <span className="font-mono">{maskSecret(config.clientId)}</span></p>}
                    <p className="text-[10px] text-gray-400">
                      {config.updatedAt ? `Updated ${new Date(config.updatedAt).toLocaleDateString()}` : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 mt-3 pt-2 border-t border-gray-100 dark:border-gray-700/50">
                    <button type="button" onClick={() => startEdit(config)} className="p-1.5 text-gray-400 hover:text-blue-500 cursor-pointer" title="Edit">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" /></svg>
                    </button>
                    <button type="button" onClick={() => handleExport(config)} className="p-1.5 text-gray-400 hover:text-blue-500 cursor-pointer" title="Download">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" /><path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" /></svg>
                    </button>
                    {confirmDelete === config.id ? (
                      <>
                        <button type="button" onClick={() => handleDelete(config.id)} className="px-2 py-1 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-700 cursor-pointer transition-colors">Confirm</button>
                        <button type="button" onClick={() => setConfirmDelete(null)} className="px-2 py-1 text-[10px] font-medium rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 cursor-pointer transition-colors">Cancel</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setConfirmDelete(config.id)} className="p-1.5 text-gray-400 hover:text-red-500 cursor-pointer" title="Delete">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5z" clipRule="evenodd" /></svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Non-cert connections */}
        {connectionConfigs.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
              Connections ({connectionConfigs.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {connectionConfigs.map(config => (
                <div key={config.id} className={CARD}>
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {config.name || 'Unnamed Connection'}
                  </h3>
                  <p className="text-[11px] text-gray-400 dark:text-gray-500 font-mono truncate mt-0.5">
                    {config.url}
                  </p>
                  <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-gray-100 dark:border-gray-700/50">
                    <button
                      type="button"
                      onClick={() => handleExport(config)}
                      className="px-2 py-1 text-[10px] font-medium rounded bg-gray-50 text-gray-600 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600 cursor-pointer transition-colors"
                    >
                      Export
                    </button>
                    <button
                      type="button"
                      onClick={() => confirmDelete === config.id ? handleDelete(config.id) : setConfirmDelete(config.id)}
                      className="px-2 py-1 text-[10px] font-medium rounded bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 cursor-pointer transition-colors"
                    >
                      {confirmDelete === config.id ? 'Confirm' : 'Delete'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
