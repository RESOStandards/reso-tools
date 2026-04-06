# Migrating from reso-certification-utils and web-api-commander

This guide covers migrating from the legacy `reso-certification-utils` CLI and `web-api-commander` Java tools to the new `reso-cert` CLI.

## What Changed

| Before | After |
|--------|-------|
| `reso-certification-utils` CLI (Node.js) | `reso-cert dd` |
| `web-api-commander` testWebApiCore (Java/Gradle) | `reso-cert core` |
| `web-api-commander` testDataDictionary (Java/Gradle) | `reso-cert dd` (metadata generation) |
| RESOScript XML config files | JSON config files or CLI flags |
| Separate tools for each endorsement | One CLI with subcommands |
| Java 17 + Gradle required for Core/DD | Node.js 22+ only |

## Command Mapping

### Data Dictionary

```bash
# Before
reso-certification-utils runDDTests -v 2.0 -p config.json -a -l 100000

# After
reso-cert dd --url https://api.example.com --auth-token TOKEN --dd-version 2.0

# Or with a config file
reso-cert dd --config config.json --dd-version 2.0
```

**Options mapping:**

| reso-certification-utils | reso-cert |
|-------------------------|-----------|
| `-v 2.0` | `--dd-version 2.0` (DD 1.7 no longer certified, SDK only) |
| `-p config.json` | `--config config.json` or `--url` + `--auth-token` |
| `-a` (run all tests) | Always runs all tests |
| `-l 100000` | `--limit 100000` |
| `--strictMode` | `--strict` |
| N/A | `--batch-expand` (new: batch $expand optimization) |

### Web API Core

```bash
# Before (requires Java 17, Gradle, RESOScript XML)
./gradlew testWebApiCore -DpathToRESOScript=Property.resoscript -DuseStringEnums=true

# After
reso-cert core --url https://api.example.com --auth-token TOKEN

# With options
reso-cert core --url https://api.example.com --auth-token TOKEN \
  --resources Property,Member \
  --version 2.1.0 \
  --full-coverage
```

**Key differences:**
- No Java or Gradle required
- No RESOScript XML files — test parameters auto-sampled from live server data
- Enum mode auto-detected from metadata (override with `--enum-mode`)
- Coverage matrix built automatically

### Add/Edit (RCP-010)

```bash
# Before (via Docker entrypoint with shell script payload generation)
docker compose --profile compliance-addedit up

# After
reso-cert add-edit --url https://api.example.com --auth-token TOKEN

# Payloads auto-generated from sampled server data, or provide your own
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./my-payloads
```

### EntityEvent (RCP-027)

```bash
# Before (via Docker entrypoint)
docker compose --profile compliance-entity-event up

# After
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode full
```

## Config File Format

The config file format is compatible with `reso-certification-utils`:

```json
{
  "providerUoi": "YOUR-PROVIDER-UOI",
  "configs": [
    {
      "description": "Production Server",
      "serviceRootUri": "https://api.example.com",
      "recipientUoi": "RECIPIENT-UOI",
      "providerUsi": "SYSTEM-ID",
      "token": "bearer-token"
    }
  ]
}
```

OAuth2 Client Credentials are also supported:

```json
{
  "providerUoi": "YOUR-PROVIDER-UOI",
  "configs": [
    {
      "description": "Production Server (OAuth2)",
      "serviceRootUri": "https://api.example.com",
      "recipientUoi": "RECIPIENT-UOI",
      "providerUsi": "SYSTEM-ID",
      "clientCredentials": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "tokenUri": "https://auth.example.com/token",
        "scope": "optional-scope"
      }
    }
  ]
}
```

## Output Directory

The output directory structure is compatible with `reso-certification-utils`:

```
.reso-cert/                         # was: results/
  data-dictionary-2.0/
    <providerUoi>-<providerUsi>/
      <recipientUoi>/
        current/
          metadata.xml
          metadata-report.json
          metadata-report.processed.json
          lookup-resource-lookup-metadata.json
          data-availability-report.json
          data-availability-responses.json
          data-dictionary-variations.json
        archived/
          <timestamp>/
```

For backward compatibility with tools that expect `results/`:

```bash
ln -s .reso-cert results
```

## Authentication

The new CLI resolves auth from multiple sources (first match wins):

1. CLI flags: `--auth-token` or `--client-id`/`--client-secret`/`--token-url`
2. Config file: per-entry `token` or `clientCredentials`
3. `.env` file in the current directory
4. Environment variables: `RESO_AUTH_TOKEN` or `RESO_CLIENT_ID`/`RESO_CLIENT_SECRET`/`RESO_TOKEN_URI`

This means you can set auth once in your environment and skip it on every command.

## Docker

All compliance containers now use the same lightweight Node.js image. No more Java/Gradle images.

```bash
# Before: separate Dockerfiles per endorsement
docker compose --profile compliance-dd up --build      # Dockerfile.dd (Java)
docker compose --profile compliance-core up --build    # Dockerfile.core (Java)

# After: same Dockerfile for all
docker compose --profile compliance-dd up --build      # reso-certification/Dockerfile (Node.js)
docker compose --profile compliance-core up --build    # reso-certification/Dockerfile (Node.js)
```

## What's Not Changed

- Config file format (providerUoi, configs array, auth) — same as before
- Output file names and content format — same as before
- Directory structure convention — same as before (.reso-cert instead of results)
- Lookup Resource handling — same merge behavior
- Schema validation settings — same file, never modified

## New Features

- **Auto-configuration**: test parameters sampled from live server data (no RESOScript XML)
- **Enum mode auto-detection**: string, collections, or isflags detected from metadata
- **Coverage matrix**: shows which data types are tested per resource
- **Batch expand**: `--batch-expand` batches all $expand requests per resource
- **Progress rendering**: listr2 spinners (default), `--verbose` for CI, `--output json` for piping
- **MCP server**: expose all tools to AI agents via Model Context Protocol
- **Per-request latency**: Core tests track individual OData request timing
- **Benchmarks**: vitest bench for performance regression tracking
