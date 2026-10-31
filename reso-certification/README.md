# RESO Certification

Compliance testing toolkit for RESO OData servers. Run certification tests from the command line, integrate them into your CI pipeline or call the SDK directly from your application.

- **Endorsements** ready to use: Add/Edit, EntityEvent, Web API Core, Data Dictionary and RESO Common Format (RCF)
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

This package depends on the siblings `reso-common`, `reso-client`, `reso-metadata-utils` and `reso-validation`, which have to be built first. `npm run bootstrap` from the repository root installs and builds every package.

## Getting Started

```bash
# Add/Edit compliance, with your payloads
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./payloads

# EntityEvent compliance
reso-cert entity-event --url https://api.example.com --auth-token TOKEN

# Web API Core compliance
reso-cert core --url https://api.example.com --auth-token TOKEN

# Data Dictionary compliance
reso-cert dd --url https://api.example.com --auth-token TOKEN

# RESO Common Format (RCF) compliance
reso-cert rcf --input ./rcf-export/ --output-dir ./out
```

> **[Full CLI reference](src/cli/README.md)** – every command and option, including the per-step utilities (`metadata`, `schema`, `replicate`, `find-variations`) and the `update-variations` admin command.

## Authentication

Auth is resolved automatically from the first available source:

1. **CLI flags**: `--auth-token` or `--client-id`/`--client-secret`/`--token-url`
2. **Config file**: `--config path/to/config.json` (per-entry auth)
3. **A credentials file**: `credentials.env`, as the certification site hands it out, or a `.env`. The CLI reads the first one it finds at startup, from the places the [CLI reference](src/cli/README.md#environment-env) lists.
4. **Environment variables**: `RESO_AUTH_TOKEN` or `RESO_CLIENT_ID`/`RESO_CLIENT_SECRET`/`RESO_TOKEN_URI`

A Data Dictionary run authenticates twice. Besides the server credentials above, it reaches the Variations Service, which reads `RESO_SERVICES_URL`, `TOKEN_URI`, `CLIENT_ID` and `CLIENT_SECRET` from the credentials file or the environment. A missing `RESO_SERVICES_URL` fails the run at the variations step rather than skipping it, so a misconfigured machine cannot quietly stop checking variations. `--skip-variations` runs without them. That run is not eligible for certification.

## Endorsements

### Add/Edit (RCP-010)

Validates create, update and delete, each as a test that should succeed and one that should fail, with `representation` and `minimal` responses for create and update. Test the actions and formats you support, with your payloads for each. The tool can write them instead for the reference server.

```bash
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./payloads
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./payloads --actions create --create-formats minimal
```

[**More info**](src/add-edit/README.md)

### EntityEvent (RCP-027)

Validates EntityEvent change tracking in observe mode (read-only) or full mode (canary writes). 9-12 scenarios depending on mode.

```bash
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode observe
```

[**More info**](src/entity-event/README.md)

### Web API Core 2.1.0

Validates OData query capabilities: $filter across all data types, $select, $orderby, $top, $skip, $count, enumerations, error codes, $expand, server-driven paging and string-based enum comparisons. Core 2.0.0 remains certifiable and is selectable per run; 2.1.0 is the default.

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN

# Name the field tested for a data type instead of letting sampling choose. The named field is the
# one tested, so a field the service will not filter on fails its test rather than falling back.
reso-cert core --url https://api.example.com --auth-token TOKEN \
  --field-overrides Property.ListPrice,Office.FeedTypes
```

[**More info**](src/web-api-core/README.md)

### Data Dictionary 2.1

Validates server metadata and data availability against the RESO Data Dictionary. Fetches metadata, merges Lookup Resource data, checks for variations and replicates data using multiple strategies. Data Dictionary 2.0 remains certifiable and is selectable per run; 2.1 is the default.

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN

# Relaxed: record schema validation errors without failing on them, so one pass
# surveys everything to fix. The run is NOT eligible for certification.
reso-cert dd --url https://api.example.com --auth-token TOKEN --no-strict

# Certify against Data Dictionary 2.0 instead of the default 2.1.
reso-cert dd --url https://api.example.com --auth-token TOKEN --dd-version 2.0
```

[**More info**](src/data-dictionary/README.md)

### RESO Common Format (RCF)

RCF data arrives as files of records, with no server and no `$metadata` behind it. `rcf` reads the files and works out a metadata report and a data-availability report from the records. Then it checks the report for variations.

```bash
# One file, a directory of files or a .zip
reso-cert rcf --input ./rcf-export/ --output-dir ./out

# Also check each record against the Data Dictionary types
reso-cert rcf --input ./rcf-export/ --output-dir ./out --schema-validate

# Write a variations report for review, then submit it
reso-cert rcf --input ./rcf-export/ --output-dir ./out \
  --provider-uoi <UOI> --provider-usi <USI> --recipient-uoi <UOI>
reso-cert submit-variations-report --report ./out/variations-report.json
```

- **Machine-friendly lookup values are accepted until Data Dictionary 3.0.** A value such as `ComingSoon` for `Coming Soon` is listed as a deprecation, not a variation.
- **The Data Dictionary version** is `--dd-version` when given, else the version in the files' `@reso.context`, else 2.0.
- **Variations do not change the exit code.** `rcf` exits `1` on schema errors with `--schema-validate`, and `2` when it could not do what was asked.
- **The variations check uses your RESO services credentials.** `--skip-variations` runs without them.

[**More info**](doc/GUIDE.md) – "RESO Common Format (RCF)" in the User Guide

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

Unlike other endorsements, Add/Edit should not be tested against production servers, since records are created and deleted. A development environment is sufficient.

All other endorsements require production data sets, with the exception of technology providers certifying themselves with their own development data to demonstrate that their systems can pass the specification.

```json
{
  "providerUoi": "T00000012",
  "configs": [
    {
      "description": "Certification feed",
      "serviceRootUri": "https://api.example.com/odata",
      "recipientUoi": "M00000000",
      "providerUsi": "99999",
      "token": "your-bearer-token"
    }
  ]
}
```

All three identifiers appear in the output path as `{providerUoi}-{providerUsi}/{recipientUoi}`. One left out of the config shows up there as its own name, so a segment reading `providerUsi` means that field was not supplied.

`OriginatingSystemName` and `OriginatingSystemID` scope a feed carrying more than one originating system. **Data Dictionary and Web API Core read them; Add/Edit and EntityEvent ignore them.** Either may sit at entry level or inside that endorsement's options block, where the block wins, and Name takes precedence over ID when both are present.

See [`sample-configs/`](sample-configs/README.md) for a downloadable sample per endorsement and the full field reference.

## Cloud Runs

A cloud run tests your server from RESO's cloud, with RESO's own copy of the tests. It is the run that certifies.
A cloud run starts only at the end of a local run that passed. Run locally with a config file and add
`--start-cloud-run`:

```bash
reso-cert core --config providers.json --start-cloud-run
reso-cert cloud status --in-progress
```

- **Only entries that passed and can be certified are sent.** The others are listed with the reason. When entries
  pass, the CLI reserves a request ID for them with RESO's service, then starts the cloud run from it. Nothing is
  sent before a pass.
- **Each entry is sent as it ran**, including any flag that changed it, such as `--auth-token` or
  `--field-overrides`, with a record of the local run that passed.
- **Without `--start-cloud-run`, nothing is sent.** A run with entries that could go prints how to send them next
  time. With it, the CLI checks for RESO's service address and credentials before the run, so a long run is not
  wasted.
- **`concurrency`** at the top of the config file tells RESO's cloud how many recipients your API can take at
  once.
- **`reso-cert cloud status`** lists your cloud runs and where each stands, with `--json` for scripts.

Cloud runs cover Web API Core. They sign in with the same `TOKEN_URI`, `CLIENT_ID` and
`CLIENT_SECRET` from your credentials file as the Variations Service (see [Authentication](#authentication)). The
[CLI reference](src/cli/README.md#cloud-runs) has the details.

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

RESO Common Format reads files rather than a server, so it has its own entry point. `rcf` runs it:

```typescript
import { runRcfCompliance } from '@reso-standards/reso-certification';

const result = await runRcfCompliance({
  endorsement: 'rcf',
  input: './property.json',
  schemaValidate: true,
  options: { outputDir: './out' },
});
```

### Computing variations with your own module

A host that runs the SDK can compute a Data Dictionary run's variations with a module of its own instead of the HTTP variations service. Set `RESO_VARIATIONS_HANDLER` to the module's path. The module exports `computeVariations(request)`, which takes the body the service's compute route takes (`metadataReportJson`, `version` and an optional `fuzziness`) and answers what that route answers:

```typescript
import type { ComputeVariationsRequest } from '@reso-standards/reso-certification';

export const computeVariations = async (request: ComputeVariationsRequest) => {
  // Answer what the compute route answers: an object with a `variations` report.
};
```

The variable is an explicit switch. Without it the SDK calls the HTTP service exactly as before. A module that cannot be loaded, exports no `computeVariations`, throws or answers without a variations report fails the variations step with an error that names the variable.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All scenarios passed |
| 1 | One or more scenarios failed |
| 2 | Runtime error, including a cloud run RESO's service refused |

## Docker

### The certification image

Tagged releases publish a public image, so most uses are a pull rather than a build:

```bash
docker pull ghcr.io/resostandards/reso-tools/reso-cert:v0.11.1   # or :latest
```

It is `linux/amd64`. On Apple silicon Docker runs it emulated, which works and is slower.

To build it yourself – from an unreleased branch, or with local changes – note that the image
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

# Data Dictionary
docker compose --profile compliance-dd up --build \
  --exit-code-from compliance-dd
```

Each endorsement also has MongoDB and SQLite profiles, named `<profile>-mongo` and
`<profile>-sqlite`. The Data Dictionary and Web API Core variants need the backend profile enabled
as well, for example `--profile mongodb --profile compliance-dd-mongo`, because they share the
common server. Add/Edit and EntityEvent carry their own database and server inside their own
compliance profile.

## Development

```bash
npm install
npm run build
npm test        # ~1,904 tests
npm run dev     # Watch mode
```

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
