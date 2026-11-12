# `reso-cert` – CLI reference

The unified command-line entry point for RESO certification compliance testing.
This is the complete command reference; for a quick start and the SDK API see the
[package README](https://tools.reso.org/packages/reso-certification/).

```bash
# from a built checkout
node reso-certification/dist/cli/index.js <command> [options]
# or, when installed
reso-cert <command> [options]
```

Every command sets a **process exit code**: `0` = pass / valid, `1` = one or more
failures, `2` = runtime or IO error. Machine-readable output goes to **stdout**; the
human-readable summary goes to **stderr**, so you can pipe `--output json` cleanly.

> **There is no `--version` option on any subcommand.** `--version` belongs to `reso-cert` itself and
> prints the package version, so a subcommand could never receive it: passing it printed the version
> and exited `0` without running the command. Data Dictionary versions are `--dd-version`, the Web API
> Core and Add/Edit spec versions are `--spec-version`.

## Environment (`.env`)

Several commands take their service URL and credentials from the environment rather than from flags,
so a working `.env` is often the difference between a command running and a command refusing.

**Where it is found.** At startup the CLI reads one file. It looks in these places, in order, and the
**first one found wins** – the rest are not read:

1. `credentials.env` in the current working directory, the name the certification site downloads
2. `.env` in the current working directory
3. `.env` in the `reso-certification` package root
4. `.env` in the `reso-tools` monorepo root

A variable already set in the real environment is **never** overwritten by the file, so
`RESO_SERVICES_URL=… npx reso-cert …` overrides whatever the file says. Before a command runs, the CLI
prints which file it read and the **names** of the variables it set, never their values. A value whose name
ends in `SECRET`, `PASSWORD` or `API_KEY` is masked in everything the CLI prints.

**Which environment a run touches is decided by `TOKEN_URI`, and by nothing else.** The one
exception is `archive-report --url`, which names the Cert API host directly and presents the
file's `CLIENT_SECRET` to it, so a `--url` is checked by the person typing it.
`RESO_SERVICES_URL` is the **same value for every environment**, so reading it tells you nothing
about which one you are pointed at. The environment is fixed when the token is minted: authenticating
against the QA certification host produces a token carrying `qa`, the production host produces one
carrying `production`, and every later call reads that off the token. If you want to know which
environment a command will write to, look at the host in `TOKEN_URI`.

### The variables

| Variable | Used by | What it is |
|---|---|---|
| `RESO_SERVICES_URL` | `find-variations`, `rcf`, `update-variations`, the variations-review commands, the `cloud` commands | Base URL of RESO's services, the Variations Service and cloud runs. Same for every environment. |
| `RESO_CLOUD_UPDATES_URL` | `cloud watch` | Address of RESO's live updates on cloud runs, a `wss://` address. A bare host is read as `wss`, and a `ws` address is upgraded unless it is on your own machine. |
| `TOKEN_URI` | the same commands, and `archive-report` | OAuth2 token endpoint. **This is what selects QA versus production.** `archive-report` also reads the Cert API host off it. |
| `CLIENT_ID`, `CLIENT_SECRET` | the same commands, `restore` and `archive-report` | OAuth2 client credentials the token is minted from. `restore` and `archive-report` send `CLIENT_SECRET` only to the token endpoint of the Cert API they call, and present the token it returns. |
| `CERT_API_TOKEN` | `restore` and `archive-report` | A bearer token for the Cert API, used as it is instead of minting one. Set it in the environment or the `.env`; there is no flag, so it never lands in shell history. |
| `FT_ADMIN_SECRET` | `update-variations --fast-track` | Fast Track admin credential. A fast-track submission is refused without it, before any request is made. |
| `CERT_AUTH_API_BASE_URL`, `CERT_AUTH_API_USERNAME`, `CERTIFICATION_API_KEY`, `CURRENT_PROVIDER_UOI` | the SDK's provider-token fallback, and `CERTIFICATION_API_KEY` by `restore` and `archive-report` when neither `CERT_API_TOKEN` nor the client credentials are set | The second auth path, used when the OAuth2 variables are absent. |
| `RESO_VARIATIONS_HANDLER` | the variations step of `dd`, `find-variations` and `rcf` | For a host that runs the SDK: the path of a module whose `computeVariations` computes variations in place of the Variations Service, so no service address or token is needed. Unset, the service is called as usual. See the [package README](https://tools.reso.org/packages/reso-certification/#computing-variations-with-your-own-module). |

**Two auth paths, in that order.** A command first tries an OAuth2 client-credentials token from
`TOKEN_URI` / `CLIENT_ID` / `CLIENT_SECRET`. If those are not configured it falls back to minting a
provider token from the `CERT_AUTH_API_*` set. A command that reports "requires authentication" is
telling you neither set is complete, not that one of them was rejected – a rejected credential
reports separately.

**Nothing here is passed on the command line**, and there is no flag that overrides the service URL.
Commands that talk to a live OData server take their own `--url`, `--auth-token` and
`--client-id`/`--client-secret`/`--token-url`; those are for the *provider's* endpoint and are a
different thing from the RESO service credentials above.

## Commands at a glance

| Command | What it does |
|---|---|
| [`add-edit`](#add-edit) | RCP-010 Add/Edit endorsement compliance |
| [`entity-event`](#entity-event) | RCP-027 EntityEvent change-tracking compliance |
| [`core`](#core) | Web API Core 2.1.0 compliance |
| [`dd`](#dd) | Data Dictionary 2.1 compliance (replicate + validate a live endpoint) |
| [`metadata`](#metadata) | Validate OData CSDL/EDMX and convert it to a metadata report |
| [`schema validate` / `schema generate`](#schema) | JSON-Schema tools for a metadata report |
| [`replicate`](#replicate) | Pull data from an endpoint using an OData replication strategy |
| [`find-variations`](#find-variations) | DD variations review via the v2 Variations Service |
| [`rcf`](#rcf) | RESO Common Format: infer a metadata report from payload data and run variations |
| [`metadata-report adapt`](#metadata-report-adapt) | Back-fill the `resources[]` block on a DD 2.0/2.1 report |
| [`update-variations`](#update-variations) | Submit reviewed variation suggestions (admin) |
| [`submit-variations-report`](#submit-variations-report) | Send a DD or rcf run's variations report to start or refresh a review |
| [`submit-variation-decisions`](#submit-variation-decisions) | Mark a report from a sheet of actions and comments, and submit it |
| [`apply-variation-decisions`](#apply-variation-decisions) | RESO staff: apply a sheet of actions and comments to a review already open, as a merge |
| [`list-variation-reviews`](#list-variation-reviews) | The variations in review – yours as a provider, the whole pool as an admin (read-only) |
| [`variations-review-status`](#variations-review-status) | Where each variations submission stands (read-only) |
| [`cloud status`](#cloud-status) | Your cloud runs and where each stands (read-only) |
| [`cloud watch`](#cloud-watch) | Follow your cloud runs live, and wait on many with `--until-done` (read-only) |
| [`restore`](#restore) | Restore to a Cert API: a run's stored results, published as the run would have, or a certification server backup (admin) |
| [`archive-report`](#archive-report) | Archive a certification report, with the site's warning first, and only with `--confirm` |

The first four are **endorsement runners** (a full compliance pipeline against a live
server). The rest are **per-step utilities** – each does one stage of a run in isolation,
so you can script the pipeline, debug a single step, or feed its artifact into the next.

## Shared options

**Auth** (endorsement runners, `replicate`, and `find-variations --from-server`):

| Option | Meaning |
|---|---|
| `--auth-token <token>` | Pre-fetched bearer token |
| `--client-id <id>` `--client-secret <secret>` `--token-url <url>` | OAuth2 client-credentials – minted at run time |

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
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./payloads \
  --actions create,update,delete --create-formats representation,minimal --update-formats representation,minimal
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./payloads --actions update --update-formats minimal
reso-cert add-edit --url http://localhost:8080 --auth-token admin-token --auto-payloads --actions create --create-formats minimal   # the reference server
reso-cert add-edit --mock --actions delete      # against a bundled mock OData server
reso-cert add-edit --config ./configs/add-edit-config.json   # multi-provider batch
```

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | – | Server base URL (mutually exclusive with `--config`) |
| `--config <path>` | – | Config file with one or more provider entries |
| `--resource <name>` | `Property` | OData resource under test |
| `--payloads <dir>` | – | Directory of payload JSON files: the two for each action tested |
| `--actions <list>` | all | The actions to test: `create`, `update`, `delete` |
| `--create-formats <list>` | both | The create responses to test: `representation`, `minimal` |
| `--update-formats <list>` | both | The update responses to test: `representation`, `minimal` |
| `--auto-payloads` | – | The tool writes the payloads, for Property, as on the reference server |
| `--metadata <path>` | – | Local XML metadata (for `--mock`) |
| `--mock` | – | Start a bundled mock OData server, which writes its own payloads unless `--payloads` gives them |
| `--spec-version <v>` | `2.0.0` | Spec version stamped into the report. Add/Edit has one version, 2.0.0 (RCP-10, ratified December 2023), so any other is refused |
| `--start-cloud-run` | – | At the end, start a certification run in RESO's cloud for the entries that passed and can be certified, with the payloads they used. Needs `--config`. See [Cloud runs](#cloud-runs). |

Provide one of `--url`, `--config`, or `--mock`, and the payloads one way: `--payloads`, a config file's `payloads` or `--auto-payloads`. With `--config`, `--actions`, the format options and `--auto-payloads` apply to every entry.

### `entity-event`
RCP-027 EntityEvent change-tracking testing.

```bash
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode observe
```

Adds, beyond the shared options: `--mode <observe|full>` (default `observe`; `full`
performs canary writes), `--writable-resource <name>` (default `Property`),
`--payloads-dir <dir>`, `--max-events <n>` (default `1000`), `--batch-size <n>`
(`100`), `--poll-interval <ms>` (`5000`), `--poll-timeout <ms>` (`30000`),
`--metadata <path>`, `--mock`, `--start-cloud-run` (needs `--config`; see [Cloud runs](#cloud-runs)). Provide one
of `--url`, `--config`, or `--mock`.

### `core`
Web API Core 2.1.0 compliance. Core 2.0.0 remains selectable per run, as a retest. Only 2.1.0, the latest minor, certifies.

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN --spec-version 2.1.0
```

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | – | Server base URL (mutually exclusive with `--config`) |
| `--config <path>` | – | Config file with one or more provider entries |
| `--resources <list>` | well-known list | Comma-separated resource names |
| `--spec-version <2.0.0\|2.1.0>` | `2.1.0` | Spec version. Only 2.1.0, the latest minor, certifies, so a 2.0.0 run is a retest. Config-file mode takes the version from the config entry and ignores this flag. |
| `--enum-mode <auto\|string\|collections\|isflags>` | `auto` | How enumerations are represented (auto-detected by default) |
| `--field-overrides <list>` | _(auto)_ | Comma-separated `Resource.Field` (a bare `Field` is not accepted). The named field **replaces** automatic selection for its data type on that resource, and for an enumeration for its own representation: it is the field tested, nothing automatic sits behind it, and a field the service will not filter on fails its test. Name two fields of the same type and both are tried, in the order written. A **sparse** override: every slot not named here is still auto-selected. An entry that resolves to nothing leaves its slot automatic and is reported as unmatched. Replaces `coreOptions.fieldOverrides` from a config rather than merging with it. |
| `--prefer-fields <list>` | – | **Removed in 0.11.1.** Prints an explanation and is ignored. Use `--field-overrides`; note that the behavior changed from re-ordering candidates to replacing them, so a named field now owns its outcome. |
| `--full-coverage` | – | Fail the run if any data type is not met on some resource tested (every run records whether it was) |
| `--originating-system-name <v>` | – | Scope resource queries to `OriginatingSystemName eq <v>` (multi-tenant providers) |
| `--originating-system-id <v>` | – | Scope by `OriginatingSystemID` instead. Used only when no name is given |
| `--save-payloads <dir>` | *(off)* | Write every request and response to `<dir>`. See below. |
| `--start-cloud-run` | – | At the end, start a certification run in RESO's cloud for the entries that passed and can be certified. Needs `--config`. See [Cloud runs](#cloud-runs). |

Provide one of `--url` or `--config`.

**`--save-payloads`** records what the server actually returned, which the compliance report does
not: the report keeps each scenario's `requestUrl` and no body, and a response body is retained only
as error detail. A run that passes therefore leaves nothing to inspect. That is enough to audit a
skip, since a skipped scenario issues no request at all, and not enough to audit a pass: whether an
assertion read what it meant to read cannot be checked after the fact.

Two files per request, sharing a stem so they sort together:

```
0002-get-Property-top-1000.json        the response body, byte for byte as it arrived
0002-get-Property-top-1000.meta.json   method, url, status, headers, body size
```

The body is written exactly as it came off the wire rather than re-serialized from the parsed
object, so key order and `Edm.Decimal` precision are preserved and the file is what the server sent.
`$metadata` is saved as `.xml`, following the response's own content type.

Headers are kept by **allowlist** and everything else is dropped, so no credential is written: the
bearer token is never carried over, and a header reaches a file only by being named in
`KEPT_HEADERS`. The list is the OData protocol family, `Accept` / `Content-Type`,
`Accept-Language` / `Content-Language`, `Prefer` / `Preference-Applied`, `Retry-After` and
`WWW-Authenticate` – each one a header the RESO specs or the protocol turn on. `WWW-Authenticate`
is a server challenge and is kept deliberately: it is what names the expected scheme on a 401.

Off unless the flag is given. A capture is a copy of a provider's data on disk, and it is large –
one resource against a reference server produced 23 MB from a single page request. Point it outside
the repository; `.gitignore` catches the conventional directory names and not an arbitrary path.

### `dd`
Data Dictionary 2.1 compliance – replicates a live endpoint and validates it against the DD.
DD 2.0 remains selectable per run, as a retest. Only 2.1, the latest minor, certifies.

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN
reso-cert dd --url https://api.example.com --auth-token TOKEN --dd-version 2.0
reso-cert dd --config ./sample-configs/dd-config.json        # multi-provider batch
```

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | – | Server base URL (mutually exclusive with `--config`) |
| `--config <path>` | – | Config file with one or more provider entries |
| `--dd-version <v>` | `2.1` | DD version. 2.0 and 2.1 run, and only 2.1, the latest minor, certifies, so a 2.0 run is **not eligible for certification**. Anything else is refused, 1.7 included. In config-file mode the entry's version stands unless this flag is given |
| `--limit <n>` | `100000` | Max records replicated per resource. Certification samples up to 100,000; raise it for a larger sample, which certifies. A limit below 100,000 is for local testing: the run is **not eligible for certification** and starts no cloud run |
| `--strict` | on | Fail the run on JSON-schema validation errors. On by default, so this flag is only needed to be explicit. Variations fail a run independently of this setting |
| `--no-strict` | – | Record schema-validation errors without failing on them, so a long run surveys everything to fix. Validation still runs. The run is **not eligible for certification** and says so in its verdict |
| `--skip-variations` | – | Do not check variations. The run is **not** eligible for certification |
| `--batch-expand` | – | Batch every expansion per resource into one `$expand` request |
| `--originating-system-name <v>` | – | Append `OriginatingSystemName eq <v>` to every replication query (multi-tenant providers) |
| `--originating-system-id <v>` | – | Append `OriginatingSystemID` instead. Used only when no name is given |
| `--start-cloud-run` | – | At the end, start a certification run in RESO's cloud for the entries that passed and can be certified. Needs `--config`. See [Cloud runs](#cloud-runs). |

Provide one of `--url` or `--config`.

The variations step computes through the Variations Service. It authenticates with the OAuth2
client-credentials token minted from `.env` (`TOKEN_URI` / `CLIENT_ID` / `CLIENT_SECRET`), the
same way `find-variations` does, so a run computes against the environment those credentials
belong to; with them absent it falls back to the `CERT_AUTH_API_*` provider-token mint. In
`--config` mode every entry's report lands as `variations-report.json` under the output dir.

`--skip-variations` exists for environments with no Variations Service to reach, such as a
continuous-integration run against the reference server. It reports the step as skipped rather than
omitting it, and because the Data Dictionary requires every step to have passed, the run is recorded
as not eligible for certification: `report-detailed.json` carries a `certification` object naming the
step, and the run summary prints a `Not eligible for certification` line. The run's `outcome` is
unaffected – it still describes what happened while the run executed. An absent
`RESO_SERVICES_URL` is never treated as a skip; that still fails the run, so a misconfigured machine
cannot quietly stop checking variations.

Certification samples up to 100,000 records per resource, and a server with fewer gives all it has.
A sample limit, from `--limit` or a config entry's `ddOptions.limit`, of 100,000 or more is a larger
sample: it certifies, and a cloud run started from it samples the same. A limit below 100,000 is for
local testing: the run measures less than certification samples, so its verdict says it is not
eligible for certification, and `--start-cloud-run` refuses it before anything runs. Remove the limit,
or raise it to 100,000 or more, to start a cloud run. With neither set the run reads the default.

## Per-step utilities

### `metadata`
Validate OData CSDL/EDMX (XSD + semantic) and convert it to a RESO-format metadata
report. This is the first cert step and the one that gates the rest – if the metadata
is invalid nothing downstream is meaningful.

```bash
reso-cert metadata -m metadata.xml --dd-version 2.0 --output-dir ./out
cat metadata.xml | reso-cert metadata -m - --no-report       # validate only, from stdin
```

`-m, --metadata <path>` (required; `-` for stdin) · `--dd-version <ddVersion>`
(default `2.1`, stamped into the report) · `--odata-version <4.0|4.01>` (auto-detected
when omitted) · `--output-dir <path>` (default `.`; `-` for stdout) · `--no-report`
(validate only). Exit `0` valid / `1` invalid / `2` IO.

### `schema`
JSON-Schema tools for a metadata report.

```bash
reso-cert schema generate -m metadata-report.json --output-dir ./out
reso-cert schema validate -m metadata-report.json -p payload.json --output-dir -
```

- **`schema generate`** – build a JSON Schema from a metadata report. `-m, --metadata`
  (required; `-` stdin) · `-a, --additional-properties` · `--output-dir` (`-` stdout).
- **`schema validate`** – validate a payload against a report's schema. `-m, --metadata`
  (required) · `-p, --payload` (required; an OData collection `{ value: [...] }` or a
  single record; `-` stdin) · `--dd-version` (default `2.1`) · `-r, --resource` (else inferred from the
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
| `-m, --metadata <path>` | Report-driven mode – replicate every resource in the report |
| `-x, --expansions <list>` | Comma-separated expansions (single-resource mode) |
| `-f, --filter <expr>` | OData `$filter` |
| `-t, --top <n>` / `--max-page-size <n>` | Page size / `odata.maxpagesize` (NextLink) |
| `--orderby <expr>` | OData `$orderby` |
| `-l, --limit <n>` | Stop after N total records |
| `--dd-version <ddVersion>` | DD version (default `2.1`) |
| `--save-results` | Also write every raw response page to disk |
| `--json-schema-validation` | Validate each payload against the metadata schema (requires `--metadata`) |
| `--strict` / `--no-strict` | Fail on validation errors, or record them without failing. Strict is the default, and is inert unless validation is on |
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
`-f, --fuzziness <0–1>` · `--dd-version` (default `2.1`) · `--output-dir` (`-` stdout). Two auth
contexts: the auth flags authenticate the `--from-server` fetch; the `/compute` call
authenticates to the Variations Service with `.env` service credentials.

### `rcf`
RESO Common Format certification. An RCF provider delivers data rather than a schema, so there is no
`$metadata` to read: `rcf` infers the metadata report and the data-availability report from the payloads,
then runs variations against the inferred report. It schema-validates every record against the DD
first. Both checks run by default, because certification needs both. `--skip-schema-validation` and
`--skip-variations` turn one off, and the run is then not eligible for certification.

```bash
reso-cert rcf -i ./rcf-export/ --output-dir ./out
reso-cert rcf -i payloads.zip --skip-schema-validation --output-dir ./out   # inference only, not eligible
reso-cert rcf -i payload.json --skip-variations --output-dir ./out   # offline, no credentials

# Variations for review: name the provider, system and recipient, then submit what rcf wrote
reso-cert rcf -i ./rcf-export/ --output-dir ./out --provider-uoi <UOI> --provider-usi <USI> --recipient-uoi <UOI>
reso-cert submit-variations-report --report ./out/variations-report.json
```

`-i, --input <path>` (required; a `.json` file, a `.zip` or a directory of payloads or records) ·
`--dd-version <v>` · `-f, --fuzziness <0–1>` (default `0.25`) · `--skip-schema-validation` · `--strict`
(fail on the first schema error) · `--skip-variations` · `--schema-validate` (accepted, the default) ·
`-a, --additional-properties` (accepted and inert: RCF is always extensible) · `--output-dir <path>`
(default `.`) · `--provider-uoi <uoi>` · `--provider-usi <usi>` · `--recipient-uoi <uoi>` (all three or
none) · `--start-cloud-run` (needs all three; see [Cloud runs](#cloud-runs)).

Writes `metadata-report.json` and `data-availability-report.json`, plus
`data-dictionary-variations.json` when the variations step runs. RCF accepts a lookup value in its
machine-friendly Legacy OData form (`ComingSoon` for `Coming Soon`) until DD 3.0, so such values are not
variations: the service lists them under `deprecations` in that file, and `rcf` says how many there are,
with a few examples. Given the provider, system and recipient,
it also writes `variations-report.json` when variations are found: the file a DD run writes, which
`submit-variations-report` takes to start a review. A partial set of the three stops the run before it
starts. The run version is `--dd-version` when
given, else the version in the payload's `@reso.context`, else DD 2.0. The variations call authenticates
with the `.env` service credentials, as `find-variations` does. `--skip-variations` mints no token, so an
inference-only run needs none.

Exit `0` pass / `1` schema errors / `2` nothing certifiable ingested or a variations pass that degraded.
A file whose `@reso.context` cannot be read is a schema error, and a `2` under
`--skip-schema-validation`, so an unreadable submission never reads as a clean pass. A variations outage leaves both reports on
disk and names the reason. An auth misconfiguration is the exception: the run cannot do what was
asked, so it fails with nothing written.

### `metadata-report adapt`
Synthesize the top-level `resources[]` block on a DD 2.0/2.1 metadata report so it can
be loaded by tools that expect a DD 2.2-shaped report (notably the Reference Server).
Idempotent – DD 2.2+ reports pass through unchanged.

```bash
reso-cert metadata-report adapt --in report-2.0.json --out report-adapted.json --pretty
```

`--in <path>` (required) · `--out <path>` (required) · `--pretty`.

## Admin

### `update-variations`
Submit human-reviewed variation suggestions from a CSV to the cloud Variations Service.
Auth is an OAuth2 client-credentials token minted from `.env`.

```bash
reso-cert update-variations -s suggestions.csv --admin-review
```

`-s, --suggestions <path>` (required CSV) · `--admin-review` **xor** `--fast-track`
(how the submission is flagged) · `--overwrite` (allow overwriting canonical entries) ·
`--chunk-size <n>` (suggestions per request, default `1000`). The run summary reports
`submitted`, per-status stats, and any `permission-denied` / `validation-failed` /
`corrections` – review those before assuming a clean run.

**Sheet columns.** Headers are matched case-insensitively and trimmed; anything unrecognized is
reported as skipped rather than dropped silently.

| Column | |
|---|---|
| `Resource Name` | required on every row |
| `Field Name`, `Lookup Value` | what the row is about |
| `Suggested Resource Name`, `Suggested Field Name`, `Suggested Lookup Value` | the target |
| `Suggested Standard Lookup Value`, `Suggested Legacy OData Value` | a lookup target, by display name or legacy value |
| `Suggested Related Resource Name`, `Suggested Related Field Name`, `Suggested Related Lookup Value` | an expansion target |
| `Strategy` | how the mapping was arrived at: `Substring`, `Edit Distance`, `Fast Track`, `Admin Review` |
| `Outcome` | |

A row must name a target with **any one** of the suggested columns, or carry an `Outcome`. A row
that does neither is refused by name, for example `row 3 (Property.OpenHouse)`, because it would
ask for nothing. `Strategy` alone will not carry a row; it says where a mapping came from, not
what the mapping is.

This is the same shape `list-variation-reviews --csv` writes, so a review exports, gets edited and
goes back in without reshaping the file.

### `submit-variations-report`
Send the `variations-report.json` a DD run produced, or an `rcf` run given the provider, system and
recipient, to the Variations Service, which starts a review or refreshes one. The whole report goes up, buckets and all, and the service builds the
pool rows from it – so each row keeps the matcher's suggestions, the strategy that produced its
mapping, and the element level.

```bash
reso-cert submit-variations-report --report out/.../variations-report.json
reso-cert submit-variations-report --report <path> --dry-run     # contacts nothing
reso-cert submit-variations-report --report <path> --overwrite   # proceed over an existing pending review
```

`-r, --report <path>` (required) · `--overwrite` · `--dry-run` · `--json`.

A fresh submission is a full replace of that report's review rows, declared explicitly rather
than inferred, so an omission is read as a delta and never as a destructive operation.
`--overwrite` proceeds over an existing **pending review**; it never proceeds over a **lock**,
which means somebody is reviewing right now. A dry run contacts nothing and so needs no
credentials.

### `submit-variation-decisions`
Apply a sheet of actions and comments to a variations report, then submit it. This is the review
loop for anyone without the desktop client: export, edit, submit.

```bash
reso-cert list-variation-reviews --status pending --csv > review.csv
# fill in Action on the rows you decided
reso-cert submit-variation-decisions --report variations-report.json --decisions review.csv
```

The sheet's `Action` column takes `ignore`, `remove` or `submit-to-ft`. A row names an element and
the sheet says what to do with it; the report's own suggestions carry their provenance, so nothing
about the mapping needs restating.

**Deciding on a subset is normal.** Rows with no `Action` and no `Comment` are left as they are and
reported by name, so a row you left blank on purpose and a row whose `Action` you mistyped are
both visible rather than one of them passing as a no-op. A sheet where *no* row asks for anything
is refused, because nothing would be submitted.

One push carries the whole sheet. If any row is unusable the report is returned unchanged rather
than half-applied, so you never have to work out which rows landed.

### `apply-variation-decisions`
For RESO staff. Apply a sheet of actions and comments to a variations report that is **already
under review**, as a merge: only the items the sheet names change, and every other item, comment
and decision on the review stays as it was. `submit-variation-decisions` is the other half: it
marks the report a run wrote and submits it, which starts or replaces the review.

```bash
reso-cert list-variation-reviews --status pending --csv > review.csv
# fill in Action and Comment on the rows you decided
reso-cert apply-variation-decisions --provider-uoi <uoi> --provider-usi <usi> --recipient-uoi <uoi> \
  [--dd-version 2.1] --decisions review.csv --dry-run
reso-cert apply-variation-decisions --provider-uoi <uoi> --provider-usi <usi> --recipient-uoi <uoi> \
  [--dd-version 2.1] --decisions review.csv
```

The review is read first, and every row must name an item on it, by its values exactly as the
review holds them. If any row is unusable nothing is sent. The dry run prints each item that would
change, with the decision it replaces and whether a comment goes with it, and sends nothing.

`Action` takes `ignore`, `remove` or `submit-to-ft`. A row with only a `Comment` keeps the item's
decision. Comments are written as RESO's, to the provider the review is about.

**Running it twice is safe.** An item already as the sheet says is left alone, and a comment
already on its thread is not sent again, so a second run reports nothing to change.

After the save, the review is read back and each item is checked: the command says so if any item
does not show what was sent. A review someone is working on (a lock) is not changed; the command
names who holds it.

### `restore`

Restore to a Cert API from a local directory. What the directory holds decides what is restored:

- **A run's stored results** are published as the run itself would have published them.
- **A certification server backup** is walked, and each report is posted to the restore endpoint as it is.

Both start as a dry run that prints what would be sent, and send nothing without `--execute`.

```bash
reso-cert restore --path <dir> [--url <cert api>] [--execute] [--notify-provider] [--limit n]
```

| Option | Meaning |
|---|---|
| `--path <dir>` | A stored run, or any directory above stored runs; or a backup root. Required. |
| `--url <url>` | The Cert API origin. Without it, the origin of `TOKEN_URI` in the credentials file. |
| `--execute` | Actually send. Without it the command is a dry run and nothing is posted. |
| `--notify-provider` | Stored runs: email each provider the passed notice, once both of its reports are on file. |
| `--limit <n>` | Stop after this many runs or reports, for a smoke test. |
| `--ledger <path>` | Where restored runs or reports are recorded. Default `.restore-ledger` in `--path`. |
| `--concurrency <n>` | Backups: reports in flight at once. Default 4. |
| `--derive-missing-type` | Backups: supply a missing report type, only where the directory and the report's own version agree. |

**A stored run** is a results directory kept in the layout the results store uses:

```
<endorsement>-<version>/<providerUoi>-<providerUsi>/<recipientUoi>/<run>/
    metadata-report.json  data-availability-report.json  report.json  ...
```

- **Whose run it is comes from that path,** never from a flag that could disagree with it. A directory that
  holds a run's files without the layout is skipped and named.
- **Only a Data Dictionary run that passed and is certifiable** is published, as `report.json` records it. A
  failed result posted over a provider's standing passed report would replace it, so a failed run is
  refused. A certified or revoked report is never replaced by the API.
- **It publishes as the run would have:** the metadata report, cut to the keys the report route accepts, then
  the availability report against the report id that post returned. The provider is emailed only with
  `--notify-provider`, after both reports are on file.

**A backup** is the root holding the endorsement-type folders.

- **Archived reports are recognized by where they sit.** The backup keeps them under their own
  `archived/` tree, and there is no flag that could mark a live report archived.
- **A report written before the type field existed is refused by the server** unless
  `--derive-missing-type` supplies the type. It is supplied only when the endorsement directory's version
  matches the version inside the report. One source alone would be a guess.

For both:

- **A rerun resumes.** Every run or report that lands is recorded in the ledger, and a later run skips it.
- **The credential comes from the credentials file.** The command exchanges `CLIENT_ID` and `CLIENT_SECRET`
  at the Cert API's own token endpoint (`TOKEN_URI`) and presents the token it gets back. `CLIENT_SECRET`
  is sent nowhere else, and a `TOKEN_URI` on another host than the Cert API is refused before any request.
  `CERT_API_TOKEN` gives a bearer token directly instead. A dry run needs no credential.
- **Exit code** `0` when everything was sent or would be, `1` when any run or report failed or was refused,
  and `2` on an error such as a missing credential.

## Certification reports

### `archive-report`

Archive a certification report, as the certification site does from a report's page. The command
reads the report, shows the same warning the site shows, and archives only when `--confirm` is
given. It is for the provider the report belongs to, or an administrator.

```bash
reso-cert archive-report <reportId>              # shows the warning, archives nothing
reso-cert archive-report <reportId> --confirm    # shows the warning, then archives
reso-cert archive-report <reportId> --confirm --json
```

| Option | Meaning |
|---|---|
| `<reportId>` | The report's id, as the certification site shows it. |
| `--confirm` | Archive the report. Without it the warning is printed and nothing is archived. |
| `--url <url>` | The Cert API origin, such as `https://cert-api.example.org`, without a path. Default: taken from `TOKEN_URI`. The API is expected at an origin's root: an API mounted under a path prefix cannot be named, by `--url` or by `TOKEN_URI`. A host without a dot that is not loopback, such as the `undefined` older credentials files carried, is refused. |
| `--json` | Print one object: `reportId`, `origin`, `warning`, `report`, `confirmed`, `archived`, `status`, `reread`, `message`. `archived` is true only when the server confirmed with `201 success`. `reread` is present after any other archive answer (see below). `message` is the server's words after an archive request, and before one it is the line the command printed. |

- **It needs the credentials file downloaded from the certification site.** Sign in, download
  `credentials.env`, and run the command from the directory that holds it (see
  [Environment](#environment-env)). The file's `CLIENT_SECRET`, or `CERTIFICATION_API_KEY` when
  that is absent, is what the command presents, and the Cert API is found through the host in its
  `TOKEN_URI`. A `TOKEN_URI` whose path is not the token endpoint, or whose host cannot be the API,
  is refused rather than guessed from, and `--url` names the API instead.
- **The warning is the site's.** The report is read first, then the provider organization's name
  when the provider and recipient differ, and the warning is printed with those values filled in:

  ```text
  Archive Endorsement?

  By proceeding, the Data Dictionary 2.0 Endorsement for Example MLS will no longer be available in the RESO Certification System.
  You will receive a notification it's been archived.

  Nothing was archived. Rerun with --confirm to proceed.
  ```

  When the organization's name cannot be read, its UOI is shown in its place and the command says
  so. A report that cannot be read, or that does not exist, archives nothing.
- **With `--confirm`, exactly one archive request is made,** the same one the site makes, and only
  after the warning. The server's `201 success` is the only answer counted as archived. Any other
  answer is reported as "The server did not confirm the archive" with its status and the server's
  message, including a `200` that carries HTML, which is what the certification site's own host
  answers. The report is then **read again**, because the server removes a report before it sends
  the notification and answers only after, so an answer that is not `201` does not say whether the
  report is still there. The second read is reported in the next line and in `--json` as `reread`:
  `listed` means it was not archived, `gone` means the server removed it but something after the
  removal failed, so check the certification site for it rather than rerunning the command, and
  `unreadable` means the second read failed and nothing is known.
- **A redirect is never followed.** A `3xx` from the Cert API is reported with its status like any
  other answer, so the archive request is never replayed to a host that was not named.
- **Exit code** `0` when the server confirmed the archive, or the warning was shown without
  `--confirm`, `1` when the server did not confirm it or the report could not be read, and `2` on a
  usage or configuration error such as a missing credential, a missing Cert API address or a
  malformed id.

## Variations review (read-only)

Both read the same routes the web client's review page uses, with the same auth as
`update-variations` (an OAuth2 client-credentials token from `.env`, falling back to the
`CERT_AUTH_API_*` provider-token mint). Neither writes anything.

### `list-variation-reviews`
The items in the review pool: a provider token sees its own rows, an admin token the
org-wide pool. One line per variation key, collapsed across every tuple that flagged it.

```bash
reso-cert list-variation-reviews --status pending
reso-cert list-variation-reviews --status pending --provenance   # every submitting tuple under each item
reso-cert list-variation-reviews --element-type lookup --json    # exactly what the service returned
reso-cert list-variation-reviews --status pending --csv > review.csv   # a sheet to edit and submit back
```

`--status <pending|ft-submitted|resolved>` · `--element-type <resource|field|lookup>` ·
`--provenance` (one line per submitting tuple: when, which provider/USI/recipient, by whom,
environment, role) · `--page-size <n>` (items per request; every page is fetched regardless) ·
`--json` · `--csv`. The summary table shows the mapping, the strategy where the
pool holds one, the tuple count and the earliest submission.

**`--csv`** writes the sheet the desktop client exports, plus `Strategy`, `Status` and empty
`Action` and `Comment` columns. That makes it a template rather than a report: fill in `Action`
and feed the same file to `submit-variation-decisions` without reshaping it. Rows go to stdout
and the item count to stderr, so `> review.csv` yields a clean file.

```bash
reso-cert list-variation-reviews --status pending --csv > review.csv
# fill in Action on the rows you decided; leave the rest blank
reso-cert submit-variation-decisions --report variations-report.json --decisions review.csv
```

A row the pool holds with no suggested mapping at all cannot be read back: the sheet is
all-or-nothing, and such a row would ask for nothing. The error names the element, for example
`row 3 (Property.OpenHouse)`. Those rows are unreviewable in the pool too, so the fix is to
resolve or remove them rather than to edit the sheet.

### `variations-review-status`
Your submissions with their `lifecycle` and `review` status, one line each.

```bash
reso-cert variations-review-status
reso-cert variations-review-status --review-status in-review   # admin: every provider's, by review status
```

`--review-status <none|in-review|resolved>` (admin queue instead of your own) · `--json`.

## Cloud runs

A cloud run happens in RESO's cloud rather than on your machine, with RESO's copy of the tests. It is started
only at the end of a local run that passed, never on its own. The cloud run is the one that certifies.

**At the end of `core`, `dd`, `add-edit` or `entity-event` with `--config`**, when at least one entry passed and
can be certified:

- With `--start-cloud-run`, the CLI reserves a request ID for those entries with RESO's service and starts the
  cloud run from that reservation. Nothing is sent before a pass. A reservation can start a cloud run once,
  within 24 hours, and the newest pass of a recipient is the one that counts.
- Without it, nothing is sent, and the CLI prints one line saying how to send them next time. Nothing waits for
  input.

Entries that failed, stopped or cannot be certified are listed with the reason and never sent. What is sent is
each entry as it ran: its server, its credential and its options, including any flag that changed them, such as
`--auth-token` or `--field-overrides`, plus a record of the local run that passed. An Add/Edit entry carries the
payloads the run used, inline, as the run recorded them when it read its folder or its configuration, and only
those of the actions it tested. A run that recorded none is refused, never re-read. The cloud tests your own
payloads, so `--start-cloud-run` does not go with `--auto-payloads` or `--mock`, and a `dd` run with `--no-strict`
or `--skip-variations` cannot be certified, so it does not go with those either. Each config entry is read before
the run as well: one a cloud run could never start from, because it names no provider, system or recipient, runs a
version RESO does not certify, turns strict mode off, writes its own payloads or gives none, only observes, or
reads its canaries from a folder, is refused before any entry runs, with every reason. The credentials go to RESO's
service with the request and are never printed. Messages go to stderr, so with `--output json` stdout stays the
run's own JSON, and what was started is printed as JSON there too.

A cloud run is addressed to the provider, system and recipient a config file names, so `--start-cloud-run` needs
`--config`, with its `providerUoi`. It also checks, before the run, that `RESO_SERVICES_URL` and one set of the
credentials below are set, and refuses without them. The config file's `concurrency` tells RESO's cloud how many recipients your API can take at once.
Sign-in is the same as the variations commands: an OAuth2 client-credentials token from `.env`, falling back to
the `CERT_AUTH_API_*` provider-token mint.

If RESO's service refuses a request, its reason is printed and the exit code is `2`, even when every local run
passed.

**At the end of `rcf`**, with `--start-cloud-run` and the run addressed with `--provider-uoi`, `--provider-usi` and
`--recipient-uoi`, when the run passed and can be certified:

- The files `rcf` read are packed into one zip, at a low compression level, even a single `.json`. Each file keeps
  the path it had in the input, and a zip inside a folder becomes a folder named for it. The packed zip must carry the
  fingerprint the run recorded of what it read, so a file changed since the run stops it here.
- Over 5 GB packed, it stops and says so. Nothing is uploaded, and the reservation expires unused.
- Otherwise the CLI reserves a request ID, asks RESO's service where to upload, uploads the zip and starts the cloud
  run, naming the upload and the fingerprint. The upload goes straight to storage with its own signed fields, and no
  RESO credential goes with it. The local zip and its folder are removed afterwards, whatever happened.

```bash
reso-cert rcf --input ./rcf-files --provider-uoi <UOI> --provider-usi <USI> --recipient-uoi <UOI> --start-cloud-run
```

The flags are checked before the run, as for Core, so a long run is not wasted: a run with `--skip-schema-validation`
or `--skip-variations` cannot be certified, so `--start-cloud-run` does not go with either. RESO's service switches RESO Common
Format cloud runs on separately: until then it refuses the reservation, and the CLI prints its reason.

### `cloud status`
Your cloud runs, newest change first. One line per recipient of each run: its status, when that last
changed, the report once one is published, and the error or the step it is on.

```bash
reso-cert cloud status --in-progress
reso-cert cloud status --since 2026-10-29T00:00:00Z --status failed,error
```

`--since <time>` (an ISO timestamp or epoch milliseconds) · `--status <list>` (any of `scheduled`,
`running`, `passed`, `failed` and `error`) · `--in-progress` (`scheduled` or `running`; not with
`--status`) · `--limit <n>` · `--json` (the rows exactly as the service returned them).

### `cloud watch`
Your cloud runs as they change, pushed by RESO's service, so there is nothing to poll. This is the way to follow
many runs at once. One line per update: when, the status, the request, the recipient, the endorsement and the report
once one is published. Under the lines, a running tally of the runs watched:

```
2026-11-04T18:05:00  passed     qa-T00000000-1700000000001  M00000123, system 50000  data-dictionary 2.1  report 0000report01
0 scheduled · 3 running · 12 passed · 1 failed · 0 error · 5 of 8 requests finished
```

On a terminal the tally stays on one line and is rewritten in place. When stdout is a pipe or a file, it is printed
once at the start and once at the end, so a log holds only the update lines between them.

```bash
reso-cert cloud watch
reso-cert cloud watch --request qa-T00000000-1700000000001 --request qa-T00000000-1700000000002 --until-done
reso-cert cloud watch --endorsement data-dictionary --json
```

- **What is watched.** With `--request`, those requests, from the start whatever their state. Without it, the runs in
  progress when the watch starts and any run started after. `--endorsement` narrows either.
- **`--until-done`** exits once every watched request has finished: `0` when all passed, `1` when any failed or
  errored. Without `--request` it waits on the runs in progress when it started, and exits at once when there are
  none. A script can start many runs and wait on all of them with one command.
- **The status is read once at the start,** so runs that finished before the watch began are counted. After that the
  updates are relied on. If the connection drops, the watch reconnects and reads the status once more, for what
  changed while it was down.
- **If it cannot stay connected,** it says so, suggests `reso-cert cloud status` and exits `2`. It never falls back to
  polling.
- **Ctrl-C** stops it. That is exit `0`, or `130` with `--until-done` before the runs finished.

`--request <id>` (repeat for more) · `--endorsement <name>` (`data-dictionary`, `web-api-core`, `add-edit`,
`entity-event` or `reso-common-format`; repeat for more) · `--env <name>` (the environment your credentials are for:
`local`, `qa`, `staging` or `production`; read from your runs when left out, and refused when they disagree) ·
`--until-done` · `--json` (each update as the service sent it, one JSON object per line, with the tally on stderr).

It needs `RESO_CLOUD_UPDATES_URL` besides what `cloud status` needs, and checks for all of it before connecting. It
signs in the same way, minting a fresh token each time it connects.

## Config-file mode

`add-edit`, `entity-event`, `core` and `dd` accept `--config <path>` instead of `--url` to run a batch
of providers from one file (each entry carries its own server URL, UOIs, and optional
per-entry overrides). See the sample configs under
[`sample-configs/`](https://github.com/RESOStandards/reso-tools/tree/main/reso-certification/sample-configs).

An optional top-level `concurrency` says how many recipients your API can be tested against at once. The CLI
runs its entries one at a time either way, and a [cloud run](#cloud-runs) sends it to RESO's cloud. It must be a
positive whole number.
