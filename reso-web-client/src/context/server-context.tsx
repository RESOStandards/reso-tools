import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** Per-operation permissions for a server connection. */
export interface ServerPermissions {
  readonly canAdd: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

/** Server connection configuration. */
export interface ServerConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly token?: string;
  readonly type: 'local' | 'external';
  /** Per-operation permissions. Local server defaults to all true; external defaults to all false. */
  readonly permissions?: ServerPermissions;
}

/** The built-in local reference server — always available. */
const LOCAL_SERVER: ServerConfig = {
  id: 'local',
  name: 'RESO Reference Server',
  baseUrl: '',
  type: 'local'
};

const STORAGE_KEY = 'reso-server-configs';
const ACTIVE_KEY = 'reso-active-server';

// ── Storage abstraction: Electron secure storage or browser localStorage ──

/** Electron preload API shape, available only in the desktop client. */
interface ElectronStorageApi {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

/** True when running inside the Electron desktop client (preload script exposes this). */
const isElectron = (): boolean => 'electronStorage' in window;

/** Access the Electron storage API (only call after isElectron() check). */
const electronStorage = (): ElectronStorageApi =>
  (window as unknown as { electronStorage: ElectronStorageApi }).electronStorage;

/** Load saved external server configs (async — works with both Electron and localStorage). */
const loadSavedConfigs = async (): Promise<ReadonlyArray<ServerConfig>> => {
  try {
    const raw = isElectron()
      ? await electronStorage().get(STORAGE_KEY)
      : localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ReadonlyArray<ServerConfig>;
  } catch {
    return [];
  }
};

/** Load the active server ID (async). */
const loadActiveServerId = async (): Promise<string> => {
  try {
    const val = isElectron()
      ? await electronStorage().get(ACTIVE_KEY)
      : localStorage.getItem(ACTIVE_KEY);
    return val ?? 'local';
  } catch {
    return 'local';
  }
};

/** Save external server configs (async). */
const persistConfigs = async (configs: ReadonlyArray<ServerConfig>): Promise<void> => {
  const json = JSON.stringify(configs);
  if (isElectron()) {
    await electronStorage().set(STORAGE_KEY, json);
  } else {
    localStorage.setItem(STORAGE_KEY, json);
  }
};

/** Save the active server ID (async). */
const persistActiveServer = async (id: string): Promise<void> => {
  if (isElectron()) {
    await electronStorage().set(ACTIVE_KEY, id);
  } else {
    localStorage.setItem(ACTIVE_KEY, id);
  }
};

/** Dynamic resource info discovered from a server's metadata. */
export interface ResourceInfo {
  readonly name: string;
  readonly entityType: string;
  readonly keyField: string;
  /** Human-friendly alternate key field (e.g. `ListingId` for Property). */
  readonly alternateKeyField?: string;
  /** Navigation property names available for $expand. */
  readonly navigationProperties: ReadonlyArray<string>;
}

/** Server context value exposed to consumers. */
export interface ServerContextValue {
  /** The currently active server configuration. */
  readonly activeServer: ServerConfig;
  /** All available server configurations (local + saved external). */
  readonly servers: ReadonlyArray<ServerConfig>;
  /** Resources available on the active server. null while loading. */
  readonly resources: ReadonlyArray<ResourceInfo> | null;
  /** Whether metadata is currently being loaded for the active server. */
  readonly isLoadingResources: boolean;
  /** Error from metadata loading, if any. */
  readonly resourceError: string | null;
  /** Switch to a different server by ID. */
  readonly switchServer: (id: string) => void;
  /** Add a new external server configuration. Returns the generated ID. */
  readonly addServer: (config: Omit<ServerConfig, 'id' | 'type'>) => string;
  /** Remove an external server configuration by ID. */
  readonly removeServer: (id: string) => void;
  /** Update an existing external server configuration. */
  readonly updateServer: (id: string, updates: Partial<Omit<ServerConfig, 'id' | 'type'>>) => void;
  /** Whether the active server is the local reference server. */
  readonly isLocal: boolean;
  /** Resolved permissions for the active server. */
  readonly permissions: ServerPermissions;
  /** Get the key field name for a resource (discovered from $metadata). */
  readonly getKeyField: (resource: string) => string;
  /** Get the human-friendly alternate key field for a resource, if one exists. */
  readonly getAlternateKeyField: (resource: string) => string | undefined;
  /** Whether the server has a Lookup entity set (for Lookup Resource enum fields). */
  readonly hasLookupResource: boolean;
}

const ServerContext = createContext<ServerContextValue | null>(null);

/** Hook to access the server context. Throws if used outside ServerProvider. */
export const useServer = (): ServerContextValue => {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServer must be used within a ServerProvider');
  return ctx;
};

/** Generates a short random ID for new server configs. */
const generateId = (): string => crypto.randomUUID().slice(0, 8);

export interface ServerProviderProps {
  readonly children: ReactNode;
}

/**
 * Resolve the $metadata URL for fetching.
 * - Local server: relative path (through Vite dev proxy or same origin)
 * - External localhost: direct URL
 * - External remote: through /api/proxy to avoid CORS
 */
const resolveMetadataUrl = (baseUrl: string): string => {
  if (!baseUrl) {
    // Local server — relative path
    return '/$metadata?$format=application/xml';
  }
  const rawUrl = `${baseUrl}/$metadata?$format=application/xml`;
  try {
    const hostname = new URL(rawUrl).hostname;
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) return rawUrl;
  } catch { /* fall through to proxy */ }
  return `/api/proxy?url=${encodeURIComponent(rawUrl)}`;
};

/** Provider that manages server connections and exposes them via context. */
export const ServerProvider = ({ children }: ServerProviderProps) => {
  const [externalConfigs, setExternalConfigs] = useState<ReadonlyArray<ServerConfig>>([]);
  const [activeServerId, setActiveServerId] = useState<string>('local');
  const [storageReady, setStorageReady] = useState(!isElectron());
  const [resources, setResources] = useState<ReadonlyArray<ResourceInfo> | null>(null);
  const [isLoadingResources, setIsLoadingResources] = useState(true);
  const [resourceError, setResourceError] = useState<string | null>(null);

  // Hydrate state from storage (async for Electron secure storage, instant for localStorage)
  useEffect(() => {
    if (storageReady && !isElectron()) return; // localStorage already hydrated synchronously below
    let cancelled = false;
    const hydrate = async () => {
      const [configs, activeId] = await Promise.all([loadSavedConfigs(), loadActiveServerId()]);
      if (!cancelled) {
        setExternalConfigs(configs);
        setActiveServerId(activeId);
        setStorageReady(true);
      }
    };
    hydrate();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // For web (non-Electron), hydrate synchronously on mount so there's no flash
  useEffect(() => {
    if (isElectron()) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) setExternalConfigs(parsed as ReadonlyArray<ServerConfig>);
      }
      const activeId = localStorage.getItem(ACTIVE_KEY);
      if (activeId) setActiveServerId(activeId);
    } catch { /* ignore */ }
  }, []);

  const servers = useMemo(() => [LOCAL_SERVER, ...externalConfigs], [externalConfigs]);

  const activeServer = useMemo(
    () => servers.find(s => s.id === activeServerId) ?? LOCAL_SERVER,
    [servers, activeServerId]
  );

  const isLocal = activeServer.type === 'local';

  // Fetch $metadata to discover resources and keys (wait for storage hydration)
  useEffect(() => {
    if (!storageReady) return;
    const controller = new AbortController();
    setIsLoadingResources(true);
    setResourceError(null);
    setResources(null);

    const loadMetadata = async () => {
      try {
        const { parseCsdlXml, discoverResources } = await import('@reso/odata-client');

        const headers: Record<string, string> = { Accept: 'application/xml' };
        if (activeServer.token) {
          headers['Authorization'] = `Bearer ${activeServer.token}`;
        }

        const metadataUrl = resolveMetadataUrl(activeServer.baseUrl);
        const needsCacheBust = metadataUrl.startsWith('/api/proxy');
        const res = await fetch(metadataUrl, {
          headers,
          signal: controller.signal,
          ...(needsCacheBust ? { cache: 'no-store' as const } : {})
        });
        if (!res.ok) throw new Error(`Failed to fetch metadata: ${res.status} ${res.statusText}`);

        const xml = await res.text();
        const schema = parseCsdlXml(xml);
        const discovered = discoverResources(schema);

        if (!controller.signal.aborted) {
          setResources(discovered);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setResourceError(err instanceof Error ? err.message : 'Failed to load server metadata');
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingResources(false);
        }
      }
    };

    loadMetadata();
    return () => controller.abort();
  }, [activeServer, storageReady]);

  const switchServer = useCallback((id: string) => {
    setActiveServerId(id);
    void persistActiveServer(id);
  }, []);

  const addServer = useCallback((config: Omit<ServerConfig, 'id' | 'type'>): string => {
    const id = generateId();
    const newConfig: ServerConfig = { ...config, id, type: 'external' };
    setExternalConfigs(prev => {
      const updated = [...prev, newConfig];
      void persistConfigs(updated);
      return updated;
    });
    return id;
  }, []);

  const removeServer = useCallback((id: string) => {
    if (id === 'local') return;
    setExternalConfigs(prev => {
      const updated = prev.filter(c => c.id !== id);
      void persistConfigs(updated);
      return updated;
    });
    setActiveServerId(prev => (prev === id ? 'local' : prev));
  }, []);

  const updateServer = useCallback((id: string, updates: Partial<Omit<ServerConfig, 'id' | 'type'>>) => {
    if (id === 'local') return;
    setExternalConfigs(prev => {
      const updated = prev.map(c => (c.id === id ? { ...c, ...updates } : c));
      void persistConfigs(updated);
      return updated;
    });
  }, []);

  const getKeyField = useCallback(
    (resource: string): string => {
      const info = resources?.find(r => r.name === resource);
      return info?.keyField ?? `${resource}Key`;
    },
    [resources]
  );

  const getAlternateKeyField = useCallback(
    (resource: string): string | undefined =>
      resources?.find(r => r.name === resource)?.alternateKeyField,
    [resources]
  );

  const hasLookupResource = useMemo(
    () => resources?.some(r => r.name === 'Lookup') ?? false,
    [resources]
  );

  /** Resolve permissions: local server always has full access; external uses stored config. */
  const permissions = useMemo<ServerPermissions>(
    () => isLocal
      ? { canAdd: true, canEdit: true, canDelete: true }
      : activeServer.permissions ?? { canAdd: false, canEdit: false, canDelete: false },
    [isLocal, activeServer.permissions]
  );

  const value = useMemo<ServerContextValue>(
    () => ({
      activeServer,
      servers,
      resources,
      isLoadingResources,
      resourceError,
      switchServer,
      addServer,
      removeServer,
      updateServer,
      isLocal,
      permissions,
      getKeyField,
      getAlternateKeyField,
      hasLookupResource
    }),
    [activeServer, servers, resources, isLoadingResources, resourceError, switchServer, addServer, removeServer, updateServer, isLocal, permissions, getKeyField, getAlternateKeyField, hasLookupResource]
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
};
