# RESO Tools

![Tests](https://img.shields.io/badge/tests-928%20passed-brightgreen)
![Compliance](https://img.shields.io/badge/RESO%20compliance-4%2F4%20suites-blue)

Open-source toolkit for building and testing [RESO](https://www.reso.org/)-compliant OData servers. Includes a reference server, desktop client, web UI, CORS proxy, certification test runner and shared libraries for OData parsing, validation and data generation.

## Packages

| Package | Description | Tests |
|---------|-------------|-------|
| [`reso-client/`](reso-client/) | OData 4.01 client SDK -- URI builder, CRUD helpers, CSDL metadata parsing, OAuth2 Client Credentials | 118 |
| [`odata-expression-parser/`](odata-expression-parser/) | Zero-dependency `$filter` and `$expand` expression parser | 180 |
| [`validation/`](validation/) | Isomorphic field and business-rule validation for RESO Data Dictionary records | 98 |
| [`data-generator/`](data-generator/) | Realistic test data generator with FK dependency resolution | 104 |
| [`reso-reference-server/`](reso-reference-server/) | Metadata-driven OData reference server (PostgreSQL, MongoDB, SQLite) | 254 |
| [`reso-web-client/`](reso-web-client/) | React + Vite browser UI for browsing and editing OData resources | 72 |
| [`reso-web-api-proxy/`](reso-web-api-proxy/) | Lightweight CORS proxy and static file server for web client deployments | -- |
| [`reso-desktop-client/`](reso-desktop-client/) | Electron desktop shell with native proxy, secure storage and optional reference server | -- |
| [`certification/`](certification/) | RESO certification test runner (Add/Edit, Web API Core, DD, EntityEvent) | 102 |

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
```

The root `package.json` provides convenience scripts for linting and testing. Each package manages its own dependencies and build.

### Pre-commit Hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs Biome lint, type checking and tests on every commit.

```bash
npm install           # installs Biome + Lefthook
npx lefthook install  # activates git hooks
```

### Compliance Testing

Four compliance suites run against the reference server via Docker:

```bash
cd reso-reference-server
docker compose up -d --build --wait db server
docker compose --profile seed up seed

# Data Dictionary 2.0
docker compose --profile compliance-dd up --build --exit-code-from compliance-dd compliance-dd

# Web API Core 2.0.0
docker compose --profile compliance-core up --build --exit-code-from compliance-core compliance-core

# Add/Edit RCP-010
docker compose --profile compliance-addedit up --build --exit-code-from compliance-addedit db-addedit server-addedit compliance-addedit

# EntityEvent RCP-027
docker compose --profile compliance-entity-event up --build --exit-code-from compliance-entity-event db-entity-event server-entity-event compliance-entity-event
```

## License

See [LICENSE](LICENSE).
