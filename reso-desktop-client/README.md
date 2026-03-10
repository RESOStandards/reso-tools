# @reso-standards/desktop-client

Electron desktop client for the RESO Reference Server. Runs the server and UI as a native application on macOS, Windows, and Linux.

## Quick Start

The desktop client depends on the reference server (`file:../reso-reference-server`), which must be built first:

```bash
# 1. Build the reference server (required — provides the embedded OData server)
cd ../reso-reference-server && npm install && npm run build && cd ../reso-desktop-client

# 2. Install desktop client dependencies (runs electron-rebuild automatically)
npm install

# 3. Launch
npm run dev
```

This builds the TypeScript, starts the reference server on a random port, and opens the UI in an Electron window.

> **Note:** `npm install` automatically rebuilds native modules (e.g. `better-sqlite3`) for Electron's Node.js version via the `postinstall` script. If you see a `NODE_MODULE_VERSION` mismatch error, re-run `npm install`.

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

- **Main process** (CJS) — Electron window management, native menus, navigation gestures
- **Server child process** (ESM) — Runs the reference server via `child_process.fork()` using Electron's bundled Node.js with `ELECTRON_RUN_AS_NODE=1`

The server starts on a random available port and communicates readiness back to the main process via IPC.

### Packaging

For distribution, the server and all its pure JS dependencies are bundled into a single file using esbuild. Native modules (`better-sqlite3`) and static assets (`swagger-ui-dist`) are copied alongside the bundle as external dependencies. This avoids the `file:` dependency hoisting issues that prevent electron-builder from finding the server's transitive dependencies.

```bash
npm run package
```

Builds a distributable application using electron-builder. Configuration is in `package.json` under the `build` key.

**Note:** The packaged binary requires macOS code signing to run on macOS 16 (Tahoe) and later. Ad-hoc signatures are rejected by Gatekeeper. Use `npm run dev` for local development and testing.

## Features

- Native macOS/Windows/Linux menus (File, Edit, View, Navigate, Window, Help)
- Keyboard navigation: Cmd/Ctrl+[/] and Cmd/Ctrl+Arrow for back/forward
- Trackpad gestures: two-finger scroll and three-finger swipe navigation
- RESO-branded app icons (.icns for macOS, .ico for Windows, .png for Linux)
- SQLite backend with persistent storage in the user data directory
- Persistent server connections across restarts (see [Connection Storage](#connection-storage))
- External links open in the system browser
- Diagnostic logging to `~/Library/Application Support/RESO Desktop Client/reso-desktop.log`

## Connection Storage

Server connections added via the connection manager are persisted to disk in the desktop client so they survive app restarts. The storage file is located at:

```
~/Library/Application Support/RESO Desktop Client/secure-storage.json
```

In a signed/packaged build, connection data (including bearer tokens) is encrypted at rest using Electron's `safeStorage` API, which delegates to the OS credential store (macOS Keychain, Windows DPAPI, Linux libsecret).

**Development note:** In `npm run dev` mode, `safeStorage` encryption is unavailable because the app is not code-signed. Connections are still persisted but stored as **plain JSON**. Avoid saving real credentials when running in dev mode.

The web UI uses browser `localStorage` instead — connections are ephemeral and do not persist across browser restarts.
