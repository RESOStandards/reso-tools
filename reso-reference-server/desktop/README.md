# @reso/desktop

Electron desktop client for the RESO Reference Server. Runs the server and UI as a native application on macOS, Windows, and Linux.

## Quick Start

```bash
npm install
npm run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Build and launch in development mode |
| `npm start` | Launch from pre-built `dist/` |
| `npm run build` | Compile TypeScript and copy server entry |
| `npm run package` | Build and package with electron-builder |

## Architecture

The desktop client uses a dual-process architecture:

- **Main process** (CJS) — Electron window management, native menus, navigation gestures
- **Server child process** (ESM) — Runs the reference server via `child_process.fork()` with system Node.js to avoid Electron's CJS/ESM interop issues

The server starts on a random available port and communicates readiness back to the main process via IPC.

## Features

- Native macOS/Windows/Linux menus (File, Edit, View, Navigate, Window, Help)
- Keyboard navigation: Cmd/Ctrl+[/] and Cmd/Ctrl+Arrow for back/forward
- Trackpad gestures: two-finger scroll and three-finger swipe navigation
- RESO-branded app icons (.icns for macOS, .ico for Windows, .png for Linux)
- SQLite backend with persistent storage in the user data directory
- External links open in the system browser

## Packaging

```bash
npm run package
```

Builds a distributable application using electron-builder. Configuration is in `package.json` under the `build` key. The packaged app bundles the server, metadata, UI, and all dependencies.
