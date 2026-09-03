import { readFile } from 'node:fs/promises';
import type { AuthConfig } from '../test-runner/types.js';
import type { AddEditConfig, EntityEventConfig, CoreConfig, DDConfig } from './types.js';
import { coerceDDVersion } from './dd-versions.js';

// ── Config File Types ──

/** Auth section in a config file entry. */
interface ConfigAuth {
  readonly token?: string;
  readonly clientCredentials?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly tokenUri: string;
    readonly scope?: string;
  };
}

/** Inline payloads for Add/Edit config. */
interface ConfigPayloads {
  readonly createSucceeds?: Record<string, unknown>;
  readonly createFails?: Record<string, unknown>;
  readonly updateSucceeds?: Record<string, unknown>;
  readonly updateFails?: Record<string, unknown>;
  readonly deleteSucceeds?: Record<string, unknown>;
  readonly deleteFails?: Record<string, unknown>;
}

/** A single config entry (one recipient/system combination). */
interface ConfigEntry extends ConfigAuth {
  readonly description?: string;
  readonly serviceRootUri: string;
  readonly recipientUoi: string;
  readonly providerUsi: string;
  readonly resource?: string;
  readonly payloads?: ConfigPayloads;
  readonly payloadsDir?: string;
  readonly mode?: 'observe' | 'full';
  readonly writableResource?: string;
  readonly version?: string;
  /** OriginatingSystemName scope for a multi-tenant recipient — carried by the reso-certification-utils config
   *  format; threaded into DD replication + Core scenario queries (resource-aware). OSN takes precedence over OSID. */
  readonly originatingSystemName?: string;
  /** OriginatingSystemID scope — used when no OriginatingSystemName is provided. */
  readonly originatingSystemId?: string;
}

/** Top-level config file shape (matches reso-certification-utils format). */
export interface CertConfigFile {
  readonly providerUoi: string;
  readonly configs: ReadonlyArray<ConfigEntry>;
}

// ── Auth Resolution ──

/** Resolve auth config from a config entry. */
const resolveAuthFromEntry = (entry: ConfigEntry): AuthConfig => {
  if (entry.clientCredentials) {
    return {
      mode: 'client_credentials',
      clientId: entry.clientCredentials.clientId,
      clientSecret: entry.clientCredentials.clientSecret,
      tokenUrl: entry.clientCredentials.tokenUri,
    };
  }
  if (entry.token) {
    return { mode: 'token', authToken: entry.token };
  }
  throw new Error('Config entry must have either "token" or "clientCredentials"');
};

// ── Config File Loading & Normalization ──

/** A recipient/config entry as it may appear in ANY supported input shape (before normalization). Mirrors
 *  reso-web-client's config-import: the legacy CLI shape carries auth at the top level (`token` /
 *  `clientCredentials`), while the desktop export nests it under `auth` (with `tokenUrl`, not `tokenUri`). */
interface RawConfigEntry {
  readonly serviceRootUri?: string;
  readonly recipientUoi?: string;
  readonly providerUsi?: string;
  readonly resource?: string;
  readonly description?: string;
  readonly payloads?: ConfigPayloads;
  readonly payloadsDir?: string;
  readonly mode?: 'observe' | 'full';
  readonly writableResource?: string;
  readonly version?: string;
  readonly originatingSystemName?: string;
  readonly originatingSystemId?: string;
  /** Legacy top-level auth. */
  readonly token?: string;
  readonly clientCredentials?: ConfigAuth['clientCredentials'];
  /** Desktop-export nested auth. */
  readonly auth?: {
    readonly mode?: 'token' | 'client_credentials';
    readonly authToken?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly tokenUrl?: string;
    readonly scope?: string;
  };
  /** Desktop per-endorsement options; only `version` is threaded (the rest are per-command CLI flags). */
  readonly ddOptions?: { readonly version?: string };
}

/** Normalize one raw entry (either auth shape) to a canonical ConfigEntry. */
const normalizeConfigEntry = (raw: RawConfigEntry): ConfigEntry => {
  const version = raw.version ?? raw.ddOptions?.version;
  // Auth: prefer the desktop's nested `auth`, else the legacy top-level `token` / `clientCredentials`.
  const auth: ConfigAuth = raw.auth
    ? raw.auth.mode === 'client_credentials' || (!!raw.auth.clientId && !!raw.auth.clientSecret)
      ? { clientCredentials: { clientId: raw.auth.clientId ?? '', clientSecret: raw.auth.clientSecret ?? '', tokenUri: raw.auth.tokenUrl ?? '', ...(raw.auth.scope ? { scope: raw.auth.scope } : {}) } }
      : { token: raw.auth.authToken }
    : raw.clientCredentials
      ? { clientCredentials: raw.clientCredentials }
      : { token: raw.token };
  return {
    serviceRootUri: raw.serviceRootUri ?? '',
    recipientUoi: raw.recipientUoi ?? '',
    providerUsi: raw.providerUsi ?? '',
    ...auth,
    ...(raw.resource ? { resource: raw.resource } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.payloads ? { payloads: raw.payloads } : {}),
    ...(raw.payloadsDir ? { payloadsDir: raw.payloadsDir } : {}),
    ...(raw.mode ? { mode: raw.mode } : {}),
    ...(raw.writableResource ? { writableResource: raw.writableResource } : {}),
    ...(version ? { version } : {}),
    ...(raw.originatingSystemName ? { originatingSystemName: raw.originatingSystemName } : {}),
    ...(raw.originatingSystemId ? { originatingSystemId: raw.originatingSystemId } : {}),
  };
};

/** Normalize any recognized config shape to the canonical `{ providerUoi, configs }`. Accepts the legacy CLI
 *  format (`{ providerUoi, configs: [...] }`), the desktop export (`{ providerUoi, recipients: [...] }` with
 *  nested `auth`), and a single-entry config (`{ serviceRootUri, auth, ... }`) — so a downloaded desktop config
 *  runs unmodified. Mirrors reso-web-client's config-import. */
export const normalizeConfigFile = (raw: Record<string, unknown>): CertConfigFile => {
  const rawEntries: ReadonlyArray<RawConfigEntry> =
    Array.isArray(raw.configs) ? (raw.configs as ReadonlyArray<RawConfigEntry>)
      : Array.isArray(raw.recipients) ? (raw.recipients as ReadonlyArray<RawConfigEntry>)
        : (raw.serviceRootUri || raw.recipientUoi) ? [raw as RawConfigEntry]
          : [];

  if (rawEntries.length === 0) {
    throw new Error('Config file has no entries — expected a "configs" or "recipients" array (or a single entry with "serviceRootUri").');
  }

  const providerUoi = typeof raw.providerUoi === 'string' && raw.providerUoi ? raw.providerUoi : generateLocalUoi();
  return { providerUoi, configs: rawEntries.map(normalizeConfigEntry) };
};

/** Load and normalize a config file from disk (any supported shape → canonical `{ providerUoi, configs }`). */
export const loadConfigFile = async (path: string): Promise<CertConfigFile> => {
  const content = await readFile(path, 'utf-8');
  return normalizeConfigFile(JSON.parse(content) as Record<string, unknown>);
};

/** Generate a local placeholder UOI for testing. */
export const generateLocalUoi = (): string => `LOCAL-${Date.now()}`;

// ── Config to ComplianceConfig Conversion ──

/** Convert an Add/Edit config entry to a ComplianceConfig. */
export const configEntryToAddEdit = (entry: ConfigEntry, providerUoi: string): AddEditConfig => ({
  endorsement: 'add-edit',
  server: {
    url: entry.serviceRootUri,
    auth: resolveAuthFromEntry(entry),
  },
  resource: entry.resource ?? 'Property',
  specVersion: entry.version ?? '2.0.0',
  options: {
    outputDir: `.reso-cert/${providerUoi}/${entry.recipientUoi}-${entry.providerUsi}/add-edit`,
  },
});

/** Convert an EntityEvent config entry to a ComplianceConfig. */
export const configEntryToEntityEvent = (entry: ConfigEntry, providerUoi: string): EntityEventConfig => ({
  endorsement: 'entity-event',
  server: {
    url: entry.serviceRootUri,
    auth: resolveAuthFromEntry(entry),
  },
  mode: entry.mode ?? 'observe',
  writableResource: entry.writableResource ?? entry.resource ?? 'Property',
  options: {
    outputDir: `.reso-cert/${providerUoi}/${entry.recipientUoi}-${entry.providerUsi}/entity-event`,
  },
});

/** Convert a Core config entry to a ComplianceConfig. */
export const configEntryToCore = (entry: ConfigEntry, providerUoi: string): CoreConfig => ({
  endorsement: 'core',
  server: {
    url: entry.serviceRootUri,
    auth: resolveAuthFromEntry(entry),
  },
  version: (entry.version as '2.0.0' | '2.1.0') ?? '2.0.0',
  ...(entry.originatingSystemName ? { originatingSystemName: entry.originatingSystemName } : {}),
  ...(entry.originatingSystemId ? { originatingSystemId: entry.originatingSystemId } : {}),
  options: {
    outputDir: `.reso-cert/${providerUoi}/${entry.recipientUoi}-${entry.providerUsi}/core`,
  },
});

/** Convert a DD config entry to a ComplianceConfig. */
export const configEntryToDD = (entry: ConfigEntry, providerUoi: string): DDConfig => ({
  endorsement: 'dd',
  server: {
    url: entry.serviceRootUri,
    auth: resolveAuthFromEntry(entry),
  },
  version: coerceDDVersion(entry.version),
  ...(entry.originatingSystemName ? { originatingSystemName: entry.originatingSystemName } : {}),
  ...(entry.originatingSystemId ? { originatingSystemId: entry.originatingSystemId } : {}),
  options: {
    outputDir: `.reso-cert/${providerUoi}/${entry.recipientUoi}-${entry.providerUsi}/dd`,
  },
});

// ── Key Chaining ──

/** Payload set with resolved keys for Add/Edit testing. */
export interface ResolvedPayloads {
  readonly createSucceeds: Record<string, unknown>;
  readonly createFails: Record<string, unknown>;
  readonly updateSucceeds: Record<string, unknown>;
  readonly updateFails: Record<string, unknown>;
  readonly deleteSucceeds: Record<string, unknown>;
  readonly deleteFails: Record<string, unknown>;
  readonly keyChained: boolean;
}

/**
 * Resolve payload keys for Add/Edit testing.
 *
 * If update/delete payloads are missing keys and a create payload exists,
 * the created record's key will be injected at runtime by the pipeline.
 *
 * If no create payload and no key on update/delete, throws an error.
 */
export const resolvePayloadKeys = (
  payloads: ConfigPayloads,
  keyField: string,
  createdKey?: string,
): ResolvedPayloads => {
  const hasCreate = !!payloads.createSucceeds && Object.keys(payloads.createSucceeds).length > 0;

  const updateSucceeds = { ...payloads.updateSucceeds };
  const updateFails = { ...payloads.updateFails };
  const deleteFails = payloads.deleteFails ?? { id: '00000000-0000-0000-0000-000000000000' };

  let keyChained = false;

  // Resolve update keys
  if (updateSucceeds && !(keyField in updateSucceeds)) {
    if (createdKey) {
      (updateSucceeds as Record<string, unknown>)[keyField] = createdKey;
      keyChained = true;
    } else if (!hasCreate) {
      throw new Error(`Update payload missing "${keyField}" and no Create step to chain from. Provide a key or add a Create payload.`);
    }
    // If hasCreate but no createdKey yet, the pipeline will inject it after the create step
  }

  if (updateFails && !(keyField in updateFails)) {
    if (createdKey) {
      (updateFails as Record<string, unknown>)[keyField] = createdKey;
      keyChained = true;
    } else if (!hasCreate) {
      throw new Error(`Update (fails) payload missing "${keyField}" and no Create step to chain from.`);
    }
  }

  // Resolve delete keys
  const deletePayload = payloads.deleteSucceeds ?? {};
  if (!('id' in deletePayload) && !deletePayload[keyField as keyof typeof deletePayload]) {
    if (createdKey) {
      (deletePayload as Record<string, unknown>).id = createdKey;
      keyChained = true;
    } else if (!hasCreate) {
      throw new Error(`Delete payload missing key and no Create step to chain from. Provide an "id" or add a Create payload.`);
    }
  }

  return {
    createSucceeds: payloads.createSucceeds ?? {},
    createFails: payloads.createFails ?? {},
    updateSucceeds,
    updateFails,
    deleteSucceeds: deletePayload,
    deleteFails,
    keyChained,
  };
};
