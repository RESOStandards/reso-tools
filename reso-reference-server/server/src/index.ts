import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { createAdminRouter } from './admin/router.js';
import { loadAuthConfig } from './auth/config.js';
import { createMockOAuthRouter } from './auth/mock-oauth.js';
import { loadConfig } from './config.js';
import type { ServerConfig } from './config.js';
import type { DataAccessLayer } from './db/data-access.js';
import type { CompactionRunner } from './db/entity-event-compaction.js';
import { createEntityEventDal } from './db/entity-event-dal.js';
import { createSwaggerRouter } from './docs/swagger.js';
import { generateEdmx } from './metadata/edmx-generator.js';
import { getFieldsForResource, getKeyFieldForResource, getLookupsForType, isEnumType, loadMetadata } from './metadata/loader.js';
import { seedLookups } from './metadata/lookup-seeder.js';
import { generateOpenApiSpec } from './metadata/openapi-generator.js';
import { TARGET_RESOURCES } from './metadata/types.js';
import { createODataRouter } from './odata/router.js';

/** Options for creating the server app. */
export interface CreateAppOptions {
  /** Server configuration (from loadConfig or built manually). */
  readonly config: ServerConfig;
  /** Path to built UI assets to serve as SPA. When set, serves static files and SPA fallback. */
  readonly uiDistPath?: string;
}

/** Result of creating the server app. */
export interface AppInstance {
  /** The Express application, ready to listen. */
  readonly app: express.Express;
  /** The data access layer (for programmatic use). */
  readonly dal: DataAccessLayer;
  /** Call to clean up resources (close DB handles, stop timers). */
  readonly cleanup: () => void;
}

/** Creates the RESO Reference Server Express app without starting it. */
export const createApp = async (options: CreateAppOptions): Promise<AppInstance> => {
  const { config } = options;
  console.log('RESO Reference Server initializing...');
  console.log(`  Backend: ${config.dbBackend}`);
  console.log(`  Enum mode: ${config.enumMode}`);
  console.log(`  EntityEvent: ${config.entityEvent ? 'enabled' : 'disabled'}`);
  console.log(`  Metadata: ${config.metadataPath}`);

  // Load metadata
  const metadata = await loadMetadata(config.metadataPath);
  console.log(`Loaded RESO metadata v${metadata.version}: ${metadata.fields.length} fields, ${metadata.lookups.length} lookups`);

  // Build active resource list — include Lookup in string enum mode, EntityEvent when enabled
  const activeResources: ReadonlyArray<string> = [
    ...TARGET_RESOURCES,
    ...(config.enumMode === 'string' ? ['Lookup'] : []),
    ...(config.entityEvent ? ['EntityEvent'] : [])
  ];

  // Read-only resources should not have POST/PATCH/DELETE routes
  const readOnlyResources: ReadonlySet<string> = new Set([
    ...(config.enumMode === 'string' ? ['Lookup'] : []),
    ...(config.entityEvent ? ['EntityEvent'] : [])
  ]);

  const resourceSpecs = activeResources
    .map(resource => ({
      resourceName: resource,
      keyField: getKeyFieldForResource(resource)!,
      fields: getFieldsForResource(metadata, resource)
    }))
    .filter(spec => spec.keyField && spec.fields.length > 0);

  // Create data access layer based on configured backend
  let dal: DataAccessLayer;
  let compactionRunner: CompactionRunner | undefined;
  let cleanupFn: () => void = () => {};

  if (config.dbBackend === 'mongodb') {
    console.log(`  MongoDB: ${config.mongodbUrl.replace(/\/\/.*@/, '//***@')}`);
    const { MongoClient } = await import('mongodb');
    const { createMongoDal } = await import('./db/mongo-dal.js');
    const { initializeMongoCollections } = await import('./db/mongo-init.js');

    const client = new MongoClient(config.mongodbUrl);
    await client.connect();
    const db = client.db();

    const mongoSpecs = resourceSpecs.map(spec => ({
      resourceName: spec.resourceName,
      keyField: spec.keyField,
      hasResourceRecordKey: spec.fields.some(f => f.fieldName === 'ResourceRecordKey')
    }));
    console.log(`Initializing MongoDB collections and indexes for ${mongoSpecs.length} resources...`);
    await initializeMongoCollections(db, mongoSpecs);
    console.log('MongoDB initialization complete.');

    dal = createMongoDal(db);
    cleanupFn = () => { client.close(); };
    if (config.entityEvent) {
      const { createMongoEntityEventWriter } = await import('./db/entity-event-writers.js');
      const { createMongoCompactionRunner } = await import('./db/entity-event-compaction.js');
      dal = createEntityEventDal(dal, createMongoEntityEventWriter(db), {
        baseUrl: config.baseUrl,
        includeResourceRecordUrl: config.entityEventResourceRecordUrl
      });
      compactionRunner = createMongoCompactionRunner(db);
    }
  } else if (config.dbBackend === 'sqlite') {
    console.log(`  SQLite: ${config.sqliteDbPath}`);
    const { createSqliteDb } = await import('./db/sqlite-pool.js');
    const { createSqliteDal } = await import('./db/sqlite-dal.js');
    const { generateSqliteSchema } = await import('./db/sqlite-schema-generator.js');

    const sqliteDb = createSqliteDb(config.sqliteDbPath);
    const ddl = generateSqliteSchema(resourceSpecs);
    for (const stmt of ddl) {
      sqliteDb.exec(stmt);
    }
    console.log(`SQLite schema initialized (${ddl.length} statements).`);

    dal = createSqliteDal(sqliteDb);
    cleanupFn = () => { sqliteDb.close(); };
    if (config.entityEvent) {
      const { createSqliteEntityEventWriter } = await import('./db/entity-event-writers.js');
      const { createSqliteCompactionRunner } = await import('./db/entity-event-compaction.js');
      dal = createEntityEventDal(dal, createSqliteEntityEventWriter(sqliteDb), {
        baseUrl: config.baseUrl,
        includeResourceRecordUrl: config.entityEventResourceRecordUrl
      });
      compactionRunner = createSqliteCompactionRunner(sqliteDb);
    }
  } else {
    console.log(`  PostgreSQL: ${config.databaseUrl.replace(/\/\/.*@/, '//***@')}`);
    const { createPool } = await import('./db/pool.js');
    const { createPostgresDal } = await import('./db/postgres-dal.js');
    const { generateSchema } = await import('./db/schema-generator.js');
    const { runMigrations } = await import('./db/migrate.js');

    const pool = createPool(config.databaseUrl);
    const ddl = generateSchema(resourceSpecs);
    console.log(`Running migrations for ${resourceSpecs.length} resources...`);
    await runMigrations(pool, ddl);
    console.log('Database migrations complete.');

    dal = createPostgresDal(pool);
    cleanupFn = () => { pool.end(); };
    if (config.entityEvent) {
      const { createPostgresEntityEventWriter } = await import('./db/entity-event-writers.js');
      const { createPostgresCompactionRunner } = await import('./db/entity-event-compaction.js');
      dal = createEntityEventDal(dal, createPostgresEntityEventWriter(pool), {
        baseUrl: config.baseUrl,
        includeResourceRecordUrl: config.entityEventResourceRecordUrl
      });
      compactionRunner = createPostgresCompactionRunner(pool);
    }
  }

  // Start EntityEvent compaction scheduler
  let compactionTimer: ReturnType<typeof setInterval> | undefined;
  if (compactionRunner && config.compactionIntervalMs > 0) {
    const { startCompaction } = await import('./db/entity-event-compaction.js');
    compactionTimer = startCompaction(compactionRunner, config.compactionIntervalMs);
    console.log(`EntityEvent compaction scheduled every ${config.compactionIntervalMs}ms.`);
  }

  // Auto-seed Lookup resource from metadata in string enum mode
  if (config.enumMode === 'string') {
    const seeded = await seedLookups(dal, metadata);
    if (seeded > 0) {
      console.log(`Seeded ${seeded} Lookup records from metadata.`);
    }
  }

  // Load auth configuration
  const authConfig = loadAuthConfig();

  // Generate EDMX metadata
  const edmxXml = generateEdmx(metadata, activeResources, config.enumMode);

  // Generate OpenAPI spec
  const openApiSpec = generateOpenApiSpec(metadata, activeResources, config.baseUrl);

  // Build Express app
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));

  // OData version + CORS headers
  app.use((_req, res, next) => {
    res.set('OData-Version', '4.0');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Prefer, OData-Version');
    res.set('Access-Control-Expose-Headers', 'OData-Version');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    if (_req.method === 'OPTIONS') {
      res.status(204).send();
      return;
    }
    next();
  });

  // $metadata endpoint — regex because Express treats $ as special
  app.get(/^\/\$metadata$/, (_req, res) => {
    res.type('application/xml').send(edmxXml);
  });

  // OData service document (GET /) — lists all entity sets (only for JSON requests)
  app.get('/', (req, res, next) => {
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/html') && options.uiDistPath) {
      next();
      return;
    }
    res.json({
      '@odata.context': `${config.baseUrl}/$metadata`,
      value: activeResources.map(name => ({
        name,
        kind: 'EntitySet',
        url: name
      }))
    });
  });

  // OAuth2 mock token endpoint
  app.use(createMockOAuthRouter());

  // OData CRUD + collection routes (using DAL instead of direct pool access)
  const odataRouter = createODataRouter(metadata, dal, config.baseUrl, activeResources, readOnlyResources);
  app.use(odataRouter);

  // Admin endpoints (data generator, etc.)
  const adminRouter = createAdminRouter(metadata, dal, authConfig, config.enumMode);
  app.use(adminRouter);

  // Swagger UI
  app.use(createSwaggerRouter(openApiSpec));

  // Static file serving (mock images for UI media carousel)
  const publicDir = resolve(config.serverRoot, '../public');
  app.use(express.static(publicDir));

  // UI config endpoint — serves summary field configuration for the UI
  const uiConfigPath = resolve(config.serverRoot, './ui-config.json');
  const uiConfig = JSON.parse(await readFile(uiConfigPath, 'utf-8'));
  app.get('/ui-config', (_req, res) => {
    res.json(uiConfig);
  });

  // Field groups endpoint — serves RESO Data Dictionary field groupings for the UI
  const fieldGroupsPath = resolve(config.serverRoot, './field-groups.json');
  const fieldGroups = JSON.parse(await readFile(fieldGroupsPath, 'utf-8'));
  app.get('/field-groups', (_req, res) => {
    res.json(fieldGroups);
  });

  // Metadata JSON API — lightweight JSON alternatives to EDMX XML for UI consumption
  app.get('/api/metadata/fields', (req, res) => {
    const resource = req.query.resource as string | undefined;
    if (!resource) {
      res.status(400).json({ error: 'Missing required query parameter: resource' });
      return;
    }
    const fields = getFieldsForResource(metadata, resource);
    res.json(fields);
  });

  app.get('/api/metadata/lookups', (req, res) => {
    const type = req.query.type as string | undefined;
    if (!type) {
      res.status(400).json({ error: 'Missing required query parameter: type' });
      return;
    }
    const lookups = getLookupsForType(metadata, type);
    res.json(lookups);
  });

  app.get('/api/metadata/lookups-for-resource', (req, res) => {
    const resource = req.query.resource as string | undefined;
    if (!resource) {
      res.status(400).json({ error: 'Missing required query parameter: resource' });
      return;
    }
    const fields = getFieldsForResource(metadata, resource);
    const enumFields = fields.filter(f => isEnumType(f.type));
    const result: Record<string, unknown> = {};
    for (const field of enumFields) {
      const lookupName = field.type;
      if (!result[lookupName]) {
        result[lookupName] = getLookupsForType(metadata, lookupName);
      }
    }
    res.json(result);
  });

  // Proxy endpoint — forwards requests to external OData servers to avoid browser CORS restrictions.
  // Usage: GET /api/proxy?url=<encoded-external-url>  (optional Authorization header forwarded)
  app.all('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url as string | undefined;
    if (!targetUrl) {
      res.status(400).json({ error: 'Missing required query parameter: url' });
      return;
    }

    // Validate URL to prevent SSRF against private networks
    try {
      const parsed = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        res.status(400).json({ error: 'Only http and https URLs are allowed' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }

    // Forward the request to the external server — pass through OData-Version if provided, don't force a version
    // Strip conditional caching headers so upstream always returns a full response (not 304)
    const headers: Record<string, string> = {
      Accept: req.headers.accept ?? 'application/json'
    };
    const odataVersion = req.headers['odata-version'];
    if (typeof odataVersion === 'string') {
      headers['OData-Version'] = odataVersion;
    }
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }
    if (req.headers['content-type']) {
      headers['Content-Type'] = req.headers['content-type'];
    }

    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: ['POST', 'PATCH', 'PUT'].includes(req.method) ? JSON.stringify(req.body) : undefined
      });

      // Prevent browser from caching proxy responses (avoids stale 304s)
      res.set('Cache-Control', 'no-store');

      // Forward status and key headers
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.set('Content-Type', contentType);
      const upstreamOdataVersion = upstream.headers.get('odata-version');
      if (upstreamOdataVersion) res.set('OData-Version', upstreamOdataVersion);

      const body = await upstream.text();
      res.send(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Proxy request failed';
      res.status(502).json({ error: message });
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: metadata.version });
  });

  // Serve built UI as SPA (must come after all API routes)
  if (options.uiDistPath) {
    app.use(express.static(options.uiDistPath));
    const uiIndexPath = resolve(options.uiDistPath, 'index.html');
    app.get('*', async (_req, res) => {
      res.sendFile(uiIndexPath);
    });
  }

  const cleanup = (): void => {
    if (compactionTimer) clearInterval(compactionTimer);
    cleanupFn();
  };

  return { app, dal, cleanup };
};

/** Starts the server on the configured port. Returns the HTTP server instance. */
export const startServer = (app: express.Express, config: ServerConfig): Server =>
  app.listen(config.port, () => {
    console.log(`\nRESO Reference Server running at ${config.baseUrl}`);
    console.log(`  API docs: ${config.baseUrl}/api-docs`);
    console.log(`  Metadata: ${config.baseUrl}/$metadata`);
    console.log(`  Health:   ${config.baseUrl}/health`);
  });

// Re-export config types and loader for consumers
export { loadConfig } from './config.js';
export type { ServerConfig, DbBackend, EnumMode } from './config.js';

// CLI entry point — only runs when executed directly (not when imported as library)
const isDirectExecution = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/dist/index.js');

if (isDirectExecution) {
  const config = loadConfig();
  console.log(`  Port: ${config.port}`);
  createApp({ config })
    .then(({ app }) => startServer(app, config))
    .catch(err => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
