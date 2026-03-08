import { useCallback, useRef, useState } from 'react';
import { useServer } from '../context/server-context';
import { ServerConnectionModal } from './server-connection-modal';
import type { ServerFormData } from './server-connection-modal';
import type { ServerConfig } from '../context/server-context';

/** Server switcher dropdown in the header — lets users switch between connections. */
export const ServerSwitcher = () => {
  const { activeServer, servers, switchServer, addServer, removeServer, updateServer, isLoadingResources } = useServer();
  const [isOpen, setIsOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfig | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
        token: data.token || undefined
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
        token: data.token || undefined
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
          <span className="truncate max-w-[200px] font-semibold">{activeServer.name}</span>
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
                className={`w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 ${
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

            <div className="border-t border-gray-200 dark:border-gray-700 mt-1 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowModal(true);
                  setIsOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                  <path d="M8.75 3.75a.75.75 0 00-1.5 0v3.5h-3.5a.75.75 0 000 1.5h3.5v3.5a.75.75 0 001.5 0v-3.5h3.5a.75.75 0 000-1.5h-3.5v-3.5z" />
                </svg>
                Add Connection
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
      />

      {/* Edit existing connection modal */}
      {editingServer && (
        <ServerConnectionModal
          isOpen
          onClose={() => setEditingServer(null)}
          onSubmit={handleEditConnection}
          initial={{ name: editingServer.name, baseUrl: editingServer.baseUrl, token: editingServer.token ?? '' }}
          title="Edit Connection"
        />
      )}
    </>
  );
};
