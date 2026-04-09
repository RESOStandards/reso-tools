# RESO Reference Server – User Guide

A task-oriented walkthrough of the RESO Reference Server. This is the package that gives you a complete, certified RESO-compliant OData server you can run on your laptop, in CI, or in a container, against the database backend of your choice, with realistic test data ready to query in seconds.

If you have ever needed a real RESO server to develop against and did not want to ask an MLS for credentials, this is the server that ends that pattern.

## Audience

Anyone who needs a working RESO Web API on demand. Real examples:

* **MLS and vendor developers** building against the RESO Web API who need a target server during development without coordinating with a production environment
* **Application developers** consuming RESO data who need a server to query while their integration is being built
* **Test engineers** who need a clean RESO server to run tests against in CI
* **AI agents** that need a target to exercise read and write operations against without touching production data
* **RESO members and certification candidates** preparing for compliance testing who want to run the same cert tools locally that the official process uses
* **Demo and training environments** where the audience needs to see real-looking listings, agents, offices, and media records on screen
* **Anyone evaluating a RESO-related tool** who needs a server to point it at without setting up a database from scratch

The reference server is intentionally a *complete* server – not a mock, not a stub, not a partial implementation. It speaks OData 4.01, it passes RESO Web API Core compliance tests, it passes Data Dictionary compliance tests, and it passes Add/Edit (RCP-010) compliance tests. What you build against it is what you build against any compliant production server.

## Install

The reference server runs as a Docker stack, or you can install and run it directly with Node.js. Docker is the recommended path for almost everything because it bundles the database, the API, and the web UI into one command.

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-reference-server
docker compose up -d
```

Three database backends ship out of the box: **PostgreSQL** (the default), **MongoDB** and **SQLite**. Each is a separate Docker Compose profile. Pick the one that matches what you are building against, or stand up multiple in parallel for cross-backend testing.

---

## Quick Start

### Spin Up the Server

```bash
cd reso-reference-server
docker compose up -d
```

Three services come up:

* **API server** at `http://localhost:8080` – the OData endpoints, the `$metadata` document, the OpenAPI docs, the health check
* **Web UI** at `http://localhost:5173` – the React browser for exploring the data interactively
* **PostgreSQL database** at `localhost:5432` – the persistence layer (the default backend)

### Seed It With Test Data

```bash
docker compose --profile seed up seed
```

This runs the data generator with full dependency resolution: it creates Office records, Member records, OUID records, Teams, and Properties, then back-fills the foreign keys, then creates child collections (Media, OpenHouse, Showing, PropertyRooms). About 892 records total in a single run, all wired correctly. Detailed walk-through of what the generator does and why is in the **[RESO Data Generator guide](../reso-data-generator/)**.

### Verify It Is Working

```bash
# Health check
curl http://localhost:8080/health

# OData metadata document
curl http://localhost:8080/\$metadata

# Query the first five Property records
curl -H 'Accept: application/json' \
  'http://localhost:8080/Property?$top=5&$select=ListPrice,City,StateOrProvince'

# Browse the data in the UI
open http://localhost:5173
```

You now have a fully populated RESO server. The next sections walk through everything you can do with it.

---

## Choosing a Database Backend

The reference server supports three database backends, each with its own Docker Compose profile. The same OData handlers work against all three through a `DataAccessLayer` abstraction, so the *behavior* is identical – queries return the same shapes, writes succeed and fail in the same ways, the cert tools pass against all three. Pick the one that matches what you are testing against.

### PostgreSQL (Default)

The default backend, and the closest match for most production RESO servers in the field. Use it for development against anything Postgres-shaped, for cert testing, and as the default unless you have a specific reason to pick something else.

```bash
docker compose up -d
docker compose --profile seed up seed
```

### MongoDB

Use it when you are building against a document-oriented backend, when you want to exercise the cert flows against a non-relational store, or when you are validating that an integration works the same way against both shapes.

```bash
docker compose --profile mongodb up -d mongodb server-mongo ui-mongo
docker compose --profile seed-mongo up seed-mongo
```

### SQLite

The lightest backend. No external database container, no separate process – the SQLite file lives in a Docker volume. Use it when you want a fast, ephemeral, low-footprint server for unit tests, CI runs, or local development on a constrained machine.

```bash
docker compose --profile sqlite up -d server-sqlite ui-sqlite
docker compose --profile sqlite --profile seed-sqlite up seed-sqlite
```

### Switching Between Backends

Stop the current backend (and remove its volumes if you want a clean slate), then start the other:

```bash
# Stop everything and remove volumes
docker compose --profile mongodb --profile sqlite down -v

# Start PostgreSQL
docker compose up -d
docker compose --profile seed up seed
```

---

## What the Server Speaks

The reference server is a complete OData 4.01 implementation with the features RESO Web API certification requires. The full list lives in the README; the short version of what matters for day-to-day use is below.

### Querying Data

Standard OData system query options work on every collection endpoint:

```bash
# $filter
curl 'http://localhost:8080/Property?$filter=ListPrice gt 200000'

# $select
curl 'http://localhost:8080/Property?$select=ListPrice,City,BedroomsTotal'

# $orderby
curl 'http://localhost:8080/Property?$orderby=ListPrice desc&$top=10'

# $expand (related records inline)
curl 'http://localhost:8080/Property?$expand=Media&$top=5'

# $count (total count alongside the page)
curl 'http://localhost:8080/Property?$count=true&$top=5'

# Combined
curl 'http://localhost:8080/Property?$filter=City eq %27Austin%27 and ListPrice gt 200000&$select=ListPrice,City&$orderby=ListPrice desc&$top=10'
```

The server supports the full RESO Web API Core 2.0.0 query surface – every comparison operator, the logical operators, string functions, date and time functions, lambda operators (`any`, `all`) for collection-valued properties, and the math functions. The full list lives in the **[OData Expression Parser guide](../odata-expression-parser/)** since that is the package the server uses to parse the filter strings into ASTs before turning them into SQL or MongoDB queries.

### Reading a Single Record

```bash
curl -H 'Accept: application/json' \
  "http://localhost:8080/Property('ABC123')"
```

OData key syntax with single quotes around the key value. Compound keys (for resources with multi-field primary keys) use comma-separated key fragments inside the parentheses.

### Creating, Updating, and Deleting Records

```bash
# Create a new Property
curl -X POST http://localhost:8080/Property \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
  -H 'Authorization: Bearer test' \
  -d '{
    "ListPrice": 250000,
    "City": "Austin",
    "StateOrProvince": "TX",
    "PostalCode": "78701",
    "Country": "US",
    "BedroomsTotal": 3
  }'

# Update an existing Property
curl -X PATCH "http://localhost:8080/Property('ABC123')" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test' \
  -d '{ "ListPrice": 275000 }'

# Delete a Property
curl -X DELETE "http://localhost:8080/Property('ABC123')" \
  -H 'Authorization: Bearer test'
```

The server enforces the RCP-010 Add/Edit semantics – `Prefer: return=representation` returns the created or updated record in the response body, `Prefer: return=minimal` returns just the headers, and the response includes `@odata.context`, `@odata.id`, `@odata.editLink`, and `@odata.etag` annotations on every entity.

### The `$metadata` Document and OpenAPI

```bash
# OData EDMX metadata (XML)
curl http://localhost:8080/\$metadata

# OpenAPI 3.0 documentation (JSON)
curl http://localhost:8080/api-docs

# Swagger UI (interactive)
open http://localhost:8080/api-docs
```

Both are generated dynamically from the loaded `server-metadata.json` at boot. Any change to the metadata file produces a new schema, new tables, new endpoints, and new docs automatically – there is no separate "regenerate the API" step.

---

## Loading Your Own Metadata

The reference server is **metadata-driven**. It reads `server-metadata.json` at startup and dynamically generates everything from it: the database schema, the OData routes, the EDMX document, the OpenAPI spec, the field validators. The default file is the RESO Data Dictionary 2.0 schema, but you can point the server at any compatible metadata document.

### Pointing the Server at a Different Metadata File

Set the `METADATA_PATH` environment variable to the absolute path of the file you want loaded:

```bash
METADATA_PATH=/path/to/your-metadata.json node dist/index.js
```

Or, in Docker, mount the file into the container and set `METADATA_PATH` in the compose configuration. The server reads the file at boot, generates schema for every resource it declares, and is ready to query.

### Working With Real Cert Metadata Reports

If you have a metadata report from a RESO certification run – the kind that comes out of `reso-cert dd` – the reference server can load it directly, with one preprocessing step. DD 2.0 and 2.1 cert reports do not include the top-level `resources[]` block (that concept arrives in DD 2.2), so the **[RESO Certification](../reso-certification/)** package ships an adapter that synthesizes it from the field declarations:

```bash
reso-cert metadata-report adapt \
  --in path/to/cert-metadata-report.json \
  --out path/to/adapted-report.json \
  --pretty
```

Then point the server at the adapted file:

```bash
METADATA_PATH=path/to/adapted-report.json node dist/index.js
```

The server loads the cert report, registers routes for every resource declared in it, and serves the schema exactly as the certified provider exposed it. This is the cleanest way to develop or test against a server shaped like a specific real-world deployment without needing access to that deployment.

The adapter is idempotent – running it on a report that already has a `resources[]` block (DD 2.2 or later) returns the file unchanged.

---

## Authentication

The server ships with a **mock OAuth2 endpoint** at `/oauth/token` that accepts any client credentials and returns a bearer token. This is intentional – the reference server is meant for development and testing, not production, and the auth mechanism exists so consumers can exercise the OAuth2 round-trip end to end without needing a real identity provider.

### Bearer Token

The simplest path. Pass any token as `Authorization: Bearer <token>` and the server accepts it:

```bash
curl -H 'Authorization: Bearer test' http://localhost:8080/Property
```

Any value works. Use a literal `test` for documentation examples; use whatever your client library generates for real round-trip testing.

### OAuth2 Client Credentials

The full OAuth2 client credentials flow works against the mock endpoint:

```bash
curl -X POST http://localhost:8080/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=test&client_secret=test&scope=api'
```

The server returns a token immediately. The **[RESO Client SDK](../reso-client/)** can be configured to drive this flow automatically against the reference server – useful for testing both auth code paths in your client without spinning up an identity provider.

---

## Switching Enumeration Modes

RESO Data Dictionary fields that take enumerated values (like `StandardStatus`, `PropertyType`, and the rest) can be exposed in two different ways at the OData layer. The reference server supports both via the `ENUM_MODE` environment variable.

### `string` Mode (Default)

Enum fields are typed as `Edm.String` in the metadata, with a `LookupName` annotation pointing at the lookup table. A separate **Lookup Resource** at `/Lookup` exposes every valid value for every enumerated field – more than 3,600 values for the standard DD 2.0 schema.

```bash
curl 'http://localhost:8080/Lookup?$filter=LookupName eq %27StandardStatus%27'
```

This is the mode most production RESO servers use because the values are human-readable (`"Active Under Contract"` not `ActiveUnderContract`) and the lookup table can be queried directly.

### `enum-type` Mode

Enum fields are typed as `Edm.EnumType` references in the metadata, with the values defined inline as `EnumType` declarations. Member names are PascalCase. There is no Lookup Resource.

```bash
ENUM_MODE=enum-type docker compose up -d --build
```

This mode is closer to "by-the-book" OData 4.01 enum handling and is useful when you are testing how a client handles enum types declared in EDMX.

Both modes pass the Web API Core 2.0.0 compliance tests. Pick whichever your client expects.

---

## EntityEvent Mode

The reference server supports the full **EntityEvent** change-tracking flow defined in RCP-027. EntityEvent is the RESO-defined way to surface a change feed for incremental replication: every create, update, and delete on a resource produces a row on the `EntityEvent` resource with a monotonic sequence number, and consumers poll the feed to discover changes.

### Enabling EntityEvent

Set the `ENTITY_EVENT` environment variable to `true` when starting the server:

```bash
ENTITY_EVENT=true docker compose up -d --build
```

The server registers the `EntityEvent` resource, starts producing change events on every write, and exposes the feed for querying:

```bash
# Get every event since sequence 0
curl 'http://localhost:8080/EntityEvent?$filter=Sequence ge 0&$orderby=Sequence asc&$top=100'

# Get only Property changes
curl 'http://localhost:8080/EntityEvent?$filter=ResourceName eq %27Property%27'
```

The full polling-replication consumer pattern – how to read the feed, how to disambiguate creates from updates from deletes, how to handle the empty-result-on-follow-up-fetch case – is covered in detail in the **[RESO MCP Server guide](../reso-mcp-server/)** Section 4. The MCP server walks through the entire EntityEvent loop end to end against this exact reference server, with verbatim tool calls and responses.

---

## Running Compliance Tests Against It

The reference server is a target for the **[RESO Certification](../reso-certification/)** test runners. Three cert flows ship as Docker Compose profiles, ready to run:

### Web API Core 2.0.0

Validates the full OData query surface – every comparison operator, every logical operator, every string and date function, the `$expand` and `$select` and `$filter` mechanics, the response shapes, the metadata document, and the service document.

```bash
# PostgreSQL
docker compose up -d --build --wait
docker compose --profile seed up --exit-code-from seed
docker compose --profile compliance-core up --build --exit-code-from compliance-core
```

The current status of the reference server against this flow is **42 passed, 0 failed, 3 skipped**. The 3 skipped tests are for the `has` operator, which is N/A in `string` enumeration mode.

### Data Dictionary 2.0

Validates metadata compliance, field mappings, and data availability against the RESO DD 2.0 specification. Walks every resource, checks every declared field, samples the data for type correctness, and validates the lookup tables.

```bash
docker compose --profile compliance-dd up --build --exit-code-from compliance-dd
```

Current status: **1,034 passed, 570 skipped, 0 failed, 0 schema validation errors**.

### Add/Edit (RCP-010)

Validates Create, Update, and Delete operations with both `representation` and `minimal` response modes. Exercises every supported endorsement scenario and checks the response headers, annotations, and error format.

```bash
docker compose --profile compliance-addedit up --build --exit-code-from compliance-addedit
```

Current status: **8 passed, 0 failed**.

All three cert flows run against any of the three database backends. The MongoDB and SQLite variants live under `--profile compliance-*-mongo` and `--profile compliance-*-sqlite` respectively, and they pass too. This is the full coverage matrix the cert tools were built to handle.

---

## Where to Next

* **Filling the server with data** – the **[RESO Data Generator](../reso-data-generator/)** is the package that produced the seed data above, and it can produce more on demand. If you need 500 Properties or 5,000, that is the right entry point.
* **Querying the server interactively** – the **[RESO Desktop Client](../reso-desktop-client/)** and the **[RESO Web Client](../reso-web-client/)** are both built around the **[RESO Client SDK](../reso-client/)** and connect to any RESO server, including this one.
* **Validating records** – the **[reso-validation](../reso-validation/)** library runs on every Add/Edit write against the reference server. It is also a standalone library you can use in your own application to check records before sending them.
* **Running the cert tools as code** – the **[RESO Certification](../reso-certification/)** package gives you a CLI and an SDK for running every cert flow programmatically, not just through Docker. Useful for CI pipelines and for embedding cert testing inside other tools.
* **Connecting an AI agent** – the **[RESO MCP Server](../reso-mcp-server/)** exposes this exact server through the Model Context Protocol so any MCP-aware AI host (Claude Code, Claude Desktop, Cursor, others) can read, query, and write through a real RESO server. The MCP guide walks through the full Add/Edit and EntityEvent flows against this reference server with verbatim tool calls.

## Reference

* **[Package README](../)** – full Docker Compose recipes, supported resources table, OData compliance details, environment variable reference
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/reso-reference-server)**
* **[OData 4.01 Part 1: Protocol](https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html)** – the spec the server implements
* **[RESO Data Dictionary](https://www.reso.org/data-dictionary/)** – the schema the server is built around
* **[RCP-010 Add/Edit Endorsement](https://github.com/RESOStandards/transport/blob/main/proposals/web-api-add-edit.md)** – the spec for the Create/Update/Delete behavior
* **[RCP-027 EntityEvent](https://github.com/RESOStandards/transport/blob/main/proposals/entity-event.md)** – the spec for the change-tracking feed
