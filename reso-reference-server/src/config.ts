import { resolve } from 'node:path';

/** Database backend type. */
export type DbBackend = 'postgres' | 'mongodb' | 'sqlite';

/** Enumeration mode: string enums with Lookup Resource, or OData EnumType definitions. */
export type EnumMode = 'string' | 'enum-type';

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
  readonly baseUrl: string;
  /** Root directory for resolving server assets (ui-config.json, field-groups.json, public/). */
  readonly serverRoot: string;
}

/** Reads configuration from environment variables, with optional programmatic overrides. */
export const loadConfig = (overrides?: Partial<ServerConfig>): ServerConfig => {
  const port = overrides?.port ?? Number(process.env.PORT ?? 8080);
  const dbBackend = overrides?.dbBackend ?? (process.env.DB_BACKEND ?? 'postgres') as DbBackend;
  const enumMode = overrides?.enumMode ?? (process.env.ENUM_MODE ?? 'string') as EnumMode;
  const databaseUrl = overrides?.databaseUrl ?? process.env.DATABASE_URL ?? 'postgresql://reso:reso@localhost:5432/reso_reference';
  const mongodbUrl = overrides?.mongodbUrl ?? process.env.MONGODB_URL ?? 'mongodb://localhost:27017/reso_reference';
  const sqliteDbPath = overrides?.sqliteDbPath ?? process.env.SQLITE_DB_PATH ?? resolve(import.meta.dirname, '../reso_reference.db');
  const metadataPath = overrides?.metadataPath ?? process.env.METADATA_PATH ?? resolve(import.meta.dirname, '../server-metadata.json');
  const baseUrl = overrides?.baseUrl ?? process.env.BASE_URL ?? `http://localhost:${port}`;
  const entityEvent = overrides?.entityEvent ?? process.env.ENTITY_EVENT === 'true';
  const entityEventResourceRecordUrl = overrides?.entityEventResourceRecordUrl ?? process.env.ENTITY_EVENT_RESOURCE_RECORD_URL === 'true';
  const compactionIntervalMs = overrides?.compactionIntervalMs ?? Number(process.env.COMPACTION_INTERVAL_MS ?? 3600000);
  // Default serverRoot: when running from dist/, resolve to src/ where asset files live
  const defaultRoot = import.meta.dirname.endsWith('/dist')
    ? resolve(import.meta.dirname, '../src')
    : import.meta.dirname;
  const serverRoot = overrides?.serverRoot ?? defaultRoot;

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
    serverRoot
  };
};
