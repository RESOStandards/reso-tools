/**
 * Saved Configs page — view, search, import, export, delete saved
 * certification test configurations (SavedCertConfig).
 *
 * Each config is one recipient with structured fields.
 * Credentials are stored separately in safeStorage via SavedCredentials.
 *
 * Clicking a config navigates to the Jobs page with that config loaded.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { SearchInput } from '../../components/metadata/shared';
import {
  loadProfiles,
  deleteProfile,
  loadConnections,
  getCredentials,
  type SavedCertConfig,
  type SavedCredentials,
  maskSecret,
} from '../../services/connection-manager';
import { importConfig, readConfigFile, type ImportResult } from '../../services/config-import';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';
const CARD = 'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4 hover:border-blue-300 dark:hover:border-blue-600 transition-colors cursor-pointer';

const endorsementLabel = (e: string): string =>
  e === 'dd' ? 'DD' : e === 'core' ? 'Core' : e === 'add-edit' ? 'Add/Edit' : e === 'entity-event' ? 'EntityEvent' : e;

export const ConfigsPage = () => {
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<ReadonlyArray<SavedCertConfig>>([]);
  const [credentials, setCredentials] = useState<Map<string, SavedCredentials>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const refresh = useCallback(async () => {
    const [profiles, connections] = await Promise.all([loadProfiles(), loadConnections()]);
    setConfigs(profiles);
    setCredentials(new Map(connections.map(c => [c.id, c])));
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteProfile(id);
    setConfirmDelete(null);
    refresh();
  }, [refresh]);

  const handleImport = useCallback(async () => {
    const raw = await readConfigFile();
    if (!raw) return;
    const result = await importConfig(raw);
    setImportResult(result);
    refresh();
  }, [refresh]);

  const handleLoad = useCallback(async (config: SavedCertConfig) => {
    // Retrieve credentials from safeStorage
    let authToken = '';
    let clientSecret = '';
    if (config.credentialsId) {
      const creds = await getCredentials(config.credentialsId);
      if (creds) {
        authToken = creds.authToken ?? '';
        clientSecret = creds.clientSecret ?? '';
      }
    }

    const conn = config.credentialsId ? credentials.get(config.credentialsId) : undefined;

    // Build a BatchConfig-shaped object for the config builder
    const loadConfig = {
      providerUoi: config.providerUoi,
      concurrency: 1,
      recipients: [{
        recipientUoi: config.recipientUoi,
        providerUsi: config.providerUsi ?? '',
        serviceRootUri: conn?.url ?? '',
        description: config.recipientName ?? config.name,
        auth: conn?.authMode === 'client_credentials'
          ? { mode: 'client_credentials' as const, clientId: conn.clientId ?? '', clientSecret, tokenUrl: conn.tokenUrl ?? '', scope: conn.scope ?? '', authToken: '' }
          : { mode: 'token' as const, authToken, clientId: '', clientSecret: '', tokenUrl: '', scope: '' },
        endorsements: [...config.endorsements],
        ddOptions: { version: config.ddVersion ?? '2.1', strictMode: config.strictMode ?? true, limit: config.limit, requestDelay: config.requestDelay, rateLimitWait: config.rateLimitWait, batchExpand: config.batchExpand },
        coreOptions: { version: '2.0.0' },
        addEditOptions: { resource: 'Property', specVersion: '2.0.0' },
        entityEventOptions: { mode: 'full' as const, writableResource: 'Property' },
      }],
    };

    navigate('/cert/jobs', { state: { loadConfig, configId: config.id, configName: config.name } });
  }, [navigate, credentials]);

  const handleExportAll = useCallback(() => {
    const exportData = configs.map(c => {
      const conn = c.credentialsId ? credentials.get(c.credentialsId) : undefined;
      return {
        name: c.name,
        providerUoi: c.providerUoi,
        providerUsi: c.providerUsi,
        recipientUoi: c.recipientUoi,
        serverUrl: conn?.url,
        authMode: conn?.authMode,
        endorsements: c.endorsements,
        ddVersion: c.ddVersion,
      };
    });
    const blob = new Blob([JSON.stringify({ configs: exportData }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reso-saved-configs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [configs, credentials]);

  // Filter by search
  const filtered = search
    ? configs.filter(c => {
        const q = search.toLowerCase();
        const conn = c.credentialsId ? credentials.get(c.credentialsId) : undefined;
        return [c.name, c.providerUoi, c.providerName, c.recipientUoi, c.recipientName, c.systemName, c.providerUsi, conn?.url]
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
        {/* Import result toast */}
        {importResult && (
          <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg text-xs text-blue-800 dark:text-blue-300 flex items-center justify-between">
            <span>
              Imported {importResult.configsCreated} config{importResult.configsCreated !== 1 ? 's' : ''}
              {importResult.credentialsCreated > 0 && `, ${importResult.credentialsCreated} new connection${importResult.credentialsCreated !== 1 ? 's' : ''}`}
              {importResult.credentialsReused > 0 && `, ${importResult.credentialsReused} existing`}
              {importResult.configsSkipped > 0 && `, ${importResult.configsSkipped} skipped`}
              {importResult.errors.length > 0 && ` (${importResult.errors.length} error${importResult.errors.length !== 1 ? 's' : ''})`}
            </span>
            <button type="button" onClick={() => setImportResult(null)} className="text-blue-400 hover:text-blue-600">
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
            </button>
          </div>
        )}

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
              const conn = cfg.credentialsId ? credentials.get(cfg.credentialsId) : undefined;
              return (
                <div key={cfg.id} className={CARD} onClick={() => handleLoad(cfg)}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {cfg.name}
                      </h3>
                      {conn?.url && (
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 font-mono truncate mt-0.5">
                          {conn.url}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      {cfg.endorsements.map(e => (
                        <span key={e} className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                          {endorsementLabel(e)}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="mt-2 space-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {cfg.providerName && <p>Provider: {cfg.providerName}</p>}
                    {!cfg.providerName && cfg.providerUoi && <p>Provider: <span className="font-mono">{cfg.providerUoi}</span></p>}
                    {cfg.recipientName && <p>Recipient: {cfg.recipientName}</p>}
                    {!cfg.recipientName && cfg.recipientUoi && <p>Recipient: <span className="font-mono">{cfg.recipientUoi}</span></p>}
                    {cfg.systemName && <p>System: {cfg.systemName}</p>}
                    {cfg.ddVersion && <p>DD Version: {cfg.ddVersion}</p>}
                    {conn && (
                      <p>Auth: {conn.authMode === 'client_credentials' ? 'Client Credentials' : 'Bearer Token'}
                        {conn.clientId && ` (${maskSecret(conn.clientId)})`}
                      </p>
                    )}
                    <p className="text-[10px] text-gray-400">
                      Updated {new Date(cfg.updatedAt).toLocaleDateString()}
                      {cfg.lastRunAt && ` · Last run ${new Date(cfg.lastRunAt).toLocaleDateString()}`}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 mt-3 pt-2 border-t border-gray-100 dark:border-gray-700/50" onClick={e => e.stopPropagation()}>
                    {confirmDelete === cfg.id ? (
                      <>
                        <button type="button" onClick={() => handleDelete(cfg.id)} className="px-2 py-1 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-700 cursor-pointer">Confirm Delete</button>
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
