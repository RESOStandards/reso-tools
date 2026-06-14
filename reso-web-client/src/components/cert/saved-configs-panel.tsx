/**
 * Saved Configs panel — compact MRU list at the bottom of the config builder.
 *
 * Shows the 3 most recently updated configs, a search box for finding
 * others, and a "View All" link to the Saved Configs page.
 *
 * Uses connection-manager.ts (SavedCertConfig) as the storage backend.
 */

import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import {
  loadProfiles,
  loadConnections,
  type SavedCertConfig,
  type SavedCredentials,
} from '../../services/connection-manager';
import { toDDVersionShort } from '../../constants/cert';

interface SavedConfigsPanelProps {
  /** Called when the user loads a saved config into the form. */
  readonly onLoad: (config: Record<string, unknown>, configId: string, configName: string) => void;
}

const endorsementLabel = (e: string): string =>
  e === 'dd' ? 'DD' : e === 'core' ? 'Core' : e === 'add-edit' ? 'Add/Edit' : e === 'entity-event' ? 'EE' : e;

export const SavedConfigsPanel = ({ onLoad }: SavedConfigsPanelProps) => {
  const [configs, setConfigs] = useState<ReadonlyArray<SavedCertConfig>>([]);
  const [credentials, setCredentials] = useState<Map<string, SavedCredentials>>(new Map());
  const [search, setSearch] = useState('');

  useEffect(() => {
    Promise.all([loadProfiles(), loadConnections()]).then(([profiles, connections]) => {
      setConfigs(profiles);
      setCredentials(new Map(connections.map(c => [c.id, c])));
    });
  }, []);

  const handleLoad = useCallback(async (cfg: SavedCertConfig) => {
    const { getCredentials } = await import('../../services/connection-manager');
    let authToken = '';
    let clientSecret = '';
    if (cfg.credentialsId) {
      const creds = await getCredentials(cfg.credentialsId);
      if (creds) { authToken = creds.authToken ?? ''; clientSecret = creds.clientSecret ?? ''; }
    }
    const conn = cfg.credentialsId ? credentials.get(cfg.credentialsId) : undefined;

    const loadConfig = {
      providerUoi: cfg.providerUoi,
      concurrency: 1,
      recipients: [{
        recipientUoi: cfg.recipientUoi,
        providerUsi: cfg.providerUsi ?? '',
        serviceRootUri: conn?.url ?? '',
        description: cfg.recipientName ?? cfg.name,
        auth: conn?.authMode === 'client_credentials'
          ? { mode: 'client_credentials' as const, clientId: conn.clientId ?? '', clientSecret, tokenUrl: conn.tokenUrl ?? '', scope: conn.scope ?? '', authToken: '' }
          : { mode: 'token' as const, authToken, clientId: '', clientSecret: '', tokenUrl: '', scope: '' },
        endorsements: [...cfg.endorsements],
        ddOptions: { version: toDDVersionShort(cfg.ddVersion ?? '2.1'), strictMode: cfg.strictMode ?? true, limit: cfg.limit, requestDelay: cfg.requestDelay, rateLimitWait: cfg.rateLimitWait, batchExpand: cfg.batchExpand },
        coreOptions: { version: '2.0.0' },
        addEditOptions: { resource: 'Property', specVersion: '2.0.0' },
        entityEventOptions: { mode: 'full' as const, writableResource: 'Property' },
      }],
    };

    onLoad(loadConfig as unknown as Record<string, unknown>, cfg.id, cfg.name);
  }, [credentials, onLoad]);

  // MRU 3 or search results
  const sorted = [...configs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const displayed = search.length >= 2
    ? sorted.filter(c => {
        const q = search.toLowerCase();
        const conn = c.credentialsId ? credentials.get(c.credentialsId) : undefined;
        return [c.name, c.providerUoi, c.providerName, c.recipientUoi, c.recipientName, conn?.url]
          .filter(Boolean)
          .some(f => f!.toLowerCase().includes(q));
      }).slice(0, 5)
    : sorted.slice(0, 3);

  if (configs.length === 0) return null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Saved Configs ({configs.length})
        </p>
        <NavLink to="/cert/configs" className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">
          View All
        </NavLink>
      </div>

      {configs.length > 3 && (
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search saved configs..."
          className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 outline-none"
        />
      )}

      <div className="space-y-1">
        {displayed.map(cfg => {
          const conn = cfg.credentialsId ? credentials.get(cfg.credentialsId) : undefined;
          return (
            <button
              key={cfg.id}
              type="button"
              onClick={() => handleLoad(cfg)}
              className="w-full flex items-center justify-between p-2 bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-blue-300 dark:hover:border-blue-600 cursor-pointer transition-colors text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{cfg.name}</p>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                  {conn?.url ?? cfg.recipientUoi}
                </p>
              </div>
              <div className="flex items-center gap-1 ml-2 shrink-0">
                {cfg.endorsements.slice(0, 2).map(e => (
                  <span key={e} className="px-1 py-0.5 text-[8px] font-medium rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                    {endorsementLabel(e)}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
