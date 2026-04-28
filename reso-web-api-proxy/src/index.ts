/**
 * Lightweight CORS proxy and static file server for RESO web clients.
 *
 * Can be used in three contexts:
 * 1. Electron desktop — serves web UI and proxies external OData requests
 * 2. Standalone deployment — hosts the web client with proxy support
 * 3. Alongside the reference server — mounted as middleware on the same Express app
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { resolve } from 'node:path';

/** Options for creating the proxy server. */
export interface ProxyServerOptions {
  /** Port to listen on. Pass 0 for a random available port. */
  readonly port?: number;
  /** Path to the built web UI files. If provided, serves static files and SPA fallback. */
  readonly uiDistPath?: string;
  /** Resource names for SPA routing (browser navigation to /Property serves index.html). */
  readonly resources?: ReadonlyArray<string>;
}

/** Result of starting the proxy server. */
export interface ProxyServerInstance {
  readonly app: Express;
  readonly url: string;
  readonly port: number;
  readonly close: () => void;
}

/** Headers to forward from client to upstream. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'odata-version', 'authorization', 'content-type', 'prefer'] as const;

/**
 * Create the proxy middleware and mount it on an Express app.
 * This can be used standalone or added to an existing Express app.
 */
export const createProxyMiddleware = (): express.Router => {
  const router = express.Router();

  router.use(express.json({ limit: '10mb' }));
  router.use(express.urlencoded({ extended: false }));

  // Health check
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // CORS proxy — forwards requests to external OData servers
  router.all('/api/proxy', async (req: Request, res: Response) => {
    const targetUrl = req.query.url as string | undefined;
    if (!targetUrl) {
      res.status(400).json({ error: 'Missing required query parameter: url' });
      return;
    }

    // Validate URL — SSRF protection
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

    // Build upstream headers
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (!headers['accept']) headers['accept'] = 'application/json';

    // Forward body for write methods. DELETE is included because some
    // backends (e.g. v2/locks) take the resource identifiers in the body
    // rather than the URL — and Express has already parsed JSON bodies
    // for us regardless of method.
    const hasBody = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    const body = hasBody
      ? (req.headers['content-type']?.includes('application/x-www-form-urlencoded')
        ? new URLSearchParams(req.body as Record<string, string>).toString()
        : JSON.stringify(req.body))
      : undefined;

    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
      });

      // Prevent browser caching of proxy responses
      res.set('Cache-Control', 'no-store');

      // Forward status and key headers
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.set('Content-Type', contentType);
      const odataVersion = upstream.headers.get('odata-version');
      if (odataVersion) res.set('OData-Version', odataVersion);

      const responseBody = await upstream.text();
      res.send(responseBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Proxy request failed';
      res.status(502).json({ error: message });
    }
  });

  return router;
};

/**
 * Create CORS headers middleware.
 */
export const createCorsMiddleware = (): ((req: Request, res: Response, next: NextFunction) => void) =>
  (_req: Request, res: Response, next: NextFunction) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Prefer, OData-Version');
    res.set('Access-Control-Expose-Headers', 'OData-Version');
    if (_req.method === 'OPTIONS') {
      res.status(204).send();
      return;
    }
    next();
  };

/**
 * Create and start a standalone proxy server.
 * Serves the web UI (if uiDistPath provided) and proxies external requests.
 */
export const createProxyServer = (options: ProxyServerOptions = {}): Promise<ProxyServerInstance> => {
  const { port = 0, uiDistPath, resources = [] } = options;
  const app = express();

  app.disable('x-powered-by');
  app.use(createCorsMiddleware());
  app.use(createProxyMiddleware());

  // Serve web UI static files + SPA routing
  if (uiDistPath) {
    const resolvedUiPath = resolve(uiDistPath);
    const resourceSet = new Set(resources);

    // SPA routing: serve index.html for browser navigation to resource paths
    if (resourceSet.size > 0) {
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET') return next();
        const segment = req.path.split('/')[1];
        if (!segment || !resourceSet.has(segment)) return next();
        const accept = req.headers.accept ?? '';
        if (accept.includes('text/html') && !accept.includes('application/json')) {
          res.sendFile(resolve(resolvedUiPath, 'index.html'));
          return;
        }
        next();
      });
    }

    app.use(express.static(resolvedUiPath));

    // SPA catch-all: unknown routes serve index.html
    app.get('/{*path}', (_req: Request, res: Response) => {
      res.sendFile(resolve(resolvedUiPath, 'index.html'));
    });
  }

  return new Promise((resolvePromise) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const assignedPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://localhost:${assignedPort}`;

      resolvePromise({
        app,
        url,
        port: assignedPort,
        close: () => server.close(),
      });
    });
  });
};
