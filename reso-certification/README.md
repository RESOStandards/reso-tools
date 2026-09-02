# RESO Certification

Compliance testing toolkit for RESO OData servers. Run certification tests from the command line, integrate them into your CI pipeline, or call the SDK directly from your application.

- **Three endorsements** ready to use: Add/Edit, EntityEvent, Web API Core
- **No Java required** – pure TypeScript, built on [`reso-client`](../reso-client/) for OData and [`reso-validation`](../reso-validation/) for field validation
- **Auto-configuring** – samples live server data to build test parameters, auto-detects enum mode from metadata
- **SDK-first** – the CLI, Desktop Client, and MCP server all call the same SDK functions with progress callbacks
- **Flexible auth** – bearer tokens, OAuth2 Client Credentials, `.env` files, or environment variables

> **[User Guide](doc/GUIDE.md)** – a task-oriented walkthrough with realistic examples.

## Install

This package is not on npm yet. Install from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo on GitHub:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-certification
npm install
```

The `preinstall` hook automatically builds sibling packages this one depends on (`reso-client`, `reso-validation`). To bootstrap every package at once, run `npm run bootstrap` from the repo root instead.

To consume the SDK from another project, link it locally with `npm link` or use a `file:` dependency.

## Getting Started

```bash
# Add/Edit compliance
reso-cert add-edit --url https://api.example.com --auth-token TOKEN

# EntityEvent compliance
reso-cert entity-event --url https://api.example.com --auth-token TOKEN

# Web API Core compliance
reso-cert core --url https://api.example.com --auth-token TOKEN
```

> **[Full CLI reference](src/cli/README.md)** — every command and option, including the per-step utilities (`metadata`, `schema`, `replicate`, `find-variations`) and the `update-variations` admin command.

## Authentication

Auth is resolved automatically from the first available source:

1. **CLI flags**: `--auth-token` or `--client-id`/`--client-secret`/`--token-url`
2. **Config file**: `--config path/to/config.json` (per-entry auth)
3. **`.env` file**: in the current directory
4. **Environment variables**: `RESO_AUTH_TOKEN` or `RESO_CLIENT_ID`/`RESO_CLIENT_SECRET`/`RESO_TOKEN_URI`

## Endorsements

### Add/Edit (RCP-010)

Validates CRUD operations: create, update, and delete with representation/minimal preferences and error handling. 8 certification scenarios.

```bash
reso-cert add-edit --url https://api.example.com --auth-token TOKEN
```

[**More info**](src/add-edit/README.md)

### EntityEvent (RCP-027)

Validates EntityEvent change tracking in observe mode (read-only) or full mode (canary writes). 9-12 scenarios depending on mode.

```bash
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode observe
```

[**More info**](src/entity-event/README.md)

### Web API Core 2.0.0 / 2.1.0

Validates OData query capabilities: $filter across all data types, $select, $orderby, $top, $skip, $count, enumerations, error codes. v2.1.0 adds $expand, server-driven paging, and string-based enum comparisons.

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN
```

[**More info**](src/web-api-core/README.md)

### Data Dictionary 2.0

Validates server metadata and data availability against the RESO Data Dictionary. Fetches metadata, merges Lookup Resource data, checks for variations, and replicates data using multiple strategies.

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN

# Strict mode
reso-cert dd --url https://api.example.com --auth-token TOKEN --strict
```

[**More info**](src/data-dictionary/README.md)

## Output

```bash
# Default: progress with spinners
reso-cert core --url https://api.example.com --auth-token TOKEN

# Verbose: line-by-line (good for CI logs)
reso-cert core --url https://api.example.com --auth-token TOKEN --verbose

# JSON: machine-readable output
reso-cert core --url https://api.example.com --auth-token TOKEN --output json

# Write reports to a directory
reso-cert core --url https://api.example.com --auth-token TOKEN --output-dir ./results
```

## Config Files

Run tests from a JSON config file instead of CLI flags. Each entry in the `configs` array is tested sequentially.

```bash
reso-cert add-edit --config sample-configs/add-edit-config.json
```

See [`sample-configs/`](sample-configs/) for examples.

## Metadata Report Utilities

### `reso-cert metadata-report adapt`

Synthesize the top-level `resources[]` block on a DD 2.0 or 2.1 metadata report so it can be loaded by tools that expect a DD 2.2-shaped report (notably the [Reference Server](../reso-reference-server/)). Idempotent – DD 2.2+ reports pass through unchanged.

```bash
reso-cert metadata-report adapt \
  --in path/to/metadata-report.json \
  --out path/to/adapted-report.json \
  --pretty
```

**Why this exists:** cert metadata reports for DD 2.0 and 2.1 do not carry a top-level `resources[]` block. That concept arrives in DD 2.2. Anything that consumes a metadata report and needs to know which entity sets to register has to derive the resource list from the next-best source: distinct values in `fields[].resourceName`. The adapt command does this mechanically and writes a new file with the synthesized block in place.

The same logic is also exposed via the SDK as `synthesizeResourcesFromFields`:

```typescript
import {
  synthesizeResourcesFromFields,
  type MetadataReport,
} from '@reso-standards/reso-certification';

const adapted: MetadataReport = synthesizeResourcesFromFields(report);
```

The helper is pure and idempotent – calling it on a report that already has a populated `resources[]` returns the input unchanged.

## SDK

All CLI commands wrap the same SDK functions:

```typescript
import { runComplianceTests } from '@reso-standards/reso-certification';

const result = await runComplianceTests({
  endorsement: 'core',
  server: {
    url: 'https://api.example.com',
    auth: { mode: 'token', authToken: 'TOKEN' },
  },
}, (progress) => {
  console.log(`${progress.step}: ${progress.status}`);
});
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All scenarios passed |
| 1 | One or more scenarios failed |
| 2 | Runtime error |

## Docker

Run compliance tests against the [RESO Reference Server](../reso-reference-server/):

```bash
cd ../reso-reference-server

# Add/Edit
docker compose --profile compliance-addedit up --build \
  --exit-code-from compliance-addedit db-addedit server-addedit compliance-addedit

# EntityEvent
docker compose --profile compliance-entity-event up --build \
  --exit-code-from compliance-entity-event db-entity-event server-entity-event compliance-entity-event

# Web API Core
docker compose --profile compliance-core up --build \
  --exit-code-from compliance-core compliance-core
```

## Development

```bash
npm install
npm run build
npm test        # ~1064 tests
npm run dev     # Watch mode
```

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
