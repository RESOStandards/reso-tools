# @reso-standards/reso-certification

RESO certification compliance testing toolkit. Tests OData 4.01 servers against RESO Web API endorsement specifications via a CLI, SDK, or MCP server.

Built on [`@reso-standards/reso-client`](../reso-client/) for OData operations and [`@reso-standards/reso-validation`](../reso-validation/) for field validation.

## Install

```bash
npm install @reso-standards/reso-certification
```

## Quick Start

```bash
# Add/Edit (RCP-010)
reso-cert add-edit --url https://api.example.com --auth-token TOKEN

# EntityEvent (RCP-027)
reso-cert entity-event --url https://api.example.com --auth-token TOKEN

# Web API Core 2.0.0
reso-cert core --url https://api.example.com --auth-token TOKEN

# Web API Core 2.1.0
reso-cert core --url https://api.example.com --auth-token TOKEN --version 2.1.0
```

## Authentication

Auth is resolved from the first available source:

1. CLI flags: `--auth-token` or `--client-id`/`--client-secret`/`--token-url`
2. Config file: `--config` with per-entry auth
3. `.env` file in the current directory
4. Environment variables: `RESO_AUTH_TOKEN` or `RESO_CLIENT_ID`/`RESO_CLIENT_SECRET`/`RESO_TOKEN_URI`

```bash
# Bearer token
reso-cert add-edit --url https://api.example.com --auth-token TOKEN

# OAuth2 Client Credentials
reso-cert add-edit --url https://api.example.com \
  --client-id ID --client-secret SECRET --token-url https://auth.example.com/token

# Environment variables (no flags needed)
RESO_AUTH_TOKEN=TOKEN reso-cert add-edit --url https://api.example.com
```

## Endorsements

### Add/Edit (RCP-010)

Validates OData CRUD operations against 8 certification scenarios: create with representation/minimal, create fails, update with representation/minimal, update fails, delete succeeds, delete fails.

```bash
# Auto-generate payloads from sampled server data
reso-cert add-edit --url https://api.example.com --auth-token TOKEN

# Use a payload directory
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./payloads

# Use a config file with inline payloads
reso-cert add-edit --config sample-configs/add-edit-config.json

# Mock server (offline testing)
reso-cert add-edit --mock --payloads sample-payloads
```

### EntityEvent (RCP-027)

Validates EntityEvent change tracking with observe mode (read-only) and full mode (create/update/delete canary writes).

```bash
# Observe mode (read-only, default)
reso-cert entity-event --url https://api.example.com --auth-token TOKEN

# Full mode (canary writes to verify event generation)
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode full
```

### Web API Core 2.0.0 / 2.1.0

Validates OData query capabilities: $filter (integer, decimal, date, datetime, enum comparisons), $select, $top, $skip, $count, $orderby, error codes. v2.1.0 adds $expand, server-driven paging, and string-based enum comparisons.

45 scenarios defined as data and run through 5 assertion primitives — no Java, Gradle, or RESOScript XML required.

```bash
# Test all well-known resources (Property, Member, Office, Media, etc.)
reso-cert core --url https://api.example.com --auth-token TOKEN

# Test specific resources
reso-cert core --url https://api.example.com --auth-token TOKEN --resources Property,Member

# Version 2.1.0 (adds $expand, nextLink, string enum tests)
reso-cert core --url https://api.example.com --auth-token TOKEN --version 2.1.0

# Require full data type coverage (fail if any type has no test data)
reso-cert core --url https://api.example.com --auth-token TOKEN --full-coverage
```

#### Test Matrix

The Web API Core test runner validates the following OData operations per resource:

| Category | Scenarios | What's Tested |
|----------|-----------|---------------|
| Structural | 7 | Metadata validation, service document, fetch-by-key, $select, $top, $skip, $count |
| Integer filters | 9 | eq, ne, gt, ge, lt, le, and, or, not() on integer fields |
| Decimal filters | 5 | ne, gt, ge, lt, le on decimal fields |
| Date filters | 6 | eq, ne, gt, ge, lt, le on ISO 8601 date fields |
| Timestamp filters | 5 | gt, ge, lt/le/ne with `now()` on DateTimeOffset fields |
| OrderBy | 4 | Ascending, descending, combined with integer filter |
| Enum (single) | 3 | has, eq, ne on single-value enumerations |
| Enum (multi) | 2 | has, has+and on multi-value enumerations |
| Collection | 2 | any(), all() lambda operators |
| Error codes | 2 | HTTP 400 (bad request), HTTP 404 (not found) |
| **v2.0.0 total** | **45** | |
| String enums (v2.1.0) | 4 | eq, ne on string enums; any(), all() on string collections |
| Paging (v2.1.0) | 1 | Server-driven paging via @odata.nextLink |
| $expand (v2.1.0) | 1 | Navigation property expansion |
| **v2.1.0 total** | **51** | |

Each scenario samples live data from the server to find appropriate test values (median selection for numeric/temporal types ensures filter tests work bidirectionally). Scenarios are skipped when the required data type doesn't exist in the resource's metadata or no data is available to validate.

#### Enum Mode

The server's enumeration representation is auto-detected from metadata. Override with `--enum-mode` if needed:

| Mode | Single Enum | Multi Enum | Detection |
|------|-------------|------------|-----------|
| `string` | `Edm.String` + LookupName | `Collection(Edm.String)` | LookupName annotations |
| `collections` | `Edm.EnumType` | `Collection(Edm.EnumType)` | Collection enum types |
| `isflags` | `Edm.EnumType` | `Edm.EnumType` with `IsFlags=true` | IsFlags attribute |

```bash
# Override auto-detection
reso-cert core --url https://api.example.com --auth-token TOKEN --enum-mode collections
```

#### Coverage Matrix

The Core report includes a coverage matrix showing which data types were tested per resource. In default mode, the test passes as long as no scenarios fail — missing types are skipped and noted. With `--full-coverage`, the test fails if any type category has zero coverage across all tested resources.

## Output Modes

```bash
# Default: listr2 progress with spinners
reso-cert add-edit --url https://api.example.com --auth-token TOKEN

# Verbose: line-by-line output (good for CI)
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --verbose

# JSON: pipeline result as JSON (for piping)
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --output json

# Write compliance reports to a directory
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --output-dir ./results
```

## Config Files

Use `--config` to run tests from a JSON config file. Each entry in the `configs` array is tested sequentially.

```bash
reso-cert add-edit --config sample-configs/add-edit-config.json
reso-cert entity-event --config sample-configs/entity-event-config.json
```

See [`sample-configs/`](sample-configs/) for examples.

## SDK Usage

All CLI commands wrap SDK functions. Use the same functions programmatically:

```typescript
import { runComplianceTests } from '@reso-standards/reso-certification';

// Run any endorsement
const result = await runComplianceTests({
  endorsement: 'add-edit',
  server: {
    url: 'https://api.example.com',
    auth: { mode: 'token', authToken: 'TOKEN' },
  },
  resource: 'Property',
}, (progress) => {
  console.log(`${progress.step}: ${progress.status}`);
});

console.log(`${result.status}: ${result.steps.length} steps`);
```

Available SDK functions:

```typescript
import {
  // Unified dispatcher
  runComplianceTests,

  // Per-endorsement pipelines
  runAddEditCompliance,
  runEntityEventCompliance,
  runCoreCompliance,

  // Pipeline builder
  createPipeline,

  // Report generators
  writeReports,
  addEditReportGenerators,
  entityEventReportGenerators,
  coreReportGenerators,
} from '@reso-standards/reso-certification';
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All scenarios passed |
| 1 | One or more scenarios failed |
| 2 | Runtime error |

## Docker Compliance Testing

Run compliance tests against the [RESO Reference Server](../reso-reference-server/) using Docker Compose:

```bash
cd ../reso-reference-server

# Start server
docker compose up -d --build --wait db server

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
npm test        # 219 tests
npm run dev     # Watch mode
```

## License

See [LICENSE](../LICENSE) in the repository root.
