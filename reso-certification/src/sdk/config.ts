import { readFile } from 'node:fs/promises';
import type { AuthConfig } from '../test-runner/types.js';
import type { AddEditConfig, EntityEventConfig, CoreConfig, DDConfig } from './types.js';
import { coerceCoreVersion } from './core-versions.js';
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

/** Per-endorsement option blocks as the desktop client exports them (reso-web-client config-builder
 *  RecipientConfig). Carried through normalization so a downloaded config runs unmodified; each converter
 *  reads its own block first, then the flat entry-level keys (legacy CLI format), then the defaults. */
interface ConfigDDOptions {
  readonly version?: string;
  readonly originatingSystemName?: string;
  readonly originatingSystemId?: string;
  readonly limit?: number;
  readonly strictMode?: boolean;
  readonly batchExpand?: boolean;
  readonly requestDelay?: number;
  readonly rateLimitWait?: number;
}
interface ConfigCoreOptions {
  readonly version?: string;
  readonly resources?: string | ReadonlyArray<string>;
  readonly enumMode?: 'auto' | 'isflags' | 'collections' | 'string';
  readonly fullCoverage?: boolean;
  readonly originatingSystemName?: string;
  readonly originatingSystemId?: string;
}
interface ConfigAddEditOptions {
  readonly resource?: string;
  readonly specVersion?: string;
  readonly payloadsDir?: string;
}
interface ConfigEntityEventOptions {
  readonly mode?: 'observe' | 'full';
  readonly writableResource?: string;
  readonly maxEvents?: number;
  readonly pollInterval?: number;
  readonly pollTimeout?: number;
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
  readonly ddOptions?: ConfigDDOptions;
  readonly coreOptions?: ConfigCoreOptions;
  readonly addEditOptions?: ConfigAddEditOptions;
  readonly entityEventOptions?: ConfigEntityEventOptions;
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
  /** Desktop per-endorsement option blocks — threaded whole (see ConfigEntry). */
  readonly ddOptions?: ConfigDDOptions;
  readonly coreOptions?: ConfigCoreOptions;
  readonly addEditOptions?: ConfigAddEditOptions;
  readonly entityEventOptions?: ConfigEntityEventOptions;
}

/** Validate a config entry's serviceRootUri is a real absolute http(s) URL — the catch-all that turns an
 *  unusable address into a clear, actionable failure at config load instead of a raw crash mid-run. Catches
 *  the common cases: a desktop placeholder the CLI can't resolve (e.g. `LOCAL_SERVER` — a desktop-internal
 *  handle for its reference server; export a config with the real address), a missing scheme, or a typo. */
const validateServiceRootUri = (uri: string, recipientUoi: string): string => {
  const value = uri.trim();
  const where = recipientUoi ? ` for recipient ${recipientUoi}` : '';
  const parsed = ((): URL | undefined => { try { return new URL(value); } catch { return undefined; } })();
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`Config${where}: serviceRootUri ${JSON.stringify(value)} is not a valid URL — set an absolute http(s) server address. The CLI does not resolve placeholder shortcuts like "LOCAL_SERVER"; export a config with the real server address.`);
  }
  return value;
};

/** Normalize one raw entry (either auth shape) to a canonical ConfigEntry. */
const normalizeConfigEntry = (raw: RawConfigEntry): ConfigEntry => {
  const version = raw.version ?? raw.ddOptions?.version;
  const originatingSystemName = raw.originatingSystemName ?? raw.coreOptions?.originatingSystemName ?? raw.ddOptions?.originatingSystemName;
  const originatingSystemId = raw.originatingSystemId ?? raw.coreOptions?.originatingSystemId ?? raw.ddOptions?.originatingSystemId;
  // Auth: prefer the desktop's nested `auth`, else the legacy top-level `token` / `clientCredentials`.
  const auth: ConfigAuth = raw.auth
    ? raw.auth.mode === 'client_credentials' || (!!raw.auth.clientId && !!raw.auth.clientSecret)
      ? { clientCredentials: { clientId: raw.auth.clientId ?? '', clientSecret: raw.auth.clientSecret ?? '', tokenUri: raw.auth.tokenUrl ?? '', ...(raw.auth.scope ? { scope: raw.auth.scope } : {}) } }
      : { token: raw.auth.authToken }
    : raw.clientCredentials
      ? { clientCredentials: raw.clientCredentials }
      : { token: raw.token };
  return {
    serviceRootUri: validateServiceRootUri(raw.serviceRootUri ?? '', raw.recipientUoi ?? ''),
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
    // Flat OSN/OSID: the entry-level key, else whichever block declares one — one recipient is one scope, so a
    // value entered under DD applies to a Core run of the same recipient (and vice versa) unless that
    // endorsement's own block says otherwise (the converters read their block first).
    ...(originatingSystemName ? { originatingSystemName } : {}),
    ...(originatingSystemId ? { originatingSystemId } : {}),
    ...(raw.ddOptions ? { ddOptions: raw.ddOptions } : {}),
    ...(raw.coreOptions ? { coreOptions: raw.coreOptions } : {}),
    ...(raw.addEditOptions ? { addEditOptions: raw.addEditOptions } : {}),
    ...(raw.entityEventOptions ? { entityEventOptions: raw.entityEventOptions } : {}),
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

/** An endorsement's OSN: its own block first, then the flat entry-level value (which normalization already
 *  filled from whichever block declared one). */
const osn = (block: { readonly originatingSystemName?: string } | undefined, entry: ConfigEntry): string | undefined =>
  block?.originatingSystemName ?? entry.originatingSystemName;
const osid = (block: { readonly originatingSystemId?: string } | undefined, entry: ConfigEntry): string | undefined =>
  block?.originatingSystemId ?? entry.originatingSystemId;

/** Core `resources` as the desktop writes it (a comma-separated string) or as a list. */
const coreResources = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined;
  const list = (typeof value === 'string' ? value.split(',') : value).map((r) => r.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
};

/** Convert an Add/Edit config entry to a ComplianceConfig. */
export const configEntryToAddEdit = (entry: ConfigEntry, providerUoi: string): AddEditConfig => ({
  endorsement: 'add-edit',
  server: {
    url: entry.serviceRootUri,
    auth: resolveAuthFromEntry(entry),
  },
  resource: entry.addEditOptions?.resource ?? entry.resource ?? 'Property',
  specVersion: entry.addEditOptions?.specVersion ?? entry.version ?? '2.0.0',
  ...(entry.addEditOptions?.payloadsDir ?? entry.payloadsDir ? { payloadsDir: entry.addEditOptions?.payloadsDir ?? entry.payloadsDir } : {}),
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
  mode: entry.entityEventOptions?.mode ?? entry.mode ?? 'observe',
  writableResource: entry.entityEventOptions?.writableResource ?? entry.writableResource ?? entry.resource ?? 'Property',
  ...(entry.entityEventOptions?.maxEvents !== undefined ? { maxEvents: entry.entityEventOptions.maxEvents } : {}),
  ...(entry.entityEventOptions?.pollInterval !== undefined ? { pollInterval: entry.entityEventOptions.pollInterval } : {}),
  ...(entry.entityEventOptions?.pollTimeout !== undefined ? { pollTimeout: entry.entityEventOptions.pollTimeout } : {}),
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
  version: coerceCoreVersion(entry.coreOptions?.version ?? entry.version),
  ...(entry.coreOptions?.enumMode ? { enumMode: entry.coreOptions.enumMode } : {}),
  ...(coreResources(entry.coreOptions?.resources) ? { resources: coreResources(entry.coreOptions?.resources) } : {}),
  ...(entry.coreOptions?.fullCoverage ? { fullCoverage: true } : {}),
  ...(osn(entry.coreOptions, entry) ? { originatingSystemName: osn(entry.coreOptions, entry) } : {}),
  ...(osid(entry.coreOptions, entry) ? { originatingSystemId: osid(entry.coreOptions, entry) } : {}),
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
  version: coerceDDVersion(entry.ddOptions?.version ?? entry.version),
  ...(entry.ddOptions?.limit !== undefined ? { limit: entry.ddOptions.limit } : {}),
  ...(entry.ddOptions?.strictMode ? { strictMode: true } : {}),
  ...(entry.ddOptions?.batchExpand ? { batchExpand: true } : {}),
  ...(entry.ddOptions?.requestDelay !== undefined ? { requestDelay: entry.ddOptions.requestDelay } : {}),
  ...(entry.ddOptions?.rateLimitWait !== undefined ? { rateLimitWait: entry.ddOptions.rateLimitWait } : {}),
  ...(osn(entry.ddOptions, entry) ? { originatingSystemName: osn(entry.ddOptions, entry) } : {}),
  ...(osid(entry.ddOptions, entry) ? { originatingSystemId: osid(entry.ddOptions, entry) } : {}),
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
