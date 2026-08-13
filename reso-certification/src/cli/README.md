# `reso-cert` — CLI reference

The unified command-line entry point for RESO certification compliance testing.
This is the complete command reference; for a quick start and the SDK API see the
[package README](../../README.md).

```bash
# from a built checkout
node reso-certification/dist/cli/index.js <command> [options]
# or, when installed
reso-cert <command> [options]
```

Every command sets a **process exit code**: `0` = pass / valid, `1` = one or more
failures, `2` = runtime or IO error. Machine-readable output goes to **stdout**; the
human-readable summary goes to **stderr**, so you can pipe `--output json` cleanly.

## Commands at a glance

| Command | What it does |
|---|---|
| [`add-edit`](#add-edit) | RCP-010 Add/Edit endorsement compliance |
| [`entity-event`](#entity-event) | RCP-027 EntityEvent change-tracking compliance |
| [`core`](#core) | Web API Core 2.0.0 / 2.1.0 compliance |
| [`dd`](#dd) | Data Dictionary compliance (replicate + validate a live endpoint) |
| [`metadata`](#metadata) | Validate OData CSDL/EDMX and convert it to a metadata report |
| [`schema validate` / `schema generate`](#schema) | JSON-Schema tools for a metadata report |
| [`replicate`](#replicate) | Pull data from an endpoint using an OData replication strategy |
| [`find-variations`](#find-variations) | DD variations review via the v2 Variations Service |
| [`metadata-report adapt`](#metadata-report-adapt) | Back-fill the `resources[]` block on a DD 2.0/2.1 report |
| [`update-variations`](#update-variations) | Submit reviewed variation suggestions (admin) |

The first four are **endorsement runners** (a full compliance pipeline against a live
server). The rest are **per-step utilities** — each does one stage of a run in isolation,
so you can script the pipeline, debug a single step, or feed its artifact into the next.

## Shared options

**Auth** (endorsement runners, `replicate`, and `find-variations --from-server`):

| Option | Meaning |
|---|---|
| `--auth-token <token>` | Pre-fetched bearer token |
| `--client-id <id>` `--client-secret <secret>` `--token-url <url>` | OAuth2 client-credentials — minted at run time |

**Output** (endorsement runners):

| Option | Meaning |
|---|---|
| `--verbose` | Detailed line-by-line output |
| `--output <console\|json>` | Output format (default `console`) |
| `--output-dir <path>` | Directory for compliance reports |

Per-step utilities take `--output-dir` too, and accept `-` to mean **stdin** (for inputs)
or **stdout** (for `--output-dir -`), so they compose in a pipe.

## Endorsement runners

### `add-edit`
RCP-010 Add/Edit endorsement testing.

```bash
reso-cert add-edit --url https://api.example.com --auth-token TOKEN
reso-cert add-edit --mock                       # against a bundled mock OData server
reso-cert add-edit --config ./configs/add-edit-config.json   # multi-provider batch
```

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | — | Server base URL (mutually exclusive with `--config`) |
| `--config <path>` | — | Config file with one or more provider entries |
| `--resource <name>` | `Property` | OData resource under test |
| `--payloads <dir>` | — | Directory of payload JSON files |
| `--metadata <path>` | — | Local XML metadata (for `--mock`) |
| `--mock` | — | Start a bundled mock OData server |
| `--spec-version <v>` | `2.0.0` | Spec version stamped into the report |

Provide one of `--url`, `--config`, or `--mock`.

### `entity-event`
RCP-027 EntityEvent change-tracking testing.

```bash
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode observe
```

Adds, beyond the shared options: `--mode <observe|full>` (default `observe`; `full`
performs canary writes), `--writable-resource <name>` (default `Property`),
`--payloads-dir <dir>`, `--max-events <n>` (default `1000`), `--batch-size <n>`
(`100`), `--poll-interval <ms>` (`5000`), `--poll-timeout <ms>` (`30000`),
`--metadata <path>`, `--mock`. Provide one of `--url`, `--config`, or `--mock`.

### `core`
Web API Core 2.0.0 / 2.1.0 compliance.

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN --version 2.1.0
```

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | *(required)* | Server base URL |
| `--resources <list>` | well-known list | Comma-separated resource names |
| `--version <2.0.0\|2.1.0>` | `2.0.0` | Spec version |
| `--enum-mode <auto\|string\|collections\|isflags>` | `auto` | How enumerations are represented (auto-detected by default) |
| `--full-coverage` | — | Fail if any data-type category has no coverage across all resources |

### `dd`
Data Dictionary compliance — replicates a live endpoint and validates it against the DD.

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN
reso-cert dd --url https://api.example.com --auth-token TOKEN --strict
```

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | *(required)* | Server base URL |
| `--dd-version <v>` | current DD | DD version (must be a certifiable version) |
| `--limit <n>` | `100000` | Max records replicated per resource |
| `--strict` | — | Fail on variations and enforce JSON-schema validation |
| `--batch-expand` | — | Batch every expansion per resource into one `$expand` request |

## Per-step utilities

### `metadata`
Validate OData CSDL/EDMX (XSD + semantic) and convert it to a RESO-format metadata
report. This is the first cert step and the one that gates the rest — if the metadata
is invalid nothing downstream is meaningful.

```bash
reso-cert metadata -m $metadata.xml -v 2.0 --output-dir ./out
cat $metadata.xml | reso-cert metadata -m - --no-report      # validate only, from stdin
```

`-m, --metadata <path>` (required; `-` for stdin) · `-v, --version <ddVersion>`
(default `2.0`, stamped into the report) · `--odata-version <4.0|4.01>` (auto-detected
when omitted) · `--output-dir <path>` (default `.`; `-` for stdout) · `--no-report`
(validate only). Exit `0` valid / `1` invalid / `2` IO.

### `schema`
JSON-Schema tools for a metadata report.

```bash
reso-cert schema generate -m metadata-report.json --output-dir ./out
reso-cert schema validate -m metadata-report.json -p payload.json --output-dir -
```

- **`schema generate`** — build a JSON Schema from a metadata report. `-m, --metadata`
  (required; `-` stdin) · `-a, --additional-properties` · `--output-dir` (`-` stdout).
- **`schema validate`** — validate a payload against a report's schema. `-m, --metadata`
  (required) · `-p, --payload` (required; an OData collection `{ value: [...] }` or a
  single record; `-` stdin) · `-v, --version` · `-r, --resource` (else inferred from the
  payload `@odata.context`) · `-s, --settings <schema-validation-settings.json>` ·
  `-a, --additional-properties` (default: reject unknown fields) · `--output-dir`.
  Exit `0` pass / `1` schema errors / `2` IO.

### `replicate`
Pull data from a resource (or every resource in a metadata report) using an OData
replication strategy. Writes a data-availability report under `--output-dir`.

```bash
reso-cert replicate -u https://api.example.com -s TimestampDesc -r Property -l 1000 \
  --auth-token TOKEN --output-dir ./out
```

| Option | Meaning |
|---|---|
| `-u, --url <uri>` | *(required)* OData service-root URI |
| `-s, --strategy <s>` | *(required)* `TopAndSkip` \| `TimestampAsc` \| `TimestampDesc` \| `NextLink` |
| `-r, --resource <name>` | Single-resource mode |
| `-m, --metadata <path>` | Report-driven mode — replicate every resource in the report |
| `-x, --expansions <list>` | Comma-separated expansions (single-resource mode) |
| `-f, --filter <expr>` | OData `$filter` |
| `-t, --top <n>` / `--max-page-size <n>` | Page size / `odata.maxpagesize` (NextLink) |
| `--orderby <expr>` | OData `$orderby` |
| `-l, --limit <n>` | Stop after N total records |
| `-v, --version <ddVersion>` | DD version (default `2.0`) |
| `--save-results` | Also write every raw response page to disk |
| `--json-schema-validation` / `--strict` | Validate each payload against the metadata schema / fail on errors |
| `--originating-system-name <v>` / `--originating-system-id <v>` | Append an `OriginatingSystem*` filter to every query |

Auth is via the shared `--auth-token` / OAuth2 flags.

### `find-variations`
DD variations review for a metadata report, computed through the v2 Variations Service
(`/compute`). Emits `data-dictionary-variations.json`.

```bash
reso-cert find-variations -m metadata-report.json --output-dir ./out
reso-cert find-variations --from-server -u https://api.example.com --auth-token TOKEN
```

Exactly one metadata source: `-m, --metadata <file>` (`-` stdin) **or** `--from-server`
with `-u, --url <url>` (fetches and serializes the endpoint's `$metadata` in memory).
`-f, --fuzziness <0–1>` · `-v, --version` · `--output-dir` (`-` stdout). Two auth
contexts: the auth flags authenticate the `--from-server` fetch; the `/compute` call
authenticates to the Variations Service with `.env` service credentials.

### `metadata-report adapt`
Synthesize the top-level `resources[]` block on a DD 2.0/2.1 metadata report so it can
be loaded by tools that expect a DD 2.2-shaped report (notably the Reference Server).
Idempotent — DD 2.2+ reports pass through unchanged.

```bash
reso-cert metadata-report adapt --in report-2.0.json --out report-adapted.json --pretty
```

`--in <path>` (required) · `--out <path>` (required) · `--pretty`.

## Admin

### `update-variations`
Submit human-reviewed variation suggestions from a CSV to the cloud Variations Service.
Auth is an OAuth2 client-credentials token minted from `.env` (`TOKEN_URI` / `CLIENT_ID`
/ `CLIENT_SECRET`); `FT_ADMIN_SECRET` is sent as the admin gate for review-flagged
submissions.

```bash
reso-cert update-variations -s suggestions.csv --admin-review
```

`-s, --suggestions <path>` (required CSV) · `--admin-review` **xor** `--fast-track`
(how the submission is flagged) · `--overwrite` (allow overwriting canonical entries) ·
`--chunk-size <n>` (suggestions per request, default `1000`). The run summary reports
`submitted`, per-status stats, and any `permission-denied` / `validation-failed` /
`corrections` — review those before assuming a clean run.

## Config-file mode

`add-edit` and `entity-event` accept `--config <path>` instead of `--url` to run a batch
of providers from one file (each entry carries its own server URL, UOIs, and optional
per-entry overrides). See the sample configs under
[`sample-configs/`](../../sample-configs/).
