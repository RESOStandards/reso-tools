# RESO Tools

Testing, client SDK, and reference implementation tools for the RESO Web API specification.

## Packages

### Libraries

#### [@reso/validation](validation/)

Isomorphic validation library for RESO metadata-driven field validation. Works in any JS runtime (Node.js, browser, edge). Used by both the reference server API and the React UI.

```bash
cd validation && npm install && npm test  # 103 tests
```

#### [@reso/odata-expression-parser](odata-expression-parser/)

Standalone, zero-dependency library for parsing OData 4.01 `$filter` expressions into a typed AST. Used by both the client SDK (query validation) and the reference server (SQL translation).

```bash
cd odata-expression-parser && npm install && npm test  # 180 tests
```

#### [@reso/odata-client](odata-client/)

OData 4.01 client SDK for TypeScript. URI builder, CRUD helpers, CSDL metadata parsing/validation, query validation, and response parsing. Inspired by Apache Olingo.

```bash
cd odata-client && npm install && npm test  # 118 tests
```

### Tools

#### [@reso/data-generator](data-generator/)

Generates realistic RESO Data Dictionary test data. Supports three output modes: HTTP (POST to an OData server), JSON files, and curl script generation. Includes resource-specific generators for Property, Member, Office, Media, OpenHouse, and Showing with domain-appropriate values.

```bash
cd data-generator && npm install && npm test  # 104 tests

# Interactive CLI
npx reso-data-generator

# Non-interactive
npx reso-data-generator -r Property -n 50 --related Media:5,OpenHouse:2 -t admin-token

# Generate JSON files
npx reso-data-generator -r Property -n 10 -f json -o ./seed-data

# Generate curl seed script
npx reso-data-generator -r Property -n 10 -f curl -o ./seed.sh -t admin-token
```

#### [certification/](certification/)

RESO certification testing tools. Each subdirectory implements an independent certification module.

##### [certification/add-edit/](certification/add-edit/) — Web API Add/Edit (RCP-010)

Compliance testing tool for the RESO Web API Add/Edit Endorsement. Validates OData CRUD operations against 8 Gherkin BDD certification scenarios.

```bash
cd certification && npm install && npm test  # 102 tests

# Run against a server
npx reso-cert-add-edit \
  --url https://api.example.com \
  --resource Property \
  --payloads ./sample-payloads \
  --auth-token <token>

# Run against the built-in mock server
npx reso-cert-add-edit \
  --url http://localhost:8800 \
  --resource Property \
  --payloads ./sample-payloads \
  --auth-token test \
  --mock
```

#### [@reso/desktop-client](reso-desktop-client/)

Electron desktop client for the RESO Reference Server. Wraps the server and UI into a native macOS/Windows/Linux application with native menus, keyboard shortcuts (Cmd/Ctrl+Arrow, Cmd/Ctrl+[/]), and trackpad navigation gestures.

```bash
cd reso-desktop-client && npm install && npm run dev
```

#### [@reso/web-client](reso-web-client/)

React + Vite OData browser UI with server switcher for connecting to external OData servers, metadata explorer, and CRUD interface. Can be deployed standalone or served by the reference server.

```bash
cd reso-web-client && npm install && npm run dev
```

#### [reso-reference-server](reso-reference-server/)

Metadata-driven OData 4.01 reference server backed by PostgreSQL, MongoDB, or SQLite. Reads the RESO Data Dictionary JSON metadata and dynamically generates database tables, OData CRUD endpoints, EDMX metadata, and OpenAPI documentation for 14 RESO resources.

**Build and run with Docker:**

```bash
cd reso-reference-server
docker-compose up -d

# Verify
curl http://localhost:8080/health
curl http://localhost:8080/\$metadata
open http://localhost:8080/api-docs
```

**Build and run locally (requires PostgreSQL):**

```bash
cd reso-reference-server
npm install
npm run build
npm start
npm test  # 254 tests
```

**Seed with test data:**

```bash
# Docker
cd reso-reference-server
docker-compose --profile seed up

# Local (with server running)
./seed.sh
./seed.sh http://localhost:8080 admin-token
```

## Build Order

Packages have `file:` dependencies. Build in this order:

1. `validation` — no dependencies
2. `odata-expression-parser` — no dependencies
3. `odata-client` — depends on `odata-expression-parser`
4. `data-generator` — no package dependencies (uses metadata from server at runtime)
5. `reso-reference-server` — depends on `validation` + `odata-expression-parser` + `data-generator`
6. `certification/test-runner` — depends on `odata-client` + `validation`
7. `certification/add-edit` — depends on `certification/test-runner` + `odata-client` + `validation`

## Development

### Linting and Formatting

The codebase uses [Biome](https://biomejs.dev/) for linting and formatting, configured to match the [RESO certification-utils](https://github.com/RESOStandards/reso-certification-utils) style (single quotes, semicolons, no trailing commas, 140 char line width).

```bash
# From the repo root
npm run lint          # Check for lint/format issues
npm run lint:fix      # Auto-fix issues
```

### Pre-commit Hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs pre-commit hooks automatically on every `git commit`:

1. **Lint + auto-fix** — Biome checks and fixes staged `.ts`/`.tsx` files, re-stages fixes
2. **Type check** — `tsc --noEmit` in all packages (respecting build order)
3. **Tests** — `vitest run` in all packages

To set up after cloning:

```bash
npm install           # installs biome + lefthook
npx lefthook install  # activates git hooks
```

## Cross-Tool Validation

Run the compliance tests against the reference server:

```bash
# Start the reference server
cd reso-reference-server && docker-compose up -d

# Run compliance tests
cd ../certification/add-edit
npx reso-cert-add-edit \
  --url http://localhost:8080 \
  --resource Property \
  --payloads ./sample-payloads \
  --auth-token test
```
