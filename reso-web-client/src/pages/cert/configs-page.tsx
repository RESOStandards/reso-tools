/**
 * Certification Config Manager — list, add, edit, delete, import/export
 * saved connection profiles and certification test configurations.
 */

import { useState, useEffect, useCallback } from 'react';
import { SearchInput } from '../../components/metadata/shared';
import {
  maskSecret,
  CREDENTIALS_WARNING,
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
              imported.push({
                name: r.description || `${r.recipientUoi ?? 'Unknown'}`,
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
          } else {
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
            </div>
          </div>
        </div>
      </div>

      <div className={`${PAGE_CONTAINER} pb-20`}>
        {/* Warning banner */}
        <div className="flex items-start gap-2 p-3 mb-6 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-800 dark:text-amber-300">
          <span className="text-base leading-none mt-px">⚠️</span>
          <p>{CREDENTIALS_WARNING}</p>
        </div>

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
                      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {config.name || config.recipientName || config.recipientUoi || 'Unnamed'}
                      </h3>
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 font-mono truncate mt-0.5">
                        {config.url}
                      </p>
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

                  <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-gray-100 dark:border-gray-700/50">
                    <button
                      type="button"
                      onClick={() => handleExport(config)}
                      className="px-2 py-1 text-[10px] font-medium rounded bg-gray-50 text-gray-600 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600 cursor-pointer transition-colors"
                    >
                      Export
                    </button>
                    {confirmDelete === config.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleDelete(config.id)}
                          className="px-2 py-1 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-700 cursor-pointer transition-colors"
                        >
                          Confirm Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(null)}
                          className="px-2 py-1 text-[10px] font-medium rounded bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 cursor-pointer transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(config.id)}
                        className="px-2 py-1 text-[10px] font-medium rounded bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 cursor-pointer transition-colors"
                      >
                        Delete
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
