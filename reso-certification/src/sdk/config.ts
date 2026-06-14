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

// ── Config File Loading ──

/** Load and parse a config file from disk. */
export const loadConfigFile = async (path: string): Promise<CertConfigFile> => {
  const content = await readFile(path, 'utf-8');
  const parsed = JSON.parse(content) as CertConfigFile;

  if (!parsed.providerUoi) throw new Error('Config file missing "providerUoi"');
  if (!parsed.configs?.length) throw new Error('Config file missing "configs" array');

  return parsed;
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
