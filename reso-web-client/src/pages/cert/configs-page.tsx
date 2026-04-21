/**
 * Saved Configs page — view, search, import, export, delete saved
 * certification test configurations.
 *
 * Uses the same storage as the Jobs page config builder panel
 * (saved-configs.ts). One storage system, two views.
 *
 * Clicking a config navigates to the Jobs page with that config loaded.
 * Editing happens on the Jobs page — this page is the library.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { SearchInput } from '../../components/metadata/shared';
import {
  loadSavedConfigs,
  deleteConfig,
  exportConfig,
  importConfigFromFile,
  type SavedConfig,
} from '../../services/saved-configs';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';
const CARD = 'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4 hover:border-blue-300 dark:hover:border-blue-600 transition-colors cursor-pointer';

/** Extract display info from a raw config blob. */
const configSummary = (config: Record<string, unknown>): { provider?: string; recipient?: string; url?: string; endorsements?: string; version?: string } => {
  const recipients = config.recipients as ReadonlyArray<Record<string, unknown>> | undefined;
  const first = recipients?.[0];
  return {
    provider: (config.providerUoi as string) ?? undefined,
    recipient: first ? ((first.description as string) ?? (first.recipientUoi as string) ?? undefined) : undefined,
    url: (first?.serviceRootUri as string) ?? undefined,
    endorsements: first?.endorsements ? (first.endorsements as string[]).join(', ') : undefined,
    version: (first?.ddOptions as Record<string, unknown>)?.version as string | undefined,
  };
};

export const ConfigsPage = () => {
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<ReadonlyArray<SavedConfig>>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setConfigs(await loadSavedConfigs());
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteConfig(id);
    setConfirmDelete(null);
    refresh();
  }, [refresh]);

  const handleExportAll = useCallback(() => {
    const blob = new Blob([JSON.stringify({ configs: configs.map(c => ({ name: c.name, config: c.config })) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reso-saved-configs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [configs]);

  const handleImport = useCallback(async () => {
    const imported = await importConfigFromFile();
    if (imported) {
      // Navigate to Jobs page with the imported config loaded
      navigate('/cert/jobs', { state: { loadConfig: imported } });
    }
  }, [navigate]);

  const handleLoad = useCallback((config: SavedConfig) => {
    navigate('/cert/jobs', { state: { loadConfig: config.config, configId: config.id, configName: config.name } });
  }, [navigate]);

  // Filter by search
  const filtered = search
    ? configs.filter(c => {
        const q = search.toLowerCase();
        const summary = configSummary(c.config as Record<string, unknown>);
        return [c.name, summary.provider, summary.recipient, summary.url, summary.endorsements]
          .filter(Boolean)
          .some(field => field!.toLowerCase().includes(q));
      })
    : configs;

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
                <SearchInput value={search} onChange={setSearch} placeholder="Search by name, provider, recipient..." />
              </div>
              <button
                type="button"
                onClick={() => navigate('/cert/jobs', { state: { loadConfig: {} } })}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors"
              >
                New Config
              </button>
              <button
                type="button"
                onClick={handleImport}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
              >
                Import
              </button>
              {configs.length > 0 && (
                <button
                  type="button"
                  onClick={handleExportAll}
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

        {filtered.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map(cfg => {
              const summary = configSummary(cfg.config as Record<string, unknown>);
              return (
                <div key={cfg.id} className={CARD} onClick={() => handleLoad(cfg)}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {cfg.name}
                      </h3>
                      {summary.url && (
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 font-mono truncate mt-0.5">
                          {summary.url}
                        </p>
                      )}
                    </div>
                    {summary.version && (
                      <span className="shrink-0 ml-2 px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                        DD {summary.version}
                      </span>
                    )}
                  </div>

                  <div className="mt-2 space-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {summary.provider && <p>Provider: <span className="font-mono">{summary.provider}</span></p>}
                    {summary.recipient && <p>Recipient: {summary.recipient}</p>}
                    {summary.endorsements && <p>Endorsements: {summary.endorsements}</p>}
                    <p className="text-[10px] text-gray-400">
                      Updated {new Date(cfg.updatedAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 mt-3 pt-2 border-t border-gray-100 dark:border-gray-700/50" onClick={e => e.stopPropagation()}>
                    <button type="button" onClick={() => exportConfig(cfg)} className="p-1.5 text-gray-400 hover:text-blue-500 cursor-pointer" title="Export">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" /><path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" /></svg>
                    </button>
                    {confirmDelete === cfg.id ? (
                      <>
                        <button type="button" onClick={() => handleDelete(cfg.id)} className="px-2 py-1 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-700 cursor-pointer">Confirm</button>
                        <button type="button" onClick={() => setConfirmDelete(null)} className="px-2 py-1 text-[10px] font-medium rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 cursor-pointer">Cancel</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setConfirmDelete(cfg.id)} className="p-1.5 text-gray-400 hover:text-red-500 cursor-pointer" title="Delete">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5z" clipRule="evenodd" /></svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
