# RESO Certification

Compliance testing toolkit for RESO OData servers. Run certification tests from the command line, integrate them into your CI pipeline or call the SDK directly from your application.

- **Three endorsements** ready to use: Add/Edit, EntityEvent, Web API Core
- **Pure TypeScript** – built on [`reso-client`](../reso-client/) for OData and [`reso-validation`](../reso-validation/) for field validation
- **Auto-configuring** – samples live server data to build test parameters, auto-detects enum mode from metadata
- **SDK-first** – the CLI, Desktop Client and MCP server all call the same SDK functions with progress callbacks
- **Flexible auth** – bearer tokens, OAuth2 Client Credentials, `.env` files or environment variables

> **[User Guide](doc/GUIDE.md)** – a task-oriented walk-through with realistic examples.

## Install

```bash
npm install @reso-standards/reso-certification
```

The CLI is available without installing, too:

```bash
npx @reso-standards/reso-certification --help
```

Or work from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-certification
npm install
```

The `preinstall` hook automatically builds sibling packages this one depends on (`reso-client`, `reso-validation`). To bootstrap every package at once, run `npm run bootstrap` from the repo root instead.

## Getting Started

```bash
# Add/Edit compliance
reso-cert add-edit --url https://api.example.com --auth-token TOKEN

# EntityEvent compliance
reso-cert entity-event --url https://api.example.com --auth-token TOKEN

# Web API Core compliance
reso-cert core --url https://api.example.com --auth-token TOKEN
```

> **[Full CLI reference](src/cli/README.md)** – every command and option, including the per-step utilities (`metadata`, `schema`, `replicate`, `find-variations`) and the `update-variations` admin command.

## Authentication

Auth is resolved automatically from the first available source:

1. **CLI flags**: `--auth-token` or `--client-id`/`--client-secret`/`--token-url`
2. **Config file**: `--config path/to/config.json` (per-entry auth)
3. **`.env` file**: in the current directory
4. **Environment variables**: `RESO_AUTH_TOKEN` or `RESO_CLIENT_ID`/`RESO_CLIENT_SECRET`/`RESO_TOKEN_URI`

## Endorsements

### Add/Edit (RCP-010)

Validates CRUD operations: create, update and delete with representation/minimal preferences and error handling. 8 certification scenarios.

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

Validates OData query capabilities: $filter across all data types, $select, $orderby, $top, $skip, $count, enumerations, error codes. v2.1.0 adds $expand, server-driven paging and string-based enum comparisons.

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN
```

[**More info**](src/web-api-core/README.md)

### Data Dictionary 2.0

Validates server metadata and data availability against the RESO Data Dictionary. Fetches metadata, merges Lookup Resource data, checks for variations and replicates data using multiple strategies.

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN

# Relaxed: record schema validation errors without failing on them, so one pass
# surveys everything to fix. The run is NOT eligible for certification.
reso-cert dd --url https://api.example.com --auth-token TOKEN --no-strict
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

Run tests from a JSON config file instead of CLI flags. Each entry in the `configs` array is tested sequentially, so one file can cover several recipients or systems.

```bash
reso-cert dd --config path/to/config.json
reso-cert core --config path/to/config.json
reso-cert entity-event --config path/to/config.json
reso-cert add-edit --config path/to/config.json
```

**The same entry serves Data Dictionary, Web API Core and EntityEvent.** Every endorsement-specific option has a default, so nothing beyond the common fields is required for those three.

**Add/Edit is the exception**, because it writes to the server and has to know what a valid and an invalid record look like. It needs `payloads` inline or a `payloadsDir`.

```json
{
  "providerUoi": "T00000012",
  "configs": [
    {
      "description": "Production feed",
      "serviceRootUri": "https://api.example.com/odata",
      "recipientUoi": "M00000554",
      "providerUsi": "50039",
      "token": "your-bearer-token"
    }
  ]
}
```

All three identifiers appear in the output path as `{providerUoi}-{providerUsi}/{recipientUoi}`. One left out of the config shows up there as its own name, so a segment reading `providerUsi` means that field was not supplied.

`OriginatingSystemName` and `OriginatingSystemID` scope a feed carrying more than one originating system. **Data Dictionary and Web API Core read them; Add/Edit and EntityEvent ignore them.** Either may sit at entry level or inside that endorsement's options block, where the block wins, and Name takes precedence over ID when both are present.

See [`sample-configs/`](sample-configs/README.md) for a downloadable sample per endorsement and the full field reference.

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

### The certification image

Tagged releases publish a public image, so most uses are a pull rather than a build:

```bash
docker pull ghcr.io/resostandards/reso-tools/reso-cert:v0.11.0   # or :latest
```

It is `linux/amd64`. On Apple silicon Docker runs it emulated, which works and is slower.

To build it yourself — from an unreleased branch, or with local changes — note that the image
builds the workspace **from this repository** rather than installing the sibling `@reso-standards`
packages from npm, so it runs the code in your checkout rather than the last published release. The
build context is the repository root, not this package:

```bash
docker build -f reso-certification/Dockerfile -t reso-tools-cert:<version> .
```

Running it against a config:

```bash
mkdir -p ./out                      # see "the out directory" below -- create it yourself

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env-file ./.env \
  -v "$PWD/out:/repo/reso-certification/out" \
  -v "$PWD/configs:/configs:ro" \
  reso-tools-cert:<version> dd --config /configs/<name>.json --output-dir out --verbose
```

Four things that are easy to get wrong:

- **`--user` is not optional when mounting an output directory.** The image runs as its own
  unprivileged user, whose uid will not match yours, so reports fail to write with
  `EACCES: permission denied, mkdir`. Passing `--user "$(id -u):$(id -g)"` runs as you. The image
  carries no state that depends on being a known user, so any uid works, including a macOS 501.

- **Create the output directory before the first run.** Docker creates a missing bind-mount target
  as `root`, which then blocks even your own account, and the failure looks identical to the one
  above. A directory that already exists keeps its own ownership.

- **The variations step needs credentials.** Without `RESO_SERVICES_URL`, `TOKEN_URI`, `CLIENT_ID`
  and `CLIENT_SECRET` in the container it throws rather than skipping, which is deliberate: a
  misconfigured machine silently not checking variations would report a run that looked complete.
  Pass them with `--env-file`, or pass `--skip-variations` and accept that the run is then not
  eligible for certification. `TOKEN_URI` selects the environment, and the environment selects
  which variations store the run reads.

- **Prefer `--verbose` for a captured log.** The default renderer draws interactive spinner frames,
  which are noise in a file. Verbose prints one timestamped line per step.

Mount the config read-only. It carries the provider's token.

### Compliance tests against the reference server

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
npm test        # ~1751 tests
npm run dev     # Watch mode
```

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
