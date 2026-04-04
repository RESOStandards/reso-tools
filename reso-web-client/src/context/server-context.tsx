import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getCachedSchema, setCachedSchema } from '../api/schema-cache';

/** Per-operation permissions for a server connection. */
export interface ServerPermissions {
  readonly canAdd: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export type AuthMode = 'token' | 'client_credentials';

/** Server connection configuration. */
export interface ServerConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly authMode?: AuthMode;
  readonly token?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
  readonly scope?: string;
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
const SECRETS_KEY = 'reso-server-secrets';
const ACTIVE_KEY = 'reso-active-server';

const SECRET_FIELDS = ['token', 'clientSecret'] as const;
const TOKENS_KEY = 'reso-server-tokens';

/** Persist the token map. Electron uses secure storage, browser uses sessionStorage. */
const persistTokens = async (tokens: Readonly<Record<string, string>>): Promise<void> => {
  const json = JSON.stringify(tokens);
  if (isElectron()) {
    await electronStorage().set(TOKENS_KEY, json);
  } else {
    sessionStorage.setItem(TOKENS_KEY, json);
  }
};

/** Load the persisted token map. */
const loadPersistedTokens = async (): Promise<Readonly<Record<string, string>>> => {
  try {
    const raw = isElectron()
      ? await electronStorage().get(TOKENS_KEY)
      : sessionStorage.getItem(TOKENS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
};

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

/** Strip secret fields from a config for non-secure storage. */
const stripSecrets = (config: ServerConfig): ServerConfig => {
  const { token: _t, clientSecret: _s, ...rest } = config;
  return rest as ServerConfig;
};

/** Load saved external server configs (async — works with both Electron and localStorage). */
const loadSavedConfigs = async (): Promise<ReadonlyArray<ServerConfig>> => {
  try {
    const raw = isElectron()
      ? await electronStorage().get(STORAGE_KEY)
      : localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const configs = parsed as ReadonlyArray<ServerConfig>;

    // In the browser, secrets are in sessionStorage; in Electron, they're in the full config
    if (isElectron()) return configs;

    // Merge secrets from sessionStorage
    const secretsRaw = sessionStorage.getItem(SECRETS_KEY);
    if (!secretsRaw) return configs;
    const secrets = JSON.parse(secretsRaw) as Record<string, Record<string, string>>;
    return configs.map(c => {
      const s = secrets[c.id];
      return s ? { ...c, ...s } : c;
    });
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

/** Save external server configs (async). Secrets go to sessionStorage in the browser. */
const persistConfigs = async (configs: ReadonlyArray<ServerConfig>): Promise<void> => {
  if (isElectron()) {
    // Electron: store everything in secure storage
    await electronStorage().set(STORAGE_KEY, JSON.stringify(configs));
  } else {
    // Browser: non-sensitive config in localStorage, secrets in sessionStorage
    const safeConfigs = configs.map(stripSecrets);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeConfigs));

    const secrets: Record<string, Record<string, string>> = {};
    for (const config of configs) {
      const s: Record<string, string> = {};
      for (const field of SECRET_FIELDS) {
        const val = config[field];
        if (val) s[field] = val;
      }
      if (Object.keys(s).length > 0) secrets[config.id] = s;
    }
    sessionStorage.setItem(SECRETS_KEY, JSON.stringify(secrets));
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
  /** Human-readable loading step (e.g., "Fetching token...", "Loading metadata..."). */
  readonly loadingStatus: string | null;
  /** Error from metadata loading, if any. */
  readonly resourceError: string | null;
  /** The request URL that caused the resource error (proxy unpacked for display). */
  readonly resourceErrorUrl: string | null;
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
  /** Whether a proxy backend is available (required for external servers and Client Credentials). */
  readonly hasProxy: boolean;
  /** Resolved permissions for the active server. */
  readonly permissions: ServerPermissions;
  /** Get the key field name for a resource (discovered from $metadata). */
  readonly getKeyField: (resource: string) => string;
  /** Get the human-friendly alternate key field for a resource, if one exists. */
  readonly getAlternateKeyField: (resource: string) => string | undefined;
  /** Whether the server has a Lookup entity set (for Lookup Resource enum fields). */
  readonly hasLookupResource: boolean;
  /** The current access token for the active server (static bearer or fetched via Client Credentials). */
  readonly currentToken: string | null;
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

/** Check whether a proxy backend is available by probing /health. */
const checkProxyAvailable = async (): Promise<boolean> => {
  try {
    const res = await fetch('/health', { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * Fetch an OAuth2 access token via Client Credentials, routing through the proxy to avoid CORS.
 * Mirrors the grant logic in reso-client's fetchAccessToken but sends through /api/proxy.
 */
const fetchTokenViaProxy = async (config: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl: string;
  readonly scope?: string;
}, signal?: AbortSignal): Promise<string> => {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (config.scope) params.set('scope', config.scope);

  const proxyUrl = `/api/proxy?url=${encodeURIComponent(config.tokenUrl)}`;
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
    cache: 'no-store',
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token request failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }

  const json = await res.json() as Record<string, unknown>;
  const accessToken = json.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Token response missing or empty access_token');
  }
  return accessToken;
};

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
  const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [resourceErrorUrl, setResourceErrorUrl] = useState<string | null>(null);
  const [hasProxy, setHasProxy] = useState(false);
  const [serverTokens, setServerTokens] = useState<Readonly<Record<string, string>>>({});

  /** Set the token for a specific server and persist the map. */
  const setTokenForServer = useCallback((serverId: string, token: string) => {
    setServerTokens(prev => {
      const next = { ...prev, [serverId]: token };
      persistTokens(next).catch(() => {});
      return next;
    });
  }, []);

  // Hydrate persisted tokens on mount
  useEffect(() => {
    let cancelled = false;
    loadPersistedTokens().then(tokens => {
      if (!cancelled && Object.keys(tokens).length > 0) setServerTokens(tokens);
    });
    return () => { cancelled = true; };
  }, []);

  // Detect whether a proxy backend is available (reference server running)
  useEffect(() => {
    let cancelled = false;
    checkProxyAvailable().then(available => {
      if (!cancelled) setHasProxy(available);
    });
    return () => { cancelled = true; };
  }, []);

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
        if (Array.isArray(parsed)) {
          const configs = parsed as ReadonlyArray<ServerConfig>;
          // Merge secrets from sessionStorage (clientSecret, token are stripped from localStorage)
          const secretsRaw = sessionStorage.getItem(SECRETS_KEY);
          const secrets = secretsRaw
            ? JSON.parse(secretsRaw) as Record<string, Record<string, string>>
            : {};
          const merged = configs.map(c => {
            const s = secrets[c.id];
            return s ? { ...c, ...s } : c;
          });
          setExternalConfigs(merged);
        }
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

  /** The current access token for the active server — from the token map or the static bearer token. */
  const currentToken = serverTokens[activeServer.id] ?? activeServer.token ?? null;

  // Fetch $metadata to discover resources and keys (wait for storage hydration)
  useEffect(() => {
    if (!storageReady) return;
    const controller = new AbortController();

    setIsLoadingResources(true);
    setResourceError(null);
    setResourceErrorUrl(null);
    setResources(null);
    setLoadingStatus('Connecting...');

    let lastRequestUrl: string | null = null;
    const loadMetadata = async () => {
      try {
        const { parseCsdlXml, discoverResources } = await import('@reso-standards/reso-client');
        const cacheKey = activeServer.baseUrl || '__local__';

        // Check IndexedDB cache first
        const cachedSchema = await getCachedSchema<ReturnType<typeof parseCsdlXml>>(cacheKey);
        if (cachedSchema && !controller.signal.aborted) {
          setLoadingStatus('Loading cached metadata...');

          // Still need to fetch token for data requests even when schema is cached
          if (activeServer.authMode === 'client_credentials' && activeServer.clientId && activeServer.clientSecret && activeServer.tokenUrl) {
            setLoadingStatus('Fetching access token...');
            const accessToken = await fetchTokenViaProxy({
              clientId: activeServer.clientId,
              clientSecret: activeServer.clientSecret,
              tokenUrl: activeServer.tokenUrl,
              scope: activeServer.scope,
            }, controller.signal);
            if (!controller.signal.aborted) setTokenForServer(activeServer.id, accessToken);
          } else if (activeServer.token) {
            if (!controller.signal.aborted && activeServer.token) setTokenForServer(activeServer.id, activeServer.token);
          }

          const discovered = discoverResources(cachedSchema);
          if (!controller.signal.aborted) {
            setResources(discovered);
            setLoadingStatus(null);
          }
          return;
        }

        // No cache — fetch from network
        const headers: Record<string, string> = { Accept: 'application/xml' };
        if (activeServer.authMode === 'client_credentials' && activeServer.clientId && activeServer.clientSecret && activeServer.tokenUrl) {
          setLoadingStatus('Fetching access token...');
          const accessToken = await fetchTokenViaProxy({
            clientId: activeServer.clientId,
            clientSecret: activeServer.clientSecret,
            tokenUrl: activeServer.tokenUrl,
            scope: activeServer.scope,
          }, controller.signal);
          if (!controller.signal.aborted) setTokenForServer(activeServer.id, accessToken);
          headers['Authorization'] = `Bearer ${accessToken}`;
        } else if (activeServer.token) {
          if (!controller.signal.aborted) setTokenForServer(activeServer.id, activeServer.token);
          headers['Authorization'] = `Bearer ${activeServer.token}`;
        }

        setLoadingStatus('Loading metadata...');
        const metadataUrl = resolveMetadataUrl(activeServer.baseUrl);
        lastRequestUrl = metadataUrl;
        const needsCacheBust = metadataUrl.startsWith('/api/proxy');
        const res = await fetch(metadataUrl, {
          headers,
          signal: controller.signal,
          ...(needsCacheBust ? { cache: 'no-store' as const } : {})
        });
        if (!res.ok) throw new Error(`Failed to fetch metadata: ${res.status} ${res.statusText}`);

        setLoadingStatus('Parsing metadata...');
        const xml = await res.text();
        const schema = parseCsdlXml(xml);
        const discovered = discoverResources(schema);

        // Persist to IndexedDB for future sessions
        setCachedSchema(cacheKey, schema).catch(() => {});

        if (!controller.signal.aborted) {
          setResources(discovered);
          setLoadingStatus(null);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setResourceError(err instanceof Error ? err.message : 'Failed to load server metadata');
          setResourceErrorUrl(lastRequestUrl);
          setLoadingStatus(null);
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
      loadingStatus,
      resourceError,
      resourceErrorUrl,
      switchServer,
      addServer,
      removeServer,
      updateServer,
      isLocal,
      hasProxy,
      permissions,
      getKeyField,
      getAlternateKeyField,
      hasLookupResource,
      currentToken
    }),
    [activeServer, servers, resources, isLoadingResources, loadingStatus, resourceError, resourceErrorUrl, switchServer, addServer, removeServer, updateServer, isLocal, hasProxy, permissions, getKeyField, getAlternateKeyField, hasLookupResource, currentToken]
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
};
