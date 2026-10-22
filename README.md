# RESO Tools

![Tests](https://img.shields.io/badge/tests-2953%20passed-brightgreen)
![Compliance](https://img.shields.io/badge/RESO%20compliance-4%2F4%20suites-blue)
[![Release](https://img.shields.io/github/v/release/RESOStandards/reso-tools?label=release&color=blue)](https://github.com/RESOStandards/reso-tools/releases/latest)

**Download the desktop app** &nbsp;
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple&logoColor=white)](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-mac-arm64.dmg)
[![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white)](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-win-x64.exe)
[![Linux AppImage](https://img.shields.io/badge/Linux-AppImage-FCC624?logo=linux&logoColor=black)](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-linux-x86_64.AppImage)
[![Linux deb](https://img.shields.io/badge/Linux-.deb-A81D33?logo=debian&logoColor=white)](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-linux-amd64.deb)

Open-source toolkit for building and testing [RESO](https://www.reso.org/)-compliant OData servers. This repository holds the reference server, the certification test runner (`reso-cert`), an MCP server for AI agents and the shared libraries for OData parsing, metadata processing and validation. Seven of the eight packages publish to npm, so any project can consume them without the monorepo. The MCP server is not published and runs from this repository. The desktop certification app (which bundles a reference server and a local test-data UI) is built separately and distributed here as a downloadable [release](https://github.com/RESOStandards/reso-tools/releases/latest).

## Packages

| Package | Description | Tests |
|---------|-------------|-------|
| [`reso-common/`](reso-common/) | Universal (browser + Node) RESO metadata model and projections – the shared `ResoMetadata` shape, pure helpers and EDMX generator (zero runtime dependencies) | 41 |
| [`reso-metadata-utils/`](reso-metadata-utils/) | RESO OData metadata processing – CSDL parse + validate (CSDL/XSD), EDMX → metadata-report serialization, live metadata fetching (the deps-requiring side of the metadata split) | 160 |
| [`reso-client/`](reso-client/) | OData 4.01 client SDK – URI builder, CRUD helpers, CSDL metadata parsing, OAuth2 Client Credentials | 211 |
| [`odata-expression-parser/`](odata-expression-parser/) | Zero-dependency `$filter` and `$expand` expression parser | 180 |
| [`reso-validation/`](reso-validation/) | Isomorphic field and business-rule validation for RESO Data Dictionary records | 98 |
| [`reso-reference-server/`](reso-reference-server/) | Metadata-driven OData reference server (PostgreSQL, MongoDB, SQLite) | 286 |
| [`reso-certification/`](reso-certification/) | RESO Certification CLI + SDK – Add/Edit (RCP-010), EntityEvent (RCP-027), Web API Core and Data Dictionary, plus per-step utilities for metadata, schema, replication and variations ([docs](reso-certification/README.md)) | 1834 |
| [`reso-mcp-server/`](reso-mcp-server/) | MCP server – exposes OData query, write, validation, certification tools for AI agents ([guide](reso-mcp-server/doc/GUIDE.md)) | 101 |

## Quick Start

### Bootstrap (Full Build)

Build everything from a fresh clone with a single command:

```bash
npm run bootstrap
```

This installs dependencies and builds all 8 packages in the correct order. Takes about 30 seconds on a warm cache.

### Reference Server (Docker)

```bash
cd reso-reference-server
docker compose up -d
docker compose --profile seed up seed
# Server: http://localhost:8080
```

### Desktop Certification App

A cross-platform desktop app (macOS, Windows, Linux) runs the full certification suite – Data Dictionary, Web API Core, Add/Edit, EntityEvent – against any OData server, with a bundled reference server and browser UI for local test data. It is built separately, consuming the public packages above from npm, and published here as a downloadable build.

| Platform | Download | Roll back one version | Notes |
|---|---|---|---|
| macOS (Apple Silicon) | [`.dmg`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-mac-arm64.dmg) · [`.zip`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-mac-arm64.zip) | [`.dmg`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-mac-arm64-previous.dmg) | Signed and notarized |
| Windows (x64) | [`.exe`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-win-x64.exe) | [`.exe`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-win-x64-previous.exe) | Authenticode signed |
| Linux | [`.AppImage`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-linux-x86_64.AppImage) · [`.deb`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-linux-amd64.deb) | [`.AppImage`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-linux-x86_64-previous.AppImage) · [`.deb`](https://github.com/RESOStandards/reso-tools/releases/latest/download/reso-linux-amd64-previous.deb) | `chmod +x` the AppImage before first run |

Every link above is a permalink. The asset names carry no version, so they keep resolving to the newest release without the README going stale. The **roll back** column is the version immediately before it, carried forward into each release so a bad update has a one-click way out. For anything further back, see [all releases](https://github.com/RESOStandards/reso-tools/releases).

The app updates itself, so a manual download is only needed for a first install or a deliberate rollback.

### Building Individual Packages

The repo is an **npm workspace**. `npm install` at the root installs every package's dependencies once and links the inter-package deps locally; `npm run build` builds all packages in dependency order.

```bash
npm install                            # install + link all workspaces
npm run build                          # build all (topological order)
npm run build -w reso-certification    # or build just one
```

Each package still builds and tests independently (`cd reso-certification && npm run build`) – the workspace linking resolves its inter-package deps from the local packages. The public packages publish to npm with `^` version ranges, so a consumer installs them from the registry without the monorepo.

## Development

```bash
# Lint (Biome)
npm run lint

# Typecheck every package
npm run typecheck

# Run all tests
npm test

# Run tests for a single package
npm run test:common
npm run test:metadata-utils
npm run test:client
npm run test:validation
npm run test:filter-parser
npm run test:server
npm run test:certification
npm run test:mcp

# Lint + typecheck + tests – run before every commit
npm run precommit
```

The root `package.json` provides convenience scripts for linting, typechecking and testing. Each package manages its own dependencies and build.

### Certification Testing

Test any RESO OData server from the command line:

```bash
# Add/Edit
reso-cert add-edit --url http://localhost:8080 --auth-token TOKEN

# EntityEvent
reso-cert entity-event --url http://localhost:8080 --auth-token TOKEN

# Web API Core
reso-cert core --url http://localhost:8080 --auth-token TOKEN

# Data Dictionary
reso-cert dd --url http://localhost:8080 --auth-token TOKEN
```

Or run compliance suites against the reference server via Docker:

```bash
cd reso-reference-server
docker compose up -d --build --wait db server

# Data Dictionary 2.0 – the version the reference server serves
docker compose --profile compliance-dd up --build --exit-code-from compliance-dd

# Web API Core 2.1.0
docker compose --profile compliance-core up --build --exit-code-from compliance-core

# Add/Edit RCP-010
docker compose --profile compliance-addedit up --build --exit-code-from compliance-addedit

# EntityEvent RCP-027
docker compose --profile compliance-entity-event up --build --exit-code-from compliance-entity-event

# MCP server smoke test
docker compose --profile compliance-mcp up --build --exit-code-from compliance-mcp
```

See [`reso-certification/`](reso-certification/) for full documentation.

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE).
