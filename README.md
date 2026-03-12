# RESO Tools

Open-source toolkit for building and testing [RESO](https://www.reso.org/)-compliant OData servers. Includes a reference server, desktop client, web UI, certification test runner and shared libraries for OData parsing, validation and data generation.

## Packages

| Package | Description |
|---------|-------------|
| [`odata-client/`](odata-client/) | OData 4.01 client SDK -- URI builder, CRUD helpers, CSDL metadata parsing |
| [`odata-expression-parser/`](odata-expression-parser/) | Zero-dependency `$filter` and `$expand` expression parser |
| [`validation/`](validation/) | Isomorphic field and business-rule validation for RESO Data Dictionary records |
| [`data-generator/`](data-generator/) | Realistic test data generator with FK dependency resolution |
| [`reso-reference-server/`](reso-reference-server/) | Metadata-driven OData reference server (PostgreSQL, MongoDB, SQLite) |
| [`reso-web-client/`](reso-web-client/) | React + Vite browser UI for browsing and editing OData resources |
| [`reso-desktop-client/`](reso-desktop-client/) | Electron desktop shell wrapping the server and web UI |
| [`certification/`](certification/) | RESO certification test runner (Add/Edit, Web API Core, Data Dictionary) |

## Quick Start

```bash
# Prerequisites: Node.js >= 22, Docker (for the reference server database)

# Start the reference server with Docker
cd reso-reference-server
docker compose up -d
docker compose --profile seed up seed
# Server: http://localhost:8080  UI: http://localhost:5173

# Or run the desktop client (SQLite, no Docker required)
cd ../reso-reference-server && npm install && npm run build
cd ../reso-desktop-client && npm install && npm run dev
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

## License

See [License.txt](License.txt).
