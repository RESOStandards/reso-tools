import { resolve } from 'node:path';
import type { EnumMode } from '@reso-standards/reso-common';
import { TARGET_RESOURCES } from './metadata/types.js';

/** Database backend type. */
export type DbBackend = 'postgres' | 'mongodb' | 'sqlite';

/** Enumeration mode (string enums with Lookup Resource, or OData EnumType definitions) — re-exported from the shared reso-common model. */
export type { EnumMode };

/** Server configuration derived from environment variables with sensible defaults. */
export interface ServerConfig {
  readonly port: number;
  readonly dbBackend: DbBackend;
  readonly enumMode: EnumMode;
  readonly entityEvent: boolean;
  readonly entityEventResourceRecordUrl: boolean;
  readonly compactionIntervalMs: number;
  readonly databaseUrl: string;
  readonly mongodbUrl: string;
  readonly sqliteDbPath: string;
  readonly metadataPath: string;
  /** Effective base URL for request-less consumers (OpenAPI `servers`, EntityEvent record URLs, logs). Equals
   *  {@link baseUrlOverride} when set, else `http://localhost:${port}`. NOT used for per-request OData response
   *  links — those derive the base from the request (see `resolveBaseUrl`). */
  readonly baseUrl: string;
  /** The EXPLICIT base-URL override only (BASE_URL env / programmatic), or undefined when unset. When unset,
   *  per-request response links are derived from the request's Host — so no static config is needed for
   *  local / Docker / direct-FQDN. Set it only to pin a canonical public URL the container can't observe. */
  readonly baseUrlOverride?: string;
  /** Root directory for resolving server assets (ui-config.json, field-groups.json, public/). */
  readonly serverRoot: string;
  /**
   * The resources served, by Data Dictionary resource name (`RESOURCES`, comma-separated). Defaults to
   * {@link TARGET_RESOURCES}. A listed resource with no fields in the metadata is skipped, as before, so a deployment
   * serving its own resources (`RESOURCES=OUID,System`) lists them here and defines them in its metadata file.
   */
  readonly resources: ReadonlyArray<string>;
  /** `READ_ONLY=true`: no create, update or delete route on any resource. */
  readonly readOnly: boolean;
  /**
   * `PRODUCTION_INSTANCE=true`: this server is a production instance serving real data, not the self-contained reference
   * server. Two things follow. It mounts only the OData service (the service document, `$metadata`, the resource routes)
   * and `/health`: no admin routes, mock OAuth endpoint, outbound proxy, Swagger UI, UI endpoints, metadata JSON API or
   * static files. And it leaves the database as it finds it: no table, index or collection setup and no Lookup seeding at
   * start, because a production database is set up and migrated separately, so the server can run with a login that
   * cannot write. Whether it accepts changes is `READ_ONLY`, a separate choice.
   */
  readonly productionInstance: boolean;
}

/** `RESOURCES` as a list. Unset means the default; set but naming nothing is a mistake, not "serve nothing". */
const parseResources = (raw: string | undefined): ReadonlyArray<string> | undefined => {
  if (raw === undefined) return undefined;
  const names = [
    ...new Set(
      raw
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0)
    )
  ];
  if (names.length === 0) throw new Error('RESOURCES is set but names no resources. Unset it to serve the default resources.');
  return names;
};

/** Reads configuration from environment variables, with optional programmatic overrides. */
export const loadConfig = (overrides?: Partial<ServerConfig>): ServerConfig => {
  const port = overrides?.port ?? Number(process.env.PORT ?? 8080);
  const dbBackend = overrides?.dbBackend ?? ((process.env.DB_BACKEND ?? 'postgres') as DbBackend);
  const enumMode = overrides?.enumMode ?? ((process.env.ENUM_MODE ?? 'string') as EnumMode);
  const databaseUrl = overrides?.databaseUrl ?? process.env.DATABASE_URL ?? 'postgresql://reso:reso@localhost:5432/reso_reference';
  const mongodbUrl = overrides?.mongodbUrl ?? process.env.MONGODB_URL ?? 'mongodb://localhost:27017/reso_reference';
  const sqliteDbPath = overrides?.sqliteDbPath ?? process.env.SQLITE_DB_PATH ?? resolve(import.meta.dirname, '../reso_reference.db');
  const metadataPath = overrides?.metadataPath ?? process.env.METADATA_PATH ?? resolve(import.meta.dirname, '../server-metadata.json');
  // Explicit override only (undefined when neither is set) — when undefined, per-request OData links derive
  // their base from the request Host. `baseUrl` stays as the effective default for request-less consumers.
  const baseUrlOverride = overrides?.baseUrlOverride ?? overrides?.baseUrl ?? process.env.BASE_URL;
  const baseUrl = baseUrlOverride ?? `http://localhost:${port}`;
  const entityEvent = overrides?.entityEvent ?? process.env.ENTITY_EVENT === 'true';
  const entityEventResourceRecordUrl = overrides?.entityEventResourceRecordUrl ?? process.env.ENTITY_EVENT_RESOURCE_RECORD_URL === 'true';
  const compactionIntervalMs = overrides?.compactionIntervalMs ?? Number(process.env.COMPACTION_INTERVAL_MS ?? 3600000);
  // Default serverRoot: when running from dist/, resolve to src/ where asset files live
  const defaultRoot = import.meta.dirname.endsWith('/dist') ? resolve(import.meta.dirname, '../src') : import.meta.dirname;
  const serverRoot = overrides?.serverRoot ?? defaultRoot;
  const resources = overrides?.resources ?? parseResources(process.env.RESOURCES) ?? TARGET_RESOURCES;
  const readOnly = overrides?.readOnly ?? process.env.READ_ONLY === 'true';
  const productionInstance = overrides?.productionInstance ?? process.env.PRODUCTION_INSTANCE === 'true';

  if (dbBackend !== 'postgres' && dbBackend !== 'mongodb' && dbBackend !== 'sqlite') {
    throw new Error(`Invalid DB_BACKEND: ${dbBackend}. Must be "postgres", "mongodb", or "sqlite".`);
  }

  if (enumMode !== 'string' && enumMode !== 'enum-type') {
    throw new Error(`Invalid ENUM_MODE: ${enumMode}. Must be "string" or "enum-type".`);
  }

  return {
    port,
    dbBackend,
    enumMode,
    entityEvent,
    entityEventResourceRecordUrl,
    compactionIntervalMs,
    databaseUrl,
    mongodbUrl,
    sqliteDbPath,
    metadataPath,
    baseUrl,
    ...(baseUrlOverride !== undefined && { baseUrlOverride }),
    serverRoot,
    resources,
    readOnly,
    productionInstance
  };
};
