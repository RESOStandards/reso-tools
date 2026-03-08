import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** Server connection configuration. */
export interface ServerConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly token?: string;
  readonly type: 'local' | 'external';
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

/** Load saved external server configs from localStorage. */
const loadSavedConfigs = (): ReadonlyArray<ServerConfig> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ReadonlyArray<ServerConfig>;
  } catch {
    return [];
  }
};

/** Load the active server ID from localStorage. */
const loadActiveServerId = (): string => {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? 'local';
  } catch {
    return 'local';
  }
};

/** Save external server configs to localStorage. */
const persistConfigs = (configs: ReadonlyArray<ServerConfig>): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
};

/** Save the active server ID to localStorage. */
const persistActiveServer = (id: string): void => {
  localStorage.setItem(ACTIVE_KEY, id);
};

/** Dynamic resource info discovered from a server's metadata. */
export interface ResourceInfo {
  readonly name: string;
  readonly entityType: string;
  readonly keyField: string;
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
  /** Get the key field name for a resource. */
  readonly getKeyField: (resource: string) => string;
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

/** Provider that manages server connections and exposes them via context. */
export const ServerProvider = ({ children }: ServerProviderProps) => {
  const [externalConfigs, setExternalConfigs] = useState<ReadonlyArray<ServerConfig>>(loadSavedConfigs);
  const [activeServerId, setActiveServerId] = useState<string>(loadActiveServerId);
  const [resources, setResources] = useState<ReadonlyArray<ResourceInfo> | null>(null);
  const [isLoadingResources, setIsLoadingResources] = useState(false);
  const [resourceError, setResourceError] = useState<string | null>(null);

  const servers = useMemo(() => [LOCAL_SERVER, ...externalConfigs], [externalConfigs]);

  const activeServer = useMemo(
    () => servers.find(s => s.id === activeServerId) ?? LOCAL_SERVER,
    [servers, activeServerId]
  );

  const isLocal = activeServer.type === 'local';

  // Load resources when active server changes
  useEffect(() => {
    if (isLocal) {
      // Local server uses hardcoded resources — set to null to signal "use defaults"
      setResources(null);
      setResourceError(null);
      return;
    }

    const controller = new AbortController();
    setIsLoadingResources(true);
    setResourceError(null);
    setResources(null);

    const loadMetadata = async () => {
      try {
        const { parseCsdlXml } = await import('@reso/odata-client');

        const headers: Record<string, string> = {
          Accept: 'application/xml'
        };
        if (activeServer.token) {
          headers['Authorization'] = `Bearer ${activeServer.token}`;
        }

        const rawUrl = `${activeServer.baseUrl}/$metadata?$format=application/xml`;
        const isLocalhost = (() => {
          try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(rawUrl).hostname); }
          catch { return false; }
        })();
        const metadataUrl = isLocalhost ? rawUrl : `/api/proxy?url=${encodeURIComponent(rawUrl)}`;
        const res = await fetch(metadataUrl, { headers, signal: controller.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`Failed to fetch metadata: ${res.status} ${res.statusText}`);

        const xml = await res.text();
        const schema = parseCsdlXml(xml);

        if (!schema.entityContainer) {
          throw new Error('No EntityContainer found in metadata');
        }

        const entityTypeMap = new Map(schema.entityTypes.map(et => [et.name, et]));

        const discovered: ReadonlyArray<ResourceInfo> = schema.entityContainer.entitySets.map(es => {
          // entityType is fully qualified, e.g. "org.reso.metadata.Property"
          const typeName = es.entityType.includes('.') ? es.entityType.split('.').pop()! : es.entityType;
          const et = entityTypeMap.get(typeName);
          const keyField = et?.key[0] ?? `${typeName}Key`;
          return { name: es.name, entityType: es.entityType, keyField };
        });

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
  }, [activeServer, isLocal]);

  const switchServer = useCallback((id: string) => {
    setActiveServerId(id);
    persistActiveServer(id);
  }, []);

  const addServer = useCallback((config: Omit<ServerConfig, 'id' | 'type'>): string => {
    const id = generateId();
    const newConfig: ServerConfig = { ...config, id, type: 'external' };
    setExternalConfigs(prev => {
      const updated = [...prev, newConfig];
      persistConfigs(updated);
      return updated;
    });
    return id;
  }, []);

  const removeServer = useCallback((id: string) => {
    if (id === 'local') return;
    setExternalConfigs(prev => {
      const updated = prev.filter(c => c.id !== id);
      persistConfigs(updated);
      return updated;
    });
    // If removing the active server, switch back to local
    setActiveServerId(prev => (prev === id ? 'local' : prev));
  }, []);

  const updateServer = useCallback((id: string, updates: Partial<Omit<ServerConfig, 'id' | 'type'>>) => {
    if (id === 'local') return;
    setExternalConfigs(prev => {
      const updated = prev.map(c => (c.id === id ? { ...c, ...updates } : c));
      persistConfigs(updated);
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
      getKeyField
    }),
    [activeServer, servers, resources, isLoadingResources, resourceError, switchServer, addServer, removeServer, updateServer, isLocal, getKeyField]
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
};
