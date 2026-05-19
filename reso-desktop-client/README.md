# @reso-standards/desktop-client

Electron desktop application for browsing any RESO-compliant OData server. Connects to external servers out of the box with OAuth2 Client Credentials or Bearer Token authentication. Optionally runs the built-in reference server for local test data.

> **[User Guide](doc/GUIDE.md)** – a task-oriented walkthrough with realistic examples.

## Quick Start

This package isn't on npm yet. Install from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo on GitHub:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-desktop-client
npm install
npm run dev
```

The `preinstall` hook walks the `file:` dep tree and builds sibling packages this one depends on (`reso-certification`, `reso-reference-server`, `reso-web-api-proxy` — and their transitive deps) before the install proceeds. The `postinstall` hook rebuilds native modules (e.g., `better-sqlite3`) for Electron's Node.js version. To bootstrap every package at once, run `npm run bootstrap` from the repo root instead.

The desktop client starts immediately and connects to external servers via the built-in CORS proxy. The reference server starts in the background for local test data.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Build and launch in development mode |
| `npm start` | Launch from pre-built `dist/` |
| `npm run build` | Compile TypeScript and copy server entry |
| `npm run build:server-bundle` | Bundle server code with esbuild for packaging |
| `npm run package` | Build, bundle, and package with electron-builder |

## Architecture

The desktop client uses a dual-process architecture:

- **Main process** (CJS) – Electron window management, native menus, navigation gestures, secure storage
- **Server child process** (ESM) – Tries the full reference server first, falls back to the lightweight web-api-proxy when unavailable

The server starts on a random available port and communicates readiness back to the main process via IPC.

## Features

- **OAuth2 Client Credentials and Bearer Token** authentication with per-server token storage
- **Metadata caching** – CSDL schemas cached in IndexedDB with gzip compression (24-hour TTL)
- **Lazy lookup loading** – Enum values fetched on demand, not upfront
- Native macOS/Windows/Linux menus (File, Edit, View, Navigate, Window, Help)
- Keyboard navigation: Cmd/Ctrl+[/] and Cmd/Ctrl+Arrow for back/forward
- Trackpad gestures: two-finger scroll and three-finger swipe navigation
- SQLite backend with persistent storage in the user data directory
- Diagnostic logging to `~/Library/Application Support/RESO Desktop Client/reso-desktop.log`

## Connection Storage

Server connections are persisted to disk:

```
~/Library/Application Support/RESO Desktop Client/secure-storage.json
```

In a signed/packaged build, connection data (including tokens) is encrypted at rest using Electron's `safeStorage` API (macOS Keychain, Windows DPAPI, Linux libsecret).

**Development note:** In `npm run dev` mode, `safeStorage` encryption is unavailable because the app is not code-signed. Connections are stored as plain JSON.

## Prerequisites

- Node.js >= 22
- No Docker required – the desktop client uses an embedded SQLite database

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
