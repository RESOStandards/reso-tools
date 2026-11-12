import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
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
import { resolveBaseUrl } from './odata/base-url.js';
import { createODataRouter } from './odata/router.js';
import { describeProxyFailure, proxyFailureLogLine } from './proxy-failure.js';
import { MAX_PROXY_REDIRECTS, createProxyPolicy, isRedirect, parseServiceRoots, redirectedMethod } from './proxy-policy.js';

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
  /**
   * Allow `/api/proxy` to forward to a service root while the server runs, as an embedding host does for each server it
   * connects to. Checked like ALLOWED_SERVICE_ROOTS; a bad root throws.
   */
  readonly allowServiceRoot: (root: string) => void;
  /** Stop allowing a service root, as when the host's connection to it is removed. */
  readonly forgetServiceRoot: (root: string) => void;
}

/** Creates the RESO Reference Server Express app without starting it. */
export const createApp = async (options: CreateAppOptions): Promise<AppInstance> => {
  const { config } = options;
  console.log('RESO Reference Server initializing...');
  console.log(`  Backend: ${config.dbBackend}`);
  console.log(`  Enum mode: ${config.enumMode}`);
  console.log(`  EntityEvent: ${config.entityEvent ? 'enabled' : 'disabled'}`);
  console.log(`  Metadata: ${config.metadataPath}`);

  // Where /api/proxy may forward to, checked now so a bad root stops the server at start (reso-tools #424).
  const proxyPolicy = createProxyPolicy(parseServiceRoots(config.allowedServiceRoots, 'ALLOWED_SERVICE_ROOTS'), config.allowAnyServiceRoot);
  if (proxyPolicy.allowsAny) {
    console.warn("  WARNING: ALLOW_ANY_SERVICE_ROOT=true: /api/proxy forwards to any http(s) URL, with the caller's credentials.");
  }

  // Load metadata
  const metadata = await loadMetadata(config.metadataPath);
  console.log(`Loaded RESO metadata v${metadata.version}: ${metadata.fields.length} fields, ${metadata.lookups.length} lookups`);

  // Build active resource list — include Lookup in string enum mode, EntityEvent when enabled
  // Once each: RESOURCES may already name Lookup or EntityEvent.
  const activeResources: ReadonlyArray<string> = [
    ...new Set([...config.resources, ...(config.enumMode === 'string' ? ['Lookup'] : []), ...(config.entityEvent ? ['EntityEvent'] : [])])
  ];

  // Read-only resources should not have POST/PATCH/DELETE routes. READ_ONLY makes every resource read-only.
  const readOnlyResources: ReadonlySet<string> = config.readOnly
    ? new Set(activeResources)
    : new Set([...(config.enumMode === 'string' ? ['Lookup'] : []), ...(config.entityEvent ? ['EntityEvent'] : [])]);

  const resourceSpecs = activeResources
    .map(resource => ({
      resourceName: resource,
      keyField: getKeyFieldForResource(resource),
      fields: getFieldsForResource(metadata, resource)
    }))
    .filter(spec => spec.fields.length > 0);

  // The resources actually served: those listed that have fields in the metadata. The service document, $metadata, the
  // routes and their navigation bindings all use this, so none of them can name a resource the others skipped.
  const servedResources: ReadonlyArray<string> = resourceSpecs.map(spec => spec.resourceName);
  for (const resource of activeResources.filter(name => !servedResources.includes(name))) {
    console.log(`  Not serving ${resource}: the metadata defines no fields for it.`);
  }

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
    if (!config.productionInstance) {
      console.log(`Initializing MongoDB collections and indexes for ${mongoSpecs.length} resources...`);
      await initializeMongoCollections(db, mongoSpecs);
      console.log('MongoDB initialization complete.');
    } else {
      console.log('MongoDB setup skipped (production instance).');
    }

    dal = createMongoDal(db);
    cleanupFn = () => {
      client.close();
    };
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
    if (!config.productionInstance) {
      const ddl = generateSqliteSchema(resourceSpecs);
      for (const stmt of ddl) {
        sqliteDb.exec(stmt);
      }
      console.log(`SQLite schema initialized (${ddl.length} statements).`);
    } else {
      console.log('SQLite schema setup skipped (production instance).');
    }

    dal = createSqliteDal(sqliteDb);
    cleanupFn = () => {
      sqliteDb.close();
    };
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
    if (!config.productionInstance) {
      const ddl = generateSchema(resourceSpecs);
      console.log(`Running migrations for ${resourceSpecs.length} resources...`);
      await runMigrations(pool, ddl);
      console.log('Database migrations complete.');
    } else {
      console.log('Database migrations skipped (production instance).');
    }

    dal = createPostgresDal(pool);
    cleanupFn = () => {
      pool.end();
    };
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

  // Auto-seed Lookup resource from metadata in string enum mode, except on a production instance, whose database is set up separately
  if (config.enumMode === 'string' && !config.productionInstance) {
    const seeded = await seedLookups(dal, metadata);
    if (seeded > 0) {
      console.log(`Seeded ${seeded} Lookup records from metadata.`);
    }
  }

  // Load auth configuration
  const authConfig = loadAuthConfig();

  // Generate EDMX metadata
  const edmxXml = generateEdmx(metadata, servedResources, config.enumMode);

  // Generate OpenAPI spec
  const openApiSpec = generateOpenApiSpec(metadata, servedResources, config.baseUrl);

  // Build Express app
  const app = express();
  app.disable('x-powered-by');
  // Trust the reverse proxy so req.protocol / req.hostname honor X-Forwarded-Proto / X-Forwarded-Host — lets
  // response links (@odata.context, @odata.nextLink, …) reflect the PUBLIC origin behind a proxy without any
  // static base-URL config. See resolveBaseUrl in odata/base-url.ts.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false }));

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
      '@odata.context': `${resolveBaseUrl(req, config.baseUrlOverride)}/$metadata`,
      value: servedResources.map(name => ({
        name,
        kind: 'EntitySet',
        url: name
      }))
    });
  });

  // OAuth2 mock token endpoint
  if (!config.productionInstance) app.use(createMockOAuthRouter());

  // SPA routing: when a UI is available, serve index.html for browser navigations
  // to resource paths (Accept: text/html). API requests (Accept: application/json) fall through to OData.
  if (options.uiDistPath && !config.productionInstance) {
    const spaIndexPath = resolve(options.uiDistPath, 'index.html');
    const resourceSet = new Set(servedResources);
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      const segment = req.path.split('/')[1];
      if (!segment || !resourceSet.has(segment)) return next();
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/html') && !accept.includes('application/json')) {
        res.sendFile(spaIndexPath);
        return;
      }
      next();
    });
  }

  // OData CRUD + collection routes (using DAL instead of direct pool access)
  const odataRouter = createODataRouter(metadata, dal, config.baseUrlOverride, servedResources, readOnlyResources);
  app.use(odataRouter);

  // Everything below up to the health check is the development tooling, not the OData service: a production instance leaves it out.
  if (!config.productionInstance) {
    // Admin endpoints (data generator, etc.)
    const adminRouter = createAdminRouter(metadata, dal, authConfig, readOnlyResources, activeResources);
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

      // Forward only under a service root this proxy allows (reso-tools #424).
      const decision = proxyPolicy.decide(targetUrl);
      if (!decision.allowed) {
        res
          .status(decision.reason === 'Invalid URL' || decision.reason.startsWith('Only http') ? 400 : 403)
          .json({ error: decision.reason });
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
        headers.Authorization = req.headers.authorization;
      }
      if (req.headers['content-type']) {
        headers['Content-Type'] = req.headers['content-type'];
      }

      const requestBody = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
        ? req.headers['content-type']?.includes('application/x-www-form-urlencoded')
          ? new URLSearchParams(req.body as Record<string, string>).toString()
          : JSON.stringify(req.body)
        : undefined;
      const firstOrigin = decision.url.origin;
      const { Authorization: _credentials, ...withoutCredentials } = headers;

      // Redirects are taken one hop at a time, each checked as a new request, and credentials go only to the origin the
      // caller asked for: a server cannot redirect them anywhere else.
      type Hop = { readonly response: Response } | { readonly refused: string };
      const follow = async (url: URL, method: string, body: string | undefined, hop: number): Promise<Hop> => {
        const response = await fetch(url, {
          method,
          headers: url.origin === firstOrigin ? headers : withoutCredentials,
          body,
          redirect: 'manual'
        });
        const location = response.headers.get('location');
        if (!isRedirect(response.status) || !location) return { response };
        if (hop >= MAX_PROXY_REDIRECTS) return { refused: `More than ${MAX_PROXY_REDIRECTS} redirects` };
        const next = proxyPolicy.decide(new URL(location, url).href);
        if (!next.allowed) return { refused: `The server redirected to a target this proxy does not forward to: ${next.reason}` };
        const nextMethod = redirectedMethod(response.status, method);
        return follow(next.url, nextMethod, nextMethod === 'GET' || nextMethod === 'HEAD' ? undefined : body, hop + 1);
      };

      try {
        const outcome = await follow(decision.url, req.method, requestBody, 0);
        if ('refused' in outcome) {
          res.set('Cache-Control', 'no-store');
          res.status(502).json({ error: outcome.refused });
          return;
        }
        const upstream = outcome.response;

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
        // The upstream could not be reached at all. Log why, and tell the client why: Node's fetch
        // only says "fetch failed" and keeps the real reason in its cause (see proxy-failure.ts).
        const failure = describeProxyFailure(err);
        console.error(proxyFailureLogLine(req.method, targetUrl, failure));
        res.status(502).json(failure);
      }
    });
  }

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: metadata.version });
  });

  // Serve built UI as SPA (must come after all API routes).
  // The catch-all uses express 4's `*` wildcard — earlier code used
  // express 5 syntax (`/{*path}`) which silently never matched, so
  // SPA routes outside the resource-aware middleware above (like
  // /cert/orgs/:uoi) returned the express default 404.
  if (options.uiDistPath && !config.productionInstance) {
    app.use(express.static(options.uiDistPath));
    const uiIndexPath = resolve(options.uiDistPath, 'index.html');
    app.get('*', async (req, res) => {
      // Only serve the SPA shell for browser navigation requests.
      // API calls (Accept: application/json, fetch requests without
      // text/html) should get a proper 404 instead of index.html.
      const accept = req.headers.accept ?? '';
      if (!accept.includes('text/html')) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.sendFile(uiIndexPath);
    });
  }

  const cleanup = (): void => {
    if (compactionTimer) clearInterval(compactionTimer);
    cleanupFn();
  };

  return {
    app,
    dal,
    cleanup,
    allowServiceRoot: root => proxyPolicy.allow(root),
    forgetServiceRoot: root => proxyPolicy.forget(root)
  };
};

/** Starts the server on the configured port. Returns the HTTP server instance. */
export const startServer = (app: express.Express, config: ServerConfig): Server =>
  app.listen(config.port, () => {
    console.log(`\nRESO Reference Server running at ${config.baseUrl}`);
    // A production instance serves no Swagger UI, so it does not advertise one.
    if (!config.productionInstance) console.log(`  API docs: ${config.baseUrl}/api-docs`);
    console.log(`  Metadata: ${config.baseUrl}/$metadata`);
    console.log(`  Health:   ${config.baseUrl}/health`);
  });

// Re-export config types and loader for consumers
export { loadConfig } from './config.js';
export type { ServerConfig, DbBackend, EnumMode } from './config.js';

// Metadata utilities and the DAL types, so a host embedding this server can
// mount its own routes against the same metadata and data access the built-in
// routes use. `AppInstance` already hands back the `dal`; these make it usable
// from outside without reaching into the package's internals, which the
// `exports` map blocks. The remaining metadata helpers a caller is likely to
// want -- getFieldsForResource, getKeyFieldForResource, getLookupsForType,
// isEnumType -- are already public from @reso-standards/reso-common, as are the
// ResoMetadata / ResoField / ResoLookup types.
export { TARGET_RESOURCES } from './metadata/types.js';
export { reconcileLookups } from './metadata/lookup-reconciler.js';
// The Lookup rows the metadata defines, as the seeder writes them: for a production instance's own sync, which keeps
// its Lookup rows in line with the metadata after the first seeding (the seeder fills only an empty table).
export { buildLookupRecords } from './metadata/lookup-seeder.js';
export type { DataAccessLayer, ResourceContext } from './db/data-access.js';
// The DAL takes a ResourceContext for every call, so a host writing through it needs to build one from the same metadata
// file the server loaded: for example a job that loads records into a production instance's database.
export { loadMetadata } from './metadata/loader.js';
export { buildResourceContext } from './metadata/resource-context.js';

// CLI entry point — only runs when executed directly (not when imported as library).
// Check argv only (not import.meta.url) to avoid false positives when bundled.
const isDirectExecution = process.argv[1]?.endsWith('/dist/index.js') === true;

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
