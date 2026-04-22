import { useCallback, useEffect, useRef, useState } from 'react';
import { useServer } from '../context/server-context';
import { clearAllCaches } from '../api/schema-cache';
import { clearMetadataCache } from '../api/metadata';
import { ServerConnectionModal } from './server-connection-modal';
import { ConnectionManagerOverlay } from './connection-manager-overlay';
import type { ServerFormData } from './server-connection-modal';
import type { ServerConfig } from '../context/server-context';
import type { SavedConnection as ManagedConnection, StoredCredentials } from '../services/connection-manager';

/** Server switcher dropdown in the header — lets users switch between connections. */
export const ServerSwitcher = () => {
  const { activeServer, servers, switchServer, addServer, removeServer, updateServer, isLoadingResources, hasProxy } = useServer();
  const [isOpen, setIsOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfig | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [savedConfigs, setSavedConfigs] = useState<ReadonlyArray<ManagedConnection>>([]);
  const [configSearch, setConfigSearch] = useState('');

  // Load saved connections when dropdown opens
  useEffect(() => {
    if (!isOpen) return;
    import('../services/connection-manager').then(({ loadConnectionsMRU }) =>
      loadConnectionsMRU().then(setSavedConfigs)
    ).catch(() => {});
  }, [isOpen]);

  const filteredConfigs = configSearch.length >= 2
    ? savedConfigs.filter(c => {
        const q = configSearch.toLowerCase();
        return [c.name, c.url, c.originatingSystemName]
          .filter(Boolean)
          .some(f => f!.toLowerCase().includes(q));
      }).slice(0, 5)
    : savedConfigs.slice(0, 5);

  const handleSelectConfig = useCallback(
    async (config: ManagedConnection) => {
      // Get credentials from safeStorage
      const { getCredentials, touchMRU } = await import('../services/connection-manager');
      const creds = await getCredentials(config.id);

      const id = addServer({
        name: config.name || config.url,
        baseUrl: config.url,
        authMode: config.authMode === 'client_credentials' ? 'client_credentials' : 'token',
        token: creds?.authToken || undefined,
        clientId: config.clientId || undefined,
        clientSecret: creds?.clientSecret || undefined,
        tokenUrl: config.tokenUrl || undefined,
        scope: config.scope || undefined,
        permissions: { canAdd: false, canEdit: false, canDelete: false },
      });
      switchServer(id);
      await touchMRU(config.id);
      setIsOpen(false);
      setConfigSearch('');
    },
    [addServer, switchServer]
  );

  const handleSelectFromManager = useCallback(
    (conn: ManagedConnection, creds: StoredCredentials | null) => {
      const id = addServer({
        name: conn.name,
        baseUrl: conn.url,
        authMode: conn.authMode,
        token: creds?.authToken || undefined,
        clientId: conn.clientId || undefined,
        clientSecret: creds?.clientSecret || undefined,
        tokenUrl: conn.tokenUrl || undefined,
        scope: conn.scope || undefined,
        permissions: { canAdd: false, canEdit: false, canDelete: false },
      });
      switchServer(id);
    },
    [addServer, switchServer]
  );

  const handleToggle = useCallback(() => setIsOpen(prev => !prev), []);

  const handleSelect = useCallback(
    (id: string) => {
      switchServer(id);
      setIsOpen(false);
    },
    [switchServer]
  );

  const handleAddConnection = useCallback(
    (data: ServerFormData) => {
      const id = addServer({
        name: data.name,
        baseUrl: data.baseUrl,
        authMode: data.authMode,
        token: data.token || undefined,
        clientId: data.clientId || undefined,
        clientSecret: data.clientSecret || undefined,
        tokenUrl: data.tokenUrl || undefined,
        scope: data.scope || undefined,
        permissions: data.permissions
      });
      switchServer(id);
      setShowModal(false);
      setIsOpen(false);
    },
    [addServer, switchServer]
  );

  const handleEditConnection = useCallback(
    (data: ServerFormData) => {
      if (!editingServer) return;
      updateServer(editingServer.id, {
        name: data.name,
        baseUrl: data.baseUrl,
        authMode: data.authMode,
        token: data.token || undefined,
        clientId: data.clientId || undefined,
        clientSecret: data.clientSecret || undefined,
        tokenUrl: data.tokenUrl || undefined,
        scope: data.scope || undefined,
        permissions: data.permissions
      });
      setEditingServer(null);
    },
    [editingServer, updateServer]
  );

  const handleEdit = useCallback(
    (e: React.MouseEvent, server: ServerConfig) => {
      e.stopPropagation();
      setEditingServer(server);
      setIsOpen(false);
    },
    []
  );

  const handleRemove = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      removeServer(id);
    },
    [removeServer]
  );

  // Close dropdown on outside click
  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (dropdownRef.current && !dropdownRef.current.contains(e.relatedTarget as Node)) {
      setIsOpen(false);
    }
  }, []);

  return (
    <>
      <div ref={dropdownRef} className="relative" onBlur={handleBlur}>
        <button
          type="button"
          onClick={handleToggle}
          className="flex items-center gap-2 px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
          aria-expanded={isOpen}
          aria-haspopup="listbox">
          {/* Server status indicator */}
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              isLoadingResources
                ? 'bg-yellow-400 animate-pulse'
                : activeServer.type === 'local'
                  ? 'bg-green-400'
                  : 'bg-blue-400'
            }`}
          />
          <span className="truncate max-w-[300px] font-semibold">{activeServer.name}</span>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0">
            <path
              fillRule="evenodd"
              d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50 py-1">
            {servers.map(server => (
              <button
                key={server.id}
                type="button"
                onClick={() => handleSelect(server.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 text-left cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 ${
                  server.id === activeServer.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      server.type === 'local' ? 'bg-green-400' : 'bg-blue-400'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-sm text-gray-900 dark:text-gray-100">{server.name}</div>
                    {server.baseUrl && (
                      <div className="truncate text-xs text-gray-500 dark:text-gray-400">{server.baseUrl}</div>
                    )}
                  </div>
                </div>
                {server.id !== 'local' && (
                  <div className="flex items-center gap-1 ml-2 shrink-0">
                    <button
                      type="button"
                      onClick={e => handleEdit(e, server)}
                      className="p-0.5 text-gray-400 hover:text-blue-500 dark:hover:text-blue-400"
                      title="Edit connection">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M13.488 2.513a1.75 1.75 0 00-2.475 0L3.22 10.303a.75.75 0 00-.178.31l-.893 3.125a.75.75 0 00.926.926l3.125-.893a.75.75 0 00.31-.178l7.79-7.793a1.75 1.75 0 000-2.475l-.812-.812zM11.72 3.22a.25.25 0 01.354 0l.812.812a.25.25 0 010 .354L12 5.272 10.728 4l.992-.78z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={e => handleRemove(e, server.id)}
                      className="p-0.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                      title="Remove connection">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                      </svg>
                    </button>
                  </div>
                )}
              </button>
            ))}


            {/* Actions — full width */}
            <div className="border-t border-gray-200 dark:border-gray-700 mt-1 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowModal(true);
                  setIsOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 hover:brightness-125">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                  <path d="M8.75 3.75a.75.75 0 00-1.5 0v3.5h-3.5a.75.75 0 000 1.5h3.5v3.5a.75.75 0 001.5 0v-3.5h3.5a.75.75 0 000-1.5h-3.5v-3.5z" />
                </svg>
                Add Connection
              </button>
              <button
                type="button"
                onClick={() => {
                  clearAllCaches().then(() => clearMetadataCache());
                  setIsOpen(false);
                }}
                title="Clearing the metadata cache will refresh all metadata on each server the next time you connect to it."
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M13.836 2.477a.75.75 0 01.75.75v3.182a.75.75 0 01-.75.75h-3.182a.75.75 0 010-1.5h1.37l-.84-.841a4.5 4.5 0 00-7.08.681.75.75 0 01-1.3-.75 6 6 0 019.44-.908l.987.987V3.227a.75.75 0 01.75-.75zm-12.672 8a.75.75 0 01.75-.75h3.182a.75.75 0 010 1.5H3.726l.84.841a4.5 4.5 0 007.08-.681.75.75 0 011.3.75 6 6 0 01-9.44.908l-.987-.987v1.37a.75.75 0 01-1.5 0v-3.182z" clipRule="evenodd" />
                </svg>
                Clear Metadata Cache
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Add new connection modal */}
      <ServerConnectionModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleAddConnection}
        hasProxy={hasProxy}
      />

      {/* Connection manager overlay */}
      <ConnectionManagerOverlay
        isOpen={showManager}
        onClose={() => setShowManager(false)}
        onSelect={handleSelectFromManager}
      />

      {/* Edit existing connection modal */}
      {editingServer && (
        <ServerConnectionModal
          isOpen
          onClose={() => setEditingServer(null)}
          onSubmit={handleEditConnection}
          initial={{ name: editingServer.name, baseUrl: editingServer.baseUrl, authMode: editingServer.authMode ?? 'token', token: editingServer.token ?? '', clientId: editingServer.clientId ?? '', clientSecret: editingServer.clientSecret ?? '', tokenUrl: editingServer.tokenUrl ?? '', scope: editingServer.scope ?? '', permissions: editingServer.permissions ?? { canAdd: false, canEdit: false, canDelete: false } }}
          title="Edit Connection"
          hasProxy={hasProxy}
        />
      )}
    </>
  );
};
