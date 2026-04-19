/**
 * Certification config storage service.
 *
 * Each config is stored as a separate JSON file under:
 *   .reso-cert/configs/{providerUoi}-{providerUsi}/{recipientUoi}/config.json
 *
 * For non-cert connections (no UOIs):
 *   .reso-cert/configs/_connections/{name-slug}/config.json
 *
 * Credentials (tokens, client secrets) are stored separately in
 * Electron's safeStorage, keyed by config path. Config files on
 * disk contain everything except secrets.
 */

/** Saved connection/config shape. */
export interface SavedConnection {
  /** Unique ID — derived from the file path. */
  readonly id: string;
  /** Human-friendly name. */
  readonly name: string;
  /** Server URL. */
  readonly url: string;
  /** Auth mode. */
  readonly authMode: 'token' | 'client_credentials';
  /** Client ID (for client_credentials). */
  readonly clientId?: string;
  /** Token URL (for client_credentials). */
  readonly tokenUrl?: string;
  /** OAuth2 scope (for client_credentials). */
  readonly scope?: string;
  /** Provider UOI (cert only). */
  readonly providerUoi?: string;
  /** Provider USI (cert only). */
  readonly providerUsi?: string;
  /** Recipient UOI (cert only). */
  readonly recipientUoi?: string;
  /** Provider name (resolved from org directory). */
  readonly providerName?: string;
  /** Recipient name (resolved from org directory). */
  readonly recipientName?: string;
  /** System name (resolved from org directory). */
  readonly systemName?: string;
  /** Description / notes. */
  readonly description?: string;
  /** Cert endorsement options (DD version, limits, etc.). */
  readonly certOptions?: Readonly<Record<string, unknown>>;
  /** When the config was created. */
  readonly createdAt: string;
  /** When the config was last modified. */
  readonly updatedAt: string;
  /** When the config was last used. */
  readonly lastUsedAt?: string;
  /** Whether this is a cert config (has provider/recipient) or just a connection. */
  readonly isCert: boolean;
}

/** What gets written to disk (no secrets). */
export type SavedConnectionOnDisk = Omit<SavedConnection, 'id'>;

/** Credentials stored in safeStorage, keyed by connection ID. */
export interface StoredCredentials {
  readonly authToken?: string;
  readonly clientSecret?: string;
}

interface ElectronStorage {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

const getStorage = (): ElectronStorage | null =>
  (window as unknown as Record<string, unknown>).electronStorage as ElectronStorage | null;

const CRED_PREFIX = 'cert-cred:';

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

/** Remove credentials for a connection from safeStorage. */
export const removeCredentials = async (connectionId: string): Promise<void> => {
  const storage = getStorage();
  if (!storage) return;
  await storage.remove(`${CRED_PREFIX}${connectionId}`);
};

/** Mask a secret for display — show last 4 chars. */
export const maskSecret = (secret: string): string =>
  secret.length > 4 ? `${'•'.repeat(Math.min(8, secret.length - 4))}${secret.slice(-4)}` : '••••';

/** Security warning for unencrypted storage. */
export const CREDENTIALS_WARNING = 'Credentials are stored on your local filesystem using OS-level encryption when available. For best security, use Import/Export to transfer configs between machines \u2014 credentials stay under your control.';
