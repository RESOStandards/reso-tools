# RESO Reference OData Server

A metadata-driven OData 4.01 reference server for the [RESO Data Dictionary](https://www.reso.org/data-dictionary/). Reads the RESO JSON metadata format and dynamically generates PostgreSQL tables, OData CRUD endpoints, EDMX metadata and OpenAPI documentation.

> **[User Guide](doc/GUIDE.md)** – a task-oriented walk-through with realistic examples.

> **Use it as a package.** Also published to npm as `@reso-standards/reso-reference-server` – import `createApp`, `startServer` and `loadConfig` to embed a RESO OData server in your own Node process (handy for test harnesses). Running the server directly from the package (`npx`, no clone or Docker) is tracked in [#238](https://github.com/RESOStandards/reso-tools/issues/238).

## Quick Start (Docker)

The server supports three database backends: **PostgreSQL** (default), **MongoDB** and **SQLite**. Each has its own Docker Compose profile.

### PostgreSQL (Default)

```bash
cd reso-reference-server
docker compose up -d
```

This starts:
- **Server** at `http://localhost:8080` (OData API, `DB_BACKEND=postgres`)
- **PostgreSQL** at `localhost:5432`

Seed with test data:

```bash
docker compose --profile seed up seed
```

### MongoDB

```bash
cd reso-reference-server
docker compose --profile mongodb up -d mongodb server-mongo
```

This starts:
- **Server** at `http://localhost:8080` (OData API, `DB_BACKEND=mongodb`)
- **MongoDB** at `localhost:27017`

Seed with test data:

```bash
docker compose --profile mongodb --profile seed-mongo up seed-mongo
```

### SQLite

```bash
cd reso-reference-server
docker compose --profile sqlite up -d server-sqlite
```

This starts:
- **Server** at `http://localhost:8080` (OData API, `DB_BACKEND=sqlite`)
- No external database – SQLite file stored in a Docker volume

Seed with test data:

```bash
docker compose --profile sqlite --profile seed-sqlite up seed-sqlite
```

### Switching Between Backends

Stop the current backend and start the other:

```bash
# Stop everything and remove volumes
docker compose --profile mongodb --profile sqlite down -v

# Start with PostgreSQL
docker compose up -d
docker compose --profile seed up seed

# – or start with MongoDB – 
docker compose --profile mongodb up -d mongodb server-mongo
docker compose --profile mongodb --profile seed-mongo up seed-mongo

# – or start with SQLite – 
docker compose --profile sqlite up -d server-sqlite
docker compose --profile sqlite --profile seed-sqlite up seed-sqlite
```

### Verify

```bash
# Health check
curl http://localhost:8080/health

# OData metadata
curl http://localhost:8080/\$metadata

# Query Property records via the API
curl -H 'Accept: application/json' 'http://localhost:8080/Property?\$top=5&\$select=ListPrice,City,StateOrProvince'

# Create a Property record
curl -X POST http://localhost:8080/Property \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -H "Authorization: Bearer test" \
  -d '{"ListPrice": 250000, "City": "Austin", "StateOrProvince": "TX", "PostalCode": "78701", "Country": "US", "BedroomsTotal": 3}'
```

Seeding loads a committed static data set (`seed-data/seed.json.gz`) via `POST /admin/seed`. The server inserts it through the DAL with FK links preserved: Office (17), Member (39), OUID (2), Teams (5), Property (50), plus child collections (Media, OpenHouse, Showing, Rooms, etc.) – 948 records total. The call is idempotent – it is a no-op once the server is already seeded.

### Reseed (Drop Existing Data)

```bash
docker compose down -v        # or: docker compose --profile mongodb down -v
docker compose up -d          # start your chosen backend
docker compose --profile seed up seed   # or: --profile mongodb --profile seed-mongo up seed-mongo
```

## Architecture

```
reso-reference-server/
├── src/             # Node/Express/TypeScript OData server source
├── tests/           # Vitest test suite (295 tests)
├── compliance/      # RESO compliance test infrastructure (Docker)
├── docker-compose.yml
└── CLAUDE.md        # Coding conventions
```

See also: the desktop certification app, distributed from [Releases](https://github.com/RESOStandards/reso-tools/releases/latest), which bundles a browser UI over this server.

The server is **metadata-driven**: it reads `server-metadata.json` (RESO Data Dictionary 2.0) at startup and dynamically:

1. Creates database schema (PostgreSQL tables, MongoDB collections/indexes or SQLite tables) for each target resource
2. Registers OData CRUD routes with proper headers, annotations and error format
3. Generates EDMX XML metadata at `/$metadata`
4. Generates OpenAPI 3.0 documentation at `/api-docs`

The `DataAccessLayer` interface abstracts persistence, allowing the same OData handlers to work with PostgreSQL, MongoDB or SQLite.

## Supported Resources

| Resource | Primary Key | Fields |
|----------|-------------|--------|
| Property | ListingKey | 652 |
| Member | MemberKey | 87 |
| Office | OfficeKey | 73 |
| Media | MediaKey | 41 |
| OpenHouse | OpenHouseKey | 33 |
| Showing | ShowingKey | 44 |
| PropertyGreenVerification | GreenVerificationKey | 15 |
| PropertyPowerProduction | PowerProductionKey | 12 |
| PropertyRooms | RoomKey | 19 |
| PropertyUnitTypes | UnitTypeKey | 17 |
| Teams | TeamKey | 45 |
| TeamMembers | TeamMemberKey | 21 |
| OUID | OUIDKey | 46 |

## OData Compliance

The server implements OData 4.01 features required by the RESO Web API Add/Edit Endorsement (RCP-010):

- `OData-Version: 4.01` response header
- `Prefer: return=representation` and `return=minimal` support
- `Location`, `EntityId`, `Preference-Applied` response headers
- `@odata.context`, `@odata.id`, `@odata.editLink`, `@odata.etag` annotations
- OData error format with `error.code`, `error.message`, `error.details[].target`
- OData key syntax: `/{Resource}('{key}')`
- EDMX 4.0 metadata at `/$metadata`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/$metadata` | EDMX XML metadata document |
| GET | `/api-docs` | Swagger UI documentation |
| GET | `/health` | Health check |
| POST | `/oauth/token` | Mock OAuth2 token endpoint |
| GET | `/{Resource}` | Query collection (`$filter`, `$select`, `$orderby`, `$top`, `$skip`, `$count`, `$expand`) |
| POST | `/{Resource}` | Create a new record |
| GET | `/{Resource}('{key}')` | Get a record by key (supports `$expand`) |
| PATCH | `/{Resource}('{key}')` | Update a record |
| DELETE | `/{Resource}('{key}')` | Delete a record |
| POST | `/admin/seed` | Load the committed static seed data set (idempotent) |
| DELETE | `/admin/data-generator/reset` | Truncate all resource data (schema preserved) |

## Enumeration Modes

The server supports two enumeration representations via `ENUM_MODE` environment variable:

- **`string` (default)** – Enum fields use `Edm.String` with `LookupName` annotations. A Lookup Resource at `/Lookup` exposes all 3,788 valid values. Human-readable display names (e.g., "Active Under Contract").
- **`enum-type`** – Enum fields reference `Edm.EnumType` definitions in EDMX metadata. PascalCase member names (e.g., `ActiveUnderContract`). No Lookup Resource.

```bash
# Start in enum-type mode
ENUM_MODE=enum-type docker compose up -d --build

# Run compliance in enum-type mode
ENUM_MODE=enum-type docker compose --profile compliance-core up compliance-core
```

Both modes pass all Web API Core 2.1.0 compliance tests.

## Compliance Testing

The server includes Docker-based compliance testing against the [`@reso-standards/reso-certification`](../reso-certification/) test runner. Tests run against seeded data and validate OData protocol compliance, metadata structure, field mappings and query behavior.

### Web API Core 2.1.0

Validates OData query operations (`$filter`, `$select`, `$orderby`, `$top`, `$skip`, `$count`, `$expand`), response formats, metadata and service document compliance. Uses the `reso-cert core` pipeline from [`@reso-standards/reso-certification`](../reso-certification/).

**Current status: 219 passed, 0 failed, 112 skipped out of 331 required tests** (plus 12 of the 18 optional tests passed)

```bash
# PostgreSQL
docker compose up -d --build --wait
docker compose --profile seed up --exit-code-from seed
docker compose --profile compliance-core up --build --exit-code-from compliance-core

# MongoDB
docker compose --profile mongodb up -d --build --wait mongodb server-mongo
docker compose --profile mongodb --profile seed-mongo up seed-mongo
docker compose --profile mongodb --profile compliance-core-mongo up --build --exit-code-from compliance-core-mongo

# SQLite
docker compose --profile sqlite up -d --build --wait server-sqlite
docker compose --profile sqlite --profile seed-sqlite up seed-sqlite
docker compose --profile sqlite --profile compliance-core-sqlite up --build --exit-code-from compliance-core-sqlite
```

The run samples live server data to pick field values for each data type (integer, decimal, date, timestamp, single and multi-value lookups).

### Data Dictionary 2.0

Validates metadata compliance, field mappings and data availability against the RESO Data Dictionary 2.0 specification. Uses the `reso-cert dd` pipeline from [`@reso-standards/reso-certification`](../reso-certification/).

The profile runs with `--skip-variations`, because continuous integration has no Variations Service to reach. The variations step is reported as skipped, so the run is recorded as not eligible for certification.

**Current status: passed** – 14 resources, 1,090 fields and 3,788 lookups validated

```bash
# PostgreSQL
docker compose --profile compliance-dd up --build --exit-code-from compliance-dd

# MongoDB
docker compose --profile mongodb --profile compliance-dd-mongo up --build --exit-code-from compliance-dd-mongo

# SQLite
docker compose --profile sqlite --profile compliance-dd-sqlite up --build --exit-code-from compliance-dd-sqlite
```

### Web API Add/Edit (RCP-010)

Validates Create, Update and Delete operations with representation and minimal response modes. Uses the custom [`@reso-standards/reso-certification`](../reso-certification/) test runner.

**Current status: 8 passed, 0 failed**

```bash
# Docker
docker compose --profile compliance-addedit up --build --exit-code-from compliance-addedit

# Local CLI
cd ../reso-certification
npx reso-cert add-edit \
  --url http://localhost:8080 \
  --resource Property \
  --payloads ./sample-payloads \
  --auth-token test \
  --output-dir ./out \
  --spec-version 2.0.0
```

The `--output-dir` flag writes the report tree: `report.json` carries the machine-readable verdict and `report-detailed.json` adds the per-step and per-scenario detail, which is the shape the certification submission expects.

### EntityEvent (RCP-027)

Validates EntityEvent change tracking in full mode, which exercises the feed with canary writes rather than observing it read-only. Uses the `reso-cert entity-event` pipeline from [`@reso-standards/reso-certification`](../reso-certification/).

**Current status: 12 of 12 scenarios passed**

```bash
# PostgreSQL
docker compose --profile compliance-entity-event up --build --exit-code-from compliance-entity-event

# MongoDB
docker compose --profile compliance-entity-event-mongo up --build --exit-code-from compliance-entity-event-mongo

# SQLite
docker compose --profile compliance-entity-event-sqlite up --build --exit-code-from compliance-entity-event-sqlite
```

### CI/CD

Compliance tests run automatically on pull requests via GitHub Actions (`.github/workflows/compliance.yml`). All three backends – PostgreSQL, MongoDB and SQLite – run in parallel, each covering the Data Dictionary, Web API Core, Add/Edit and EntityEvent flows. The PostgreSQL job adds an MCP server smoke test. Results are uploaded as build artifacts.

## Development

The server is published as [`@reso-standards/reso-reference-server`](https://www.npmjs.com/package/@reso-standards/reso-reference-server). To work on it, build from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-reference-server
npm install    # preinstall builds sibling deps if their dist/ is missing
npm run build
npm test       # 295 tests
npm run dev    # tsc --watch
npm start      # node dist/index.js
```

This package's inter-package dependencies (`odata-expression-parser`, `reso-validation`, `reso-common`) are resolved by npm workspaces: `npm install` at the repo root links them locally, and published consumers install them from the npm registry. To bootstrap and build every package at once, run `npm run bootstrap` from the repo root.

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
