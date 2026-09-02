# RESO Tools

![Tests](https://img.shields.io/badge/tests-1963%20passed-brightgreen)
![Compliance](https://img.shields.io/badge/RESO%20compliance-4%2F4%20suites-blue)
[![Download](https://img.shields.io/github/v/release/RESOStandards/reso-tools?label=download&color=blue)](https://github.com/RESOStandards/reso-tools/releases/latest)

Open-source toolkit for building and testing [RESO](https://www.reso.org/)-compliant OData servers. This repository holds the reference server, the certification test runner (`reso-cert`), an MCP server for AI agents, and the shared libraries for OData parsing, metadata processing and validation – all published to npm so any project can consume them without the monorepo. The desktop certification app (which bundles a reference server and a local test-data UI) is built separately and distributed here as a downloadable [release](https://github.com/RESOStandards/reso-tools/releases/latest).

## Packages

| Package | Description | Tests |
|---------|-------------|-------|
| [`reso-common/`](reso-common/) | Universal (browser + Node) RESO metadata model and projections – the shared `ResoMetadata` shape, pure helpers and EDMX generator (zero runtime dependencies) | 16 |
| [`reso-metadata-utils/`](reso-metadata-utils/) | RESO OData metadata processing – CSDL parse + validate (CSDL/XSD), EDMX → metadata-report serialization, live metadata fetching (the deps-requiring side of the metadata split) | 108 |
| [`reso-client/`](reso-client/) | OData 4.01 client SDK -- URI builder, CRUD helpers, CSDL metadata parsing, OAuth2 Client Credentials | 116 |
| [`odata-expression-parser/`](odata-expression-parser/) | Zero-dependency `$filter` and `$expand` expression parser | 180 |
| [`reso-validation/`](reso-validation/) | Isomorphic field and business-rule validation for RESO Data Dictionary records | 98 |
| [`reso-reference-server/`](reso-reference-server/) | Metadata-driven OData reference server (PostgreSQL, MongoDB, SQLite) | 265 |
| [`reso-certification/`](reso-certification/) | RESO Certification CLI + SDK – Add/Edit, EntityEvent, Web API Core, Data Dictionary + RCP-010 schema/replicate/variations ([docs](reso-certification/README.md)) | 816 |
| [`reso-mcp-server/`](reso-mcp-server/) | MCP server – exposes OData query, write, validation, certification tools for AI agents ([guide](reso-mcp-server/doc/GUIDE.md)) | 21 |

## Quick Start

### Bootstrap (Full Build)

Build everything from a fresh clone with a single command:

```bash
npm run bootstrap        # builds only packages that need it
npm run bootstrap:force  # rebuilds everything from scratch
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

A cross-platform desktop app (macOS, Windows, Linux) runs the full certification suite – Data Dictionary, Web API Core, Add/Edit, EntityEvent – against any OData server, with a bundled reference server and browser UI for local test data. It is built separately (it consumes the public packages above from npm) and published here as a downloadable build – download the latest from [Releases](https://github.com/RESOStandards/reso-tools/releases/latest).

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

# Lint + typecheck + tests — run before every commit
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

# Data Dictionary 2.0
docker compose --profile compliance-dd up --build --exit-code-from compliance-dd

# Web API Core 2.0.0
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
