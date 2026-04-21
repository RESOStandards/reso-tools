/**
 * Connection Manager — unified storage for server connections and cert profiles.
 *
 * Two distinct data shapes:
 *   - SavedConnection: server URL + auth credentials (secrets in safeStorage)
 *   - CertProfile: endorsement-specific test config, optionally linked to a connection
 *
 * Connections are identified by composite key:
 *   - client_credentials: serverUrl + clientId
 *   - token: serverUrl + originatingSystemName
 *
 * Storage layout:
 *   - Connections: 'connections' key in electronStorage (JSON array, no secrets)
 *   - Credentials: 'conn-cred:{id}' keys in electronStorage (safeStorage-encrypted)
 *   - Cert Profiles: 'cert-profiles' key in electronStorage (JSON array)
 *   - MRU order: 'connections-mru' key in electronStorage (JSON array of IDs)
 */

// ── Types ────────────────────────────────────────────────────────────

/**
 * SavedCredentials — server connection identity + auth config.
 * Credentials (tokens, secrets) are stored separately in safeStorage.
 * Used by both cert and non-cert users.
 */
export interface SavedCredentials {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly authMode: 'token' | 'client_credentials';
  readonly clientId?: string;
  readonly tokenUrl?: string;
  readonly scope?: string;
  readonly originatingSystemName?: string;
  readonly originatingSystemId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
}

/** Backward compatibility alias. */
export type SavedConnection = SavedCredentials;

/** Credentials stored in safeStorage, keyed by credentials ID. */
export interface StoredCredentials {
  readonly authToken?: string;
  readonly clientSecret?: string;
}

/**
 * SavedCertConfig — endorsement test configuration for one recipient.
 * Optionally linked to a SavedCredentials by ID.
 * One config = one recipient. Importing a batch of N creates N configs.
 */
export interface SavedCertConfig {
  readonly id: string;
  readonly name: string;
  readonly credentialsId: string | null;
  readonly providerUoi: string;
  readonly providerUsi?: string;
  readonly recipientUoi: string;
  readonly providerName?: string;
  readonly recipientName?: string;
  readonly systemName?: string;
  readonly endorsements: ReadonlyArray<string>;
  readonly ddVersion?: string;
  readonly limit?: number;
  readonly strictMode?: boolean;
  readonly requestDelay?: number;
  readonly rateLimitWait?: number;
  readonly batchExpand?: boolean;
  readonly localPath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunAt?: string;
}

/** Backward compatibility alias. */
export type CertProfile = SavedCertConfig;

// ── Storage layer ────────────────────────────────────────────────────

interface ElectronStorage {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

const getStorage = (): ElectronStorage | null =>
  (window as unknown as Record<string, unknown>).electronStorage as ElectronStorage | null;

const CONNECTIONS_KEY = 'connections';
const PROFILES_KEY = 'cert-profiles';
const MRU_KEY = 'connections-mru';
const CRED_PREFIX = 'conn-cred:';

const readJSON = async <T>(key: string): Promise<T | null> => {
  const storage = getStorage();
  if (!storage) return null;
  const raw = await storage.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; }
  catch { return null; }
};

const writeJSON = async (key: string, value: unknown): Promise<void> => {
  const storage = getStorage();
  if (!storage) return;
  await storage.set(key, JSON.stringify(value));
};

// ── Connection CRUD ──────────────────────────────────────────────────

/** Load all saved connections. */
export const loadConnections = async (): Promise<ReadonlyArray<SavedConnection>> =>
  (await readJSON<ReadonlyArray<SavedConnection>>(CONNECTIONS_KEY)) ?? [];

/** Save a new connection or update an existing one. Returns the saved connection. */
export const saveConnection = async (conn: Omit<SavedConnection, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<SavedConnection> => {
  const connections = [...await loadConnections()];
  const now = new Date().toISOString();

  if (conn.id) {
    const idx = connections.findIndex(c => c.id === conn.id);
    if (idx >= 0) {
      const updated = { ...connections[idx], ...conn, updatedAt: now };
      connections[idx] = updated;
      await writeJSON(CONNECTIONS_KEY, connections);
      return updated;
    }
  }

  const newConn: SavedConnection = {
    ...conn,
    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
  };
  await writeJSON(CONNECTIONS_KEY, [...connections, newConn]);
  return newConn;
};

/** Delete a connection by ID. Returns IDs of orphaned cert profiles. */
export const deleteConnection = async (id: string): Promise<ReadonlyArray<string>> => {
  const connections = await loadConnections();
  await writeJSON(CONNECTIONS_KEY, connections.filter(c => c.id !== id));
  await removeCredentials(id);

  // Orphan any cert profiles that referenced this connection
  const profiles = [...await loadProfiles()];
  const orphanedIds: string[] = [];
  const updated = profiles.map(p => {
    if (p.credentialsId === id) {
      orphanedIds.push(p.id);
      return { ...p, credentialsId: null, updatedAt: new Date().toISOString() };
    }
    return p;
  });
  if (orphanedIds.length > 0) {
    await writeJSON(PROFILES_KEY, updated);
  }

  // Remove from MRU
  const mru = await loadMRU();
  await writeJSON(MRU_KEY, mru.filter(mid => mid !== id));

  return orphanedIds;
};

/** Find a connection by composite key (for deduplication on import). */
export const findConnectionByKey = async (
  url: string,
  authMode: 'token' | 'client_credentials',
  clientId?: string,
  originatingSystemName?: string
): Promise<SavedConnection | undefined> => {
  const connections = await loadConnections();
  return connections.find(c => {
    if (c.url !== url) return false;
    if (authMode === 'client_credentials') return c.authMode === 'client_credentials' && c.clientId === clientId;
    return c.authMode === 'token' && c.originatingSystemName === originatingSystemName;
  });
};

// ── Credential CRUD ──────────────────────────────────────────────────

/** Store credentials for a connection in safeStorage. */
export const storeCredentials = async (connectionId: string, creds: StoredCredentials): Promise<void> => {
  const storage = getStorage();
  if (!storage) return;
  await storage.set(`${CRED_PREFIX}${connectionId}`, JSON.stringify(creds));
};

/** Retrieve credentials for a connection from safeStorage. */
export const getCredentials = async (connectionId: string): Promise<StoredCredentials | null> => {
  const storage = getStorage();
  if (!storage) return null;
  const raw = await storage.get(`${CRED_PREFIX}${connectionId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredCredentials; }
  catch { return null; }
};

/** Remove credentials for a connection from safeStorage (clear without deleting connection). */
export const removeCredentials = async (connectionId: string): Promise<void> => {
  const storage = getStorage();
  if (!storage) return;
  await storage.remove(`${CRED_PREFIX}${connectionId}`);
};

/** Check whether a connection has stored credentials. */
export const hasCredentials = async (connectionId: string): Promise<boolean> => {
  const creds = await getCredentials(connectionId);
  return creds !== null && (!!creds.authToken || !!creds.clientSecret);
};

// ── Cert Profile CRUD ────────────────────────────────────────────────

/** Load all cert profiles. */
export const loadProfiles = async (): Promise<ReadonlyArray<CertProfile>> =>
  (await readJSON<ReadonlyArray<CertProfile>>(PROFILES_KEY)) ?? [];

/** Save a new cert profile or update an existing one. */
export const saveProfile = async (profile: Omit<CertProfile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<CertProfile> => {
  const profiles = [...await loadProfiles()];
  const now = new Date().toISOString();

  if (profile.id) {
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      const updated = { ...profiles[idx], ...profile, updatedAt: now };
      profiles[idx] = updated;
      await writeJSON(PROFILES_KEY, profiles);
      return updated;
    }
  }

  const newProfile: CertProfile = {
    ...profile,
    id: `prof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
  };
  await writeJSON(PROFILES_KEY, [...profiles, newProfile]);
  return newProfile;
};

/** Delete a cert profile by ID. */
export const deleteProfile = async (id: string): Promise<void> => {
  const profiles = await loadProfiles();
  await writeJSON(PROFILES_KEY, profiles.filter(p => p.id !== id));
};

/** Find cert configs linked to a given credentials entry. */
export const profilesForConnection = async (connectionId: string): Promise<ReadonlyArray<SavedCertConfig>> => {
  const profiles = await loadProfiles();
  return profiles.filter(p => p.credentialsId === connectionId);
};

/** Find orphaned cert configs (no linked credentials). */
export const orphanedProfiles = async (): Promise<ReadonlyArray<SavedCertConfig>> => {
  const profiles = await loadProfiles();
  return profiles.filter(p => p.credentialsId === null);
};

// ── MRU ──────────────────────────────────────────────────────────────

/** Load MRU order (most recent first). */
export const loadMRU = async (): Promise<ReadonlyArray<string>> =>
  (await readJSON<ReadonlyArray<string>>(MRU_KEY)) ?? [];

/** Push a connection to the top of the MRU list. */
export const touchMRU = async (connectionId: string): Promise<void> => {
  const mru = await loadMRU();
  const updated = [connectionId, ...mru.filter(id => id !== connectionId)];
  await writeJSON(MRU_KEY, updated);

  // Also update lastUsedAt on the connection
  const connections = [...await loadConnections()];
  const idx = connections.findIndex(c => c.id === connectionId);
  if (idx >= 0) {
    connections[idx] = { ...connections[idx], lastUsedAt: new Date().toISOString() };
    await writeJSON(CONNECTIONS_KEY, connections);
  }
};

/** Load connections sorted by MRU order. */
export const loadConnectionsMRU = async (): Promise<ReadonlyArray<SavedConnection>> => {
  const [connections, mru] = await Promise.all([loadConnections(), loadMRU()]);
  const mruIndex = new Map(mru.map((id, i) => [id, i]));
  return [...connections].sort((a, b) => {
    const ai = mruIndex.get(a.id) ?? Infinity;
    const bi = mruIndex.get(b.id) ?? Infinity;
    return ai - bi;
  });
};

// ── Search ───────────────────────────────────────────────────────────

/** Filter connections by search query (matches name, url, originatingSystemName). */
export const searchConnections = (connections: ReadonlyArray<SavedConnection>, query: string): ReadonlyArray<SavedConnection> => {
  if (!query.trim()) return connections;
  const lower = query.toLowerCase();
  return connections.filter(c =>
    c.name.toLowerCase().includes(lower) ||
    c.url.toLowerCase().includes(lower) ||
    (c.originatingSystemName?.toLowerCase().includes(lower) ?? false)
  );
};

// ── Utilities ────────────────────────────────────────────────────────

/** Mask a secret for display — show last 4 chars. */
export const maskSecret = (secret: string): string =>
  secret.length > 4 ? `${'•'.repeat(Math.min(8, secret.length - 4))}${secret.slice(-4)}` : '••••';

/** Generate a stable composite key for a connection (for dedup matching). */
export const connectionKey = (conn: Pick<SavedConnection, 'url' | 'authMode' | 'clientId' | 'originatingSystemName'>): string =>
  conn.authMode === 'client_credentials'
    ? `${conn.url}::${conn.clientId ?? ''}`
    : `${conn.url}::${conn.originatingSystemName ?? ''}`;

// ── Config Builder Draft ────────────────────────────────────────────

const DRAFT_KEY = 'config-builder-draft';

export interface ConfigDraft {
  readonly config: unknown;
  readonly configId: string | null;
  readonly configName: string | null;
  readonly savedAt: string;
}

/** Save config builder draft (one per user, overwrites previous). */
export const saveDraft = async (draft: Omit<ConfigDraft, 'savedAt'>): Promise<void> => {
  await writeJSON(DRAFT_KEY, { ...draft, savedAt: new Date().toISOString() });
};

/** Load config builder draft, if any. */
export const loadDraft = async (): Promise<ConfigDraft | null> =>
  readJSON<ConfigDraft>(DRAFT_KEY);

/** Clear config builder draft. */
export const clearDraft = async (): Promise<void> => {
  const storage = getStorage();
  if (storage) await storage.remove(DRAFT_KEY);
};
