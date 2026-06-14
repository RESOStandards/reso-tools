/**
 * Config Import — normalizes batch config formats into individual
 * SavedCredentials + SavedCertConfig entries.
 *
 * Handles:
 * - Legacy format: { providerUoi, configs: [{ serviceRootUri, token, ... }] }
 * - New format: { providerUoi, recipients: [{ serviceRootUri, auth, ... }] }
 * - Single config: { serviceRootUri, auth, ... }
 *
 * For each recipient entry:
 * 1. Creates or reuses a SavedCredentials (deduped by composite key)
 * 2. Creates a SavedCertConfig linked to the credentials
 * 3. Stores auth tokens/secrets in safeStorage
 * 4. Auto-generates a name if none provided
 */

import {
  saveConnection,
  saveProfile,
  storeCredentials,
  findConnectionByKey,
  loadProfiles,
  type SavedCredentials,
  type SavedCertConfig,
} from './connection-manager';
import { toDDVersionShort } from '../constants/cert';

// ── Types ────────────────────────────────────────────────────────────

/** A single recipient entry from a batch config (either format). */
interface RecipientEntry {
  readonly serviceRootUri?: string;
  readonly recipientUoi?: string;
  readonly providerUsi?: string;
  readonly token?: string;
  readonly auth?: {
    readonly mode: 'token' | 'client_credentials';
    readonly authToken?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly tokenUrl?: string;
    readonly scope?: string;
  };
  readonly endorsements?: ReadonlyArray<string>;
  readonly ddOptions?: { readonly version?: string; readonly strictMode?: boolean; readonly limit?: number; readonly requestDelay?: number; readonly rateLimitWait?: number; readonly batchExpand?: boolean };
  readonly description?: string;
  readonly originatingSystemName?: string;
}

/** Result of an import operation. */
export interface ImportResult {
  readonly credentialsCreated: number;
  readonly credentialsReused: number;
  readonly configsCreated: number;
  readonly configsSkipped: number;
  readonly errors: ReadonlyArray<string>;
}

// ── Name generation ──────────────────────────────────────────────────

/** Generate a human-friendly name for a cert config. */
const generateConfigName = (
  providerUoi: string,
  recipientUoi: string,
  endorsements: ReadonlyArray<string>,
  providerName?: string,
  recipientName?: string
): string => {
  const provider = providerName ?? providerUoi;
  const recipient = recipientName ?? recipientUoi;
  const endorsement = endorsements.length > 0
    ? endorsements.map(e => e === 'dd' ? 'DD' : e === 'core' ? 'Core' : e).join(', ')
    : 'DD';
  return `${provider} – ${recipient} – ${endorsement}`;
};

// ── Collision detection ──────────────────────────────────────────────

/** Check if a cert config with this tuple already exists. */
const findExistingConfig = async (
  providerUoi: string,
  providerUsi: string,
  recipientUoi: string
): Promise<SavedCertConfig | undefined> => {
  const profiles = await loadProfiles();
  return profiles.find(p =>
    p.providerUoi === providerUoi &&
    p.providerUsi === providerUsi &&
    p.recipientUoi === recipientUoi
  );
};

// ── Import ───────────────────────────────────────────────────────────

/**
 * Import a raw config (any format) and create SavedCredentials + SavedCertConfig entries.
 *
 * @param raw - the parsed JSON from an imported file
 * @param orgLookup - optional function to resolve UOI to org name
 * @returns import result with counts and errors
 */
export const importConfig = async (
  raw: Record<string, unknown>,
  orgLookup?: (uoi: string) => string | undefined
): Promise<ImportResult> => {
  const errors: string[] = [];
  let credentialsCreated = 0;
  let credentialsReused = 0;
  let configsCreated = 0;
  let configsSkipped = 0;

  // Normalize to a list of recipient entries
  const providerUoi = (raw.providerUoi as string) ?? '';
  const providerName = orgLookup?.(providerUoi);

  let entries: ReadonlyArray<RecipientEntry>;

  if (raw.configs && Array.isArray(raw.configs)) {
    // Legacy format: { providerUoi, configs: [...] }
    entries = raw.configs as ReadonlyArray<RecipientEntry>;
  } else if (raw.recipients && Array.isArray(raw.recipients)) {
    // New format: { providerUoi, recipients: [...] }
    entries = raw.recipients as ReadonlyArray<RecipientEntry>;
  } else if (raw.serviceRootUri || raw.recipientUoi) {
    // Single config
    entries = [raw as RecipientEntry];
  } else {
    return { credentialsCreated: 0, credentialsReused: 0, configsCreated: 0, configsSkipped: 0, errors: ['Unrecognized config format'] };
  }

  for (const entry of entries) {
    try {
      const serverUrl = entry.serviceRootUri ?? '';
      const recipientUoi = entry.recipientUoi ?? '';
      const providerUsi = entry.providerUsi ?? '';

      if (!serverUrl && !recipientUoi) {
        errors.push('Entry skipped: no server URL or recipient UOI');
        configsSkipped++;
        continue;
      }

      // Determine auth
      const authMode = entry.auth?.mode ?? (entry.token ? 'token' : 'token');
      const authToken = entry.auth?.authToken ?? entry.token ?? '';
      const clientId = entry.auth?.clientId ?? '';
      const clientSecret = entry.auth?.clientSecret ?? '';
      const tokenUrl = entry.auth?.tokenUrl ?? '';
      const scope = entry.auth?.scope ?? '';

      // Find or create SavedCredentials
      let credentials: SavedCredentials;
      const existingCreds = serverUrl ? await findConnectionByKey(
        serverUrl,
        authMode as 'token' | 'client_credentials',
        authMode === 'client_credentials' ? clientId : undefined,
        authMode === 'token' ? (entry.originatingSystemName ?? entry.description) : undefined
      ) : undefined;

      if (existingCreds) {
        credentials = existingCreds;
        credentialsReused++;
      } else if (serverUrl) {
        credentials = await saveConnection({
          name: entry.description ?? serverUrl,
          url: serverUrl,
          authMode: authMode as 'token' | 'client_credentials',
          clientId: authMode === 'client_credentials' ? clientId : undefined,
          tokenUrl: authMode === 'client_credentials' ? tokenUrl : undefined,
          scope: authMode === 'client_credentials' ? scope : undefined,
          originatingSystemName: entry.originatingSystemName,
        });
        credentialsCreated++;
      } else {
        // No server URL — create config without credentials link
        credentials = { id: '', name: '', url: '', authMode: 'token', createdAt: '', updatedAt: '' };
      }

      // Store auth secrets in safeStorage
      if (credentials.id && (authToken || clientSecret)) {
        await storeCredentials(credentials.id, {
          ...(authToken ? { authToken } : {}),
          ...(clientSecret ? { clientSecret } : {}),
        });
      }

      // Check for collision
      const existing = await findExistingConfig(providerUoi, providerUsi, recipientUoi);
      const recipientName = orgLookup?.(recipientUoi);

      const endorsements = entry.endorsements ?? ['dd'];
      const name = existing
        ? generateConfigName(providerUoi, recipientUoi, endorsements, providerName, recipientName) + ` (${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})`
        : generateConfigName(providerUoi, recipientUoi, endorsements, providerName, recipientName);

      // Create SavedCertConfig
      await saveProfile({
        name,
        credentialsId: credentials.id || null,
        providerUoi,
        providerUsi,
        recipientUoi,
        providerName,
        recipientName,
        endorsements: [...endorsements],
        ddVersion: toDDVersionShort(entry.ddOptions?.version ?? '2.1'),
        limit: entry.ddOptions?.limit,
        strictMode: entry.ddOptions?.strictMode ?? true,
        requestDelay: entry.ddOptions?.requestDelay,
        rateLimitWait: entry.ddOptions?.rateLimitWait,
        batchExpand: entry.ddOptions?.batchExpand,
      });

      configsCreated++;
    } catch (err) {
      errors.push(`Error importing entry: ${err instanceof Error ? err.message : String(err)}`);
      configsSkipped++;
    }
  }

  return { credentialsCreated, credentialsReused, configsCreated, configsSkipped, errors };
};

/** Read a JSON file from disk via file input. */
export const readConfigFile = (): Promise<Record<string, unknown> | null> =>
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
