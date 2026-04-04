# @reso-standards/web-api-proxy

Lightweight CORS proxy and static file server for RESO web clients. Enables browser-based OData clients to connect to external servers that don't set CORS headers.

## What It Does

- **CORS Proxy** (`/api/proxy?url=<encoded>`) — Forwards requests to external OData servers, bypassing browser CORS restrictions. Supports all HTTP methods, forwards auth and content-type headers.
- **Health Check** (`/health`) — Returns `{ "status": "ok" }` so the web client can detect proxy availability.
- **Static File Serving** — Serves a built web UI with SPA fallback (all unknown routes serve `index.html`).

## Usage

### As a Standalone Server

```bash
# Install
npm install

# Build
npm run build

# Start (serves UI from a directory + proxy)
npm start -- --port 8888 --ui ../reso-web-client/dist

# Start (proxy only, no UI)
npm start -- --port 8888
```

### As a Library

```typescript
import { createProxyServer } from '@reso-standards/web-api-proxy';

const instance = await createProxyServer({
  port: 8888,
  uiDistPath: '../reso-web-client/dist',
});

console.log(`Proxy running at ${instance.url}`);
// instance.close() to shut down
```

### As Express Middleware

Mount the proxy on an existing Express app:

```typescript
import express from 'express';
import { createProxyMiddleware, createCorsMiddleware } from '@reso-standards/web-api-proxy';

const app = express();
app.use(createCorsMiddleware());
app.use(createProxyMiddleware());

// Add your own routes...
app.listen(8080);
```

This is how the RESO Reference Server and Desktop Client use it — the proxy middleware is mounted alongside OData routes on the same Express app.

## API

### `createProxyServer(options?)`

Creates and starts a standalone HTTP server.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `0` (random) | Port to listen on |
| `uiDistPath` | `string` | — | Path to built web UI files for static serving |
| `resources` | `string[]` | `[]` | OData resource names for SPA routing (e.g., `['Property', 'Member']`) |

Returns `Promise<ProxyServerInstance>` with `{ app, url, port, close }`.

### `createProxyMiddleware()`

Returns an Express router with `/health` and `/api/proxy` endpoints. Includes JSON and URL-encoded body parsers.

### `createCorsMiddleware()`

Returns Express middleware that sets `Access-Control-Allow-*` headers and handles `OPTIONS` preflight requests.

## Proxy Endpoint

```
ALL /api/proxy?url=<encoded-target-url>
```

**Request headers forwarded**: `Accept`, `Authorization`, `Content-Type`, `OData-Version`, `Prefer`

**Request body**: Forwarded for POST, PATCH, PUT. Handles both `application/json` and `application/x-www-form-urlencoded` (used by OAuth2 token endpoints).

**Response**: Upstream status code, `Content-Type`, and `OData-Version` headers are forwarded. `Cache-Control: no-store` is added to prevent stale browser caching.

**Error responses**:
- `400` — Missing or invalid `url` parameter, non-http(s) protocol
- `502` — Network error reaching the target server

## Security

- Only `http:` and `https:` URLs are allowed (SSRF protection)
- No private network filtering (suitable for development and trusted environments)

## License

See [LICENSE](../LICENSE) in the repository root.
