/**
 * Saved certification configs service.
 *
 * Persists named cert job configurations via Electron's secure storage
 * (OS keychain when available, plain JSON otherwise). Provides CRUD
 * operations and import/export as JSON files.
 *
 * Storage key: 'cert-saved-configs' → JSON array of SavedConfig objects.
 */

export interface SavedConfig {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly config: Readonly<Record<string, unknown>>;
}

const STORAGE_KEY = 'cert-saved-configs';

interface ElectronStorage {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

const getStorage = (): ElectronStorage | null =>
  (window as unknown as Record<string, unknown>).electronStorage as ElectronStorage | null;

const isElectron = (): boolean => getStorage() !== null;

/** Read all saved configs from storage. */
export const loadSavedConfigs = async (): Promise<ReadonlyArray<SavedConfig>> => {
  const storage = getStorage();
  if (!storage) return [];
  const raw = await storage.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ReadonlyArray<SavedConfig>;
  } catch {
    return [];
  }
};

/** Write all saved configs to storage. */
const writeSavedConfigs = async (configs: ReadonlyArray<SavedConfig>): Promise<void> => {
  const storage = getStorage();
  if (!storage) return;
  await storage.set(STORAGE_KEY, JSON.stringify(configs));
};

/** Save a new config or update an existing one by ID. */
export const saveConfig = async (name: string, config: Record<string, unknown>, existingId?: string): Promise<SavedConfig> => {
  const configs = await loadSavedConfigs();
  const now = new Date().toISOString();

  if (existingId) {
    const updated = configs.map(c =>
      c.id === existingId ? { ...c, name, config, updatedAt: now } : c
    );
    await writeSavedConfigs(updated);
    return updated.find(c => c.id === existingId)!;
  }

  const newConfig: SavedConfig = {
    id: `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: now,
    updatedAt: now,
    config,
  };
  await writeSavedConfigs([...configs, newConfig]);
  return newConfig;
};

/** Delete a saved config by ID. */
export const deleteConfig = async (id: string): Promise<void> => {
  const configs = await loadSavedConfigs();
  await writeSavedConfigs(configs.filter(c => c.id !== id));
};

/** Export a config as a downloadable JSON file. */
export const exportConfig = (config: SavedConfig): void => {
  const blob = new Blob([JSON.stringify(config.config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${config.name.replace(/[^a-zA-Z0-9-_ ]/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

/** Import a config from a JSON file. Returns the parsed config object. */
export const importConfigFromFile = (): Promise<Record<string, unknown> | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    };
    input.click();
  });

/** Check if secure encryption is available (app is signed). */
export const isEncryptionAvailable = (): boolean => isElectron();
// Note: we can't directly check safeStorage.isEncryptionAvailable() from the
// renderer. The electronStorage API already handles encryption transparently.
// When the app is unsigned, safeStorage falls back to plain JSON.
// The warning should always show until we have confirmed signing.
export const CREDENTIALS_WARNING = 'Saved credentials are stored on your local filesystem. For best security, use Import/Export instead \u2014 your config file stays under your control and is not persisted by the application.';
