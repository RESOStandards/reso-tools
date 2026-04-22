# RESO Tools

![Tests](https://img.shields.io/badge/tests-1319%20passed-brightgreen)
![Compliance](https://img.shields.io/badge/RESO%20compliance-4%2F4%20suites-blue)
[![Download](https://img.shields.io/github/v/release/RESOStandards/reso-tools?label=download&color=blue)](https://github.com/RESOStandards/reso-tools/releases/latest)

Open-source toolkit for building and testing [RESO](https://www.reso.org/)-compliant OData servers. Includes a reference server, desktop client, web UI, certification test runner, MCP server for AI agents and shared libraries for OData parsing, validation and data generation.

## Packages

| Package | Description | Tests |
|---------|-------------|-------|
| [`reso-client/`](reso-client/) | OData 4.01 client SDK -- URI builder, CRUD helpers, CSDL metadata parsing, OAuth2 Client Credentials | 118 |
| [`odata-expression-parser/`](odata-expression-parser/) | Zero-dependency `$filter` and `$expand` expression parser | 180 |
| [`reso-validation/`](reso-validation/) | Isomorphic field and business-rule validation for RESO Data Dictionary records | 98 |
| [`reso-data-generator/`](reso-data-generator/) | Realistic test data generator with geo-consistent addresses, relational integrity and field-aware bounds | 116 |
| [`reso-reference-server/`](reso-reference-server/) | Metadata-driven OData reference server (PostgreSQL, MongoDB, SQLite) | 254 |
| [`reso-web-client/`](reso-web-client/) | React + Vite browser UI with cert analytics, server explorer and performance reports | 138 |
| [`reso-web-api-proxy/`](reso-web-api-proxy/) | Lightweight CORS proxy and static file server for web client deployments | -- |
| [`reso-desktop-client/`](reso-desktop-client/) | Electron desktop shell with end-to-end certification testing (DD, Core, Add/Edit, EntityEvent), secure storage and bundled reference server | -- |
| [`reso-certification/`](reso-certification/) | RESO certification CLI + SDK – Add/Edit, EntityEvent, Web API Core, DD ([docs](reso-certification/README.md)) | 272 |
| [`reso-mcp-server/`](reso-mcp-server/) | MCP server – exposes OData query, write, validation, certification tools for AI agents ([guide](reso-mcp-server/doc/GUIDE.md)) | 21 |

## Quick Start

### Reference Server (Docker)

```bash
cd reso-reference-server
docker compose up -d
docker compose --profile seed up seed
# Server: http://localhost:8080  UI: http://localhost:5173
```

### Desktop Client (SQLite, No Docker)

```bash
cd reso-reference-server && npm install && npm run build
cd ../reso-web-client && npm install && npm run build
cd ../reso-desktop-client && npm install && npm run dev
```

The desktop client connects to external OData servers out of the box. The reference server starts in the background for local test data.

### Web Client with Proxy (No Reference Server)

```bash
cd reso-web-api-proxy && npm install && npm run build
npm start -- --port 8888 --ui ../reso-web-client/dist
```

Or with Docker:

```bash
cd reso-web-client
docker compose --profile proxy up -d
# UI + Proxy: http://localhost:8888
```

## Development

```bash
# Lint (Biome)
npm run lint

# Run all tests
npm test

# Run tests for a single package
npm run test:server
npm run test:client
npm run test:validation
npm run test:filter-parser
npm run test:data-generator
npm run test:certification
npm run test:mcp
```

The root `package.json` provides convenience scripts for linting and testing. Each package manages its own dependencies and build.

### Pre-commit Hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs Biome lint, type checking and tests on every commit.

```bash
npm install           # installs Biome + Lefthook
npx lefthook install  # activates git hooks
```

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
