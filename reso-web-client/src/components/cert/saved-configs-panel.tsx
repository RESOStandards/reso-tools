/**
 * Saved Configs panel — load, save, delete, import/export cert job configs.
 *
 * Embedded in the config builder. Persists via Electron's secure storage.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  loadSavedConfigs,
  saveConfig,
  deleteConfig,
  exportConfig,
  importConfigFromFile,
  type SavedConfig,
} from '../../services/saved-configs';
import type { BatchConfig } from './config-builder';

interface SavedConfigsPanelProps {
  /** Current config from the form — used when saving. */
  readonly currentConfig: BatchConfig | null;
  /** Called when the user loads a saved config. */
  readonly onLoad: (config: Record<string, unknown>) => void;
}

const hasCredentials = (config: Record<string, unknown>): boolean => {
  const json = JSON.stringify(config);
  return json.includes('clientSecret') || json.includes('authToken');
};

export const SavedConfigsPanel = ({ currentConfig, onLoad }: SavedConfigsPanelProps) => {
  const [configs, setConfigs] = useState<ReadonlyArray<SavedConfig>>([]);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Load saved configs on mount
  useEffect(() => {
    loadSavedConfigs().then(setConfigs);
  }, []);

  const handleSave = useCallback(async () => {
    if (!currentConfig || !saveName.trim()) return;

    // Check if credentials are present and show warning
    if (hasCredentials(currentConfig as unknown as Record<string, unknown>) && !showWarning) {
      setShowWarning(true);
      return;
    }

    await saveConfig(saveName.trim(), currentConfig as unknown as Record<string, unknown>);
    setConfigs(await loadSavedConfigs());
    setSaveName('');
    setShowSave(false);
    setShowWarning(false);
  }, [currentConfig, saveName, showWarning]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteConfig(id);
    setConfigs(await loadSavedConfigs());
    setConfirmDelete(null);
  }, []);

  const handleImport = useCallback(async () => {
    const imported = await importConfigFromFile();
    if (imported) onLoad(imported);
  }, [onLoad]);

  const handleExport = useCallback((config: SavedConfig) => {
    exportConfig(config);
  }, []);

  return (
    <div className="space-y-3">
      {/* Actions bar */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowSave(!showSave)}
          disabled={!currentConfig}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 cursor-pointer transition-colors"
        >
          Save Current Config
        </button>
        <button
          type="button"
          onClick={handleImport}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors"
        >
          Import JSON
        </button>
      </div>

      {/* Save dialog */}
      {showSave && (
        <div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
          <input
            type="text"
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            placeholder="Config name (e.g., Trestle DD 2.0)"
            className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 outline-none"
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
          />
          <button
            type="button"
            onClick={handleSave}
            disabled={!saveName.trim()}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 cursor-pointer transition-colors"
          >
            {showWarning ? 'Save Anyway' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => { setShowSave(false); setShowWarning(false); }}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500 cursor-pointer transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Credential warning confirmation */}
      {showWarning && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-800 dark:text-red-300">
          <p className="font-medium">This config contains credentials.</p>
          <p className="mt-1">Credentials will be stored locally. For best security, export the config as a file instead. Click "Save Anyway" to proceed.</p>
        </div>
      )}

      {/* Saved configs list */}
      {configs.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Saved Configs ({configs.length})
          </p>
          {configs.map(cfg => (
            <div
              key={cfg.id}
              className="flex items-center justify-between p-2 bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{cfg.name}</p>
                <p className="text-[10px] text-gray-400 dark:text-gray-500">
                  {new Date(cfg.updatedAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-1.5 ml-2">
                <button
                  type="button"
                  onClick={() => onLoad(cfg.config as Record<string, unknown>)}
                  className="px-2 py-1 text-[10px] font-medium rounded bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50 cursor-pointer transition-colors"
                >
                  Load
                </button>
                <button
                  type="button"
                  onClick={() => handleExport(cfg)}
                  className="px-2 py-1 text-[10px] font-medium rounded bg-gray-50 text-gray-600 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600 cursor-pointer transition-colors"
                >
                  Export
                </button>
                {confirmDelete === cfg.id ? (
                  <button
                    type="button"
                    onClick={() => handleDelete(cfg.id)}
                    className="px-2 py-1 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-700 cursor-pointer transition-colors"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(cfg.id)}
                    className="px-2 py-1 text-[10px] font-medium rounded bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 cursor-pointer transition-colors"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {configs.length === 0 && !showSave && (
        <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">
          No saved configs yet. Configure a test run and save it, or import a JSON config file.
        </p>
      )}
    </div>
  );
};
