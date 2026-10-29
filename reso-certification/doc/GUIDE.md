# RESO Certification – User Guide

A task-oriented walk-through of the RESO Certification toolkit. This is the package that runs the same compliance tests RESO uses for official certification, against any RESO-compliant OData server, from a command line, a CI pipeline or a programmatic SDK.

If you have ever wondered whether your server actually passes RESO certification before you submit it for the official process, this is the package that answers that question on your laptop.

## Audience

Anyone who needs to know whether a RESO server passes the certification tests. Real examples:

* **MLS and vendor developers** preparing for official RESO certification who want to run the same tests locally before submitting
* **Technology providers** who need to verify their server still passes after every change to the schema, the data or the platform
* **Integrators and consultants** who need to evaluate a third-party server's compliance before recommending or building against it
* **CI pipelines** that run the cert flows on every pull request so regressions are caught before they ship
* **Test engineers** who want a single source of truth for "is this thing actually conformant"
* **AI agents and automation tools** that need to verify a server's behavior end to end as part of a larger workflow

The package covers these endorsements: **Add/Edit (RCP-010)**, **EntityEvent (RCP-027)**, **Web API Core 2.1.0**, **Data Dictionary 2.1** and **RESO Common Format (RCF)**. The same tests RESO runs in the official certification process, available as a CLI, an SDK and a Docker target.

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

The CLI is available as `reso-cert` after install. The SDK exports work in any Node.js 22+ environment. The toolkit is pure TypeScript, built on the **[RESO Client SDK](../reso-client/)** for OData and the **[reso-validation](../reso-validation/)** library for field-level checks.

---

## Running Your First Cert Flow

The simplest possible run is one command and one URL:

```bash
reso-cert core --url https://api.example.com --auth-token YOUR_TOKEN
```

This runs the **Web API Core 2.1.0** compliance test suite against the server at `https://api.example.com`, authenticating with a bearer token. The CLI:

* Fetches the server's `$metadata` to learn the schema
* Samples live data from each resource to find appropriate field values for every test case
* Generates the test scenarios dynamically from the metadata and the sample data
* Runs every scenario in sequence, with a progress spinner so you can see what is happening
* Reports a per-scenario pass/fail summary at the end
* Exits with code 0 if everything passed, 1 if anything failed, 2 if there was a runtime error

You go from "I have a RESO server URL" to "I know exactly which scenarios pass and fail" in one command, with no XML config to edit and no manual test parameter wiring.

---

## Endorsements

The toolkit ships one cert flow per endorsement RESO certifies. Those that test a server share the same CLI shape, the same auth resolution and the same output formats – the only thing that changes is which subcommand you run and what it tests. RESO Common Format tests files instead of a server, so it takes `--input` where they take `--url`.

### Web API Core 2.1.0

The OData query surface. Validates `$filter` across every data type, `$select`, `$orderby`, `$top`, `$skip`, `$count`, enumerations, error code shapes, response metadata and the service document. Version 2.1.0 adds `$expand`, server-driven paging and string-based enum comparisons.

```bash
# Default: the current spec version, 2.1.0
reso-cert core --url https://api.example.com --auth-token TOKEN

# Pin the earlier version
reso-cert core --url https://api.example.com --auth-token TOKEN --spec-version 2.0.0
```

The cert runner samples live records to find good test parameters automatically – it does not need a static config of "use ListPrice = 250000 for the integer test." It looks at what is actually in the server, picks values that exercise each operator and data type, and runs the scenarios against them.

**Overriding which fields it picks.** Sampling takes up to 1,000 records per resource and ranks the
candidates by how populated they are, most to least, with standard fields ahead of local ones. Where
you would rather a particular field be the one on record as exercising a data type, name it:

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN \
  --field-overrides Property.ListPrice,Office.FeedTypes
```

The same list works as `coreOptions.fieldOverrides` in a config file, and in the desktop client under
**Web API Core Options → Field Overrides**. Each entry is `Resource.Field`. A bare field name is not
accepted, because an override is binding and a bare name would apply to every resource carrying that
field.

**A named field is the field that gets tested.** There is no automatic choice behind it. If your
service will not filter on the field you named, that test fails rather than quietly certifying on a
different field – which is the point of naming it, and the difference from how this behaved in 0.11.0.

It is a sparse override rather than a switch, which is the easy thing to get wrong. Naming a field
replaces automatic selection **for its data type on that resource**, and for an enumeration for its
own **representation**; every other type, representation and resource is still chosen automatically.
So naming one field leaves the rest of the run alone.

That representation detail matters on a server that serves more than one enumeration form. RESO
permits a provider to carry `Collection(Edm.String)` and `Collection(Edm.EnumType)` fields side by
side, and each is certified by its own scenarios. Naming one of them does not touch the other.

An entry that does not resolve against the server's metadata is ignored instead of failing the run,
so a typo costs you that one override and nothing else – that slot simply stays automatic, and the
run says which entries landed, which matched nothing, and which were not in `Resource.Field` form.
The flag replaces a config file's list rather than merging with it, so what you typed is exactly what
runs.

> **Changed in 0.11.1.** This was `--prefer-fields` / `coreOptions.preferFields`, it accepted a bare
> field name, and it only moved a field to the front of the candidate list – so a named field that
> the server would not filter on fell through to an automatic one. Both old spellings now print an
> explanation and are ignored rather than being rerouted, because the new behavior is binding and is
> not what a 0.11.0 user asked for.

See [Field Selection](../src/web-api-core/README.md#field-selection) for how the ranking works and
when overriding it is worth doing.

### Data Dictionary 2.1

The metadata and data shape. Validates that the server's metadata document matches the RESO Data Dictionary 2.1 specification, that every declared field maps to a known DD field (or is documented as a local extension), and that the data in each resource is type-correct and lookup-valid.

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN

# Relaxed: record schema validation errors without failing on them, so one pass
# collects everything a feed needs fixed. The run is NOT eligible for certification.
reso-cert dd --url https://api.example.com --auth-token TOKEN --no-strict
```

The DD flow does several things in sequence:

1. **Fetches the metadata** and parses it into a structured report
2. **Merges the Lookup Resource data** so the metadata report knows what every enumerated field can hold
3. **Checks for variations** – fields, lookups and enum values that look like local extensions of the standard DD
4. **Replicates a sample of data** using one of several strategies (full, top-of-file, modification timestamp window)
5. **Validates the replicated records** against the merged metadata

The output is a per-resource report showing what passed, what failed and where the variations are. Strict mode governs schema validation and nothing else: it is on by default, and it fails the run when a replicated record does not validate against the merged metadata. `--no-strict` keeps the run going and records every error instead of stopping at the first, which is how you survey a feed in one pass – at the cost of the run's eligibility, since nothing enforced what it validated. Variations are separate and fail a run whether or not strict is on.

### Add/Edit (RCP-010)

Create, Update and Delete operations with both `representation` and `minimal` response modes. Eight certification scenarios covering the full RCP-010 surface – successful creates, successful updates, successful deletes, validation failures, the right response headers (`Location`, `Preference-Applied`, `OData-EntityId`), the right annotations (`@odata.context`, `@odata.id`, `@odata.editLink`, `@odata.etag`) and the right error format (`error.code`, `error.message`, `error.details[].target`).

```bash
reso-cert add-edit --url https://api.example.com --auth-token TOKEN
```

The runner generates realistic test payloads automatically. It does not need a static fixture file. It samples your server's metadata, picks values that satisfy the type constraints, runs each scenario and verifies the responses match the spec.

### EntityEvent (RCP-027)

Change tracking. Validates the `EntityEvent` resource shape, the sequence numbering, the polling-replication consumer pattern, and the way creates, updates and deletes are surfaced in the feed. Two modes:

```bash
# Observe mode: read-only, validates the existing feed
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode observe

# Full mode: writes canary records to exercise the create/update/delete event paths
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode full
```

**Observe mode** is the safe default for any server you do not own. It only reads the `EntityEvent` feed and validates that what is there conforms to the spec. Nine scenarios covering shape, sequencing and the disambiguation logic.

**Full mode** writes a small number of canary records to exercise the full create → observe → update → observe → delete → observe loop. Twelve scenarios. Use it when you control the server and you want to verify that writes actually produce events with the right shape.

The full polling-replication consumer pattern – how to read the feed, how to disambiguate creates from updates from deletes, how to handle the empty-result-on-follow-up-fetch case – is walked through end to end in Section 4 of the **[RESO MCP Server guide](../reso-mcp-server/)** with verbatim tool calls and responses against the **[RESO Reference Server](../reso-reference-server/)**.

### RESO Common Format (RCF)

RESO Common Format (RCF) data arrives as files of records, with no server and no `$metadata` behind it. `reso-cert rcf` checks those files against the Data Dictionary. It reads the records and works out a metadata report and a data-availability report from them. Then it checks the report for variations: local names that look like near-misses of a standard one.

A small file shows each part. Save this as `property.json`:

```json
{
  "@reso.context": "urn:reso:metadata:2.1:resource:property",
  "value": [
    { "ListingKey": "SAMPLE-1", "StandardStatus": "Active", "PropertyType": "Residential", "ListPrice": 450000, "City": "Anytown", "BedroomTotal": 3 },
    { "ListingKey": "SAMPLE-2", "StandardStatus": "Coming Soon", "PropertyType": "Residential", "ListPrice": 525000, "City": "Anytown", "BedroomTotal": 4 },
    { "ListingKey": "SAMPLE-3", "StandardStatus": "ComingSoon", "PropertyType": "ResidentialLease", "ListPrice": 2400, "City": "Lakeside", "BedroomTotal": 2 },
    { "ListingKey": "SAMPLE-4", "StandardStatus": "Pending", "PropertyType": "Residential", "ListPrice": 389000, "City": "Lakeside", "BedroomTotal": 3 }
  ]
}
```

Every RCF file carries an `@reso.context` that names its resource and its Data Dictionary version, here `Property` and 2.1. The input can be one file, a directory of files or a `.zip`.

```bash
reso-cert rcf --input property.json --output-dir out
```

```
rcf: DD2.1 – 4 records → 1 resources, 6 fields, 6 lookups; 1 variation(s) → /path/to/out
rcf: 2 lookup value(s) use the machine-friendly form, accepted until DD 3.0 and deprecated there (StandardStatus ComingSoon → Coming Soon; PropertyType ResidentialLease → Residential Lease). All are listed under "deprecations" in data-dictionary-variations.json
rcf: to submit these variations for review, run again with --provider-uoi, --provider-usi and --recipient-uoi
```

What it found:

* **One variation.** `BedroomTotal` is one letter away from the standard field `BedroomsTotal`, so it is reported as a near-miss with `BedroomsTotal` as the suggestion. A variation is something to change, or to explain in a review.
* **Two values in their machine-friendly form.** RCF accepts a lookup value written either way: `Coming Soon` or `ComingSoon`. The machine-friendly form is accepted until Data Dictionary 3.0, so `ComingSoon` and `ResidentialLease` are not variations. They are listed as deprecations, each with the standard value it stands for, so they can be changed before 3.0 arrives.
* `Coming Soon` on the second record is already the standard value and raises nothing.

The variations check uses your RESO services credentials, the `credentials.env` the certification site gives you (see [Authentication](#authentication)). `--skip-variations` runs without them and leaves the check out.

#### What the Run Writes

`rcf` writes straight into `--output-dir`:

* `metadata-report.json` – every field and lookup value the records carry, with Data Dictionary fields linked to their Data Dictionary pages
* `data-availability-report.json` – for each field, how many records carry it and what share of all the records that is
* `data-dictionary-variations.json` – the variations, with the deprecations under `deprecations`

What each file contains is in [Reading a Certification Run](RUN-REFERENCE.md#reso-common-format-rcf).

#### Submitting the Variations for Review

Name your organization, your system and the recipient, and `rcf` also writes `variations-report.json`, the file `submit-variations-report` sends to start a review:

```bash
reso-cert rcf --input property.json --output-dir out \
  --provider-uoi <your UOI> --provider-usi <your USI> --recipient-uoi <recipient UOI>
reso-cert submit-variations-report --report out/variations-report.json
```

* **The three go together**, because a review is filed under a provider, a system and a recipient. With only some of them the run stops before it starts and names the ones that are missing.
* **`variations-report.json` is written only when there are variations.** With none, there is nothing to review.

#### Checking Records Against the Data Dictionary Types

```bash
reso-cert rcf --input property.json --output-dir out --schema-validate
```

`--schema-validate` checks each record against the Data Dictionary. RCF is extensible, so local fields and local values are accepted. A field the Data Dictionary defines has to have the right type, though: a `ListPrice` of `"three eighty-nine"` is an error. The run prints how many errors it found and exits with `1`. `--strict` stops at the first one.

#### Which Data Dictionary Version

`--dd-version` when you give it. Otherwise the version in the files' `@reso.context`, which is 2.1 in the sample, and 2.0 when neither says.

#### Exit Codes for `rcf`

| Code | Meaning |
|---|---|
| `0` | The files were read and checked. Variations and deprecations do not change the code, so read them in the report. |
| `1` | Schema errors, with `--schema-validate` |
| `2` | The run could not do what was asked: nothing certifiable was read, a file's `@reso.context` could not be read (with `--schema-validate` that is a schema error, so `1`), the three identity options were incomplete or the variations check could not run |

---

## Authentication

The cert runner supports every auth shape a real RESO server might use. Auth is resolved automatically from the first source that has credentials, in this order:

1. **CLI flags** – `--auth-token` for bearer, or `--client-id` plus `--client-secret` plus `--token-url` for OAuth2 client credentials
2. **Config file** – `--config path/to/config.json` lets each entry in the file specify its own auth
3. **A credentials file** – `credentials.env`, as the certification site hands it out, or a `.env`. The CLI reads the first one it finds at startup, from the places the [CLI reference](../src/cli/README.md#environment-env) lists
4. **Environment variables** – `RESO_AUTH_TOKEN` for bearer, or `RESO_CLIENT_ID` plus `RESO_CLIENT_SECRET` plus `RESO_TOKEN_URI` for client credentials

All four resolvers know about the same set of variables, so a config file in production can be replaced by environment variables in CI without changing the command. The same flag names work everywhere.

```bash
# Bearer token via flag
reso-cert core --url https://api.example.com --auth-token TOKEN

# OAuth2 client credentials via flags
reso-cert core --url https://api.example.com \
  --client-id YOUR_CLIENT_ID \
  --client-secret YOUR_CLIENT_SECRET \
  --token-url https://auth.example.com/oauth/token

# Same OAuth2, via environment variables
RESO_CLIENT_ID=YOUR_CLIENT_ID \
RESO_CLIENT_SECRET=YOUR_CLIENT_SECRET \
RESO_TOKEN_URI=https://auth.example.com/oauth/token \
reso-cert core --url https://api.example.com

# Same OAuth2, from a credentials.env or .env in the working directory, which the CLI reads itself
reso-cert core --url https://api.example.com
```

---

## Configuration Files

Flags are fine for one server. A configuration file is better once you are testing more than one recipient, more than one system or the same server repeatedly, because it keeps the identifiers and the credentials in one place and runs each entry in sequence.

```bash
reso-cert dd --config path/to/config.json
```

A minimal file needs five things: the organization being certified, and then per entry the service root, the recipient, the system and some credentials.

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

### One File Runs Data Dictionary, Web API Core and EntityEvent

**Data Dictionary, Web API Core and EntityEvent all run from that same entry**, with no additions. Every option specific to those endorsements has a default, so the file above works for all three and only the command changes.

**Add/Edit is the exception.** It creates, updates and deletes records, so it has to know what a valid and an invalid record look like for the server under test. Give it `payloads` inline or point it at a directory with `payloadsDir`. Without either it will try to sample the server to build them, which often works but cannot always succeed – an update or delete payload with no key field, and no create payload to chain from, leaves it nothing to act on.

**RESO Common Format takes no entry.** It reads files, so it takes `--input` and needs no server.

### Scoping a Multi-Tenant Feed

A feed that carries records from several originating systems needs to be narrowed to the one being certified, using either `originatingSystemName` or `originatingSystemId`.

Three rules are worth knowing, because each is easy to get wrong:

- **Data Dictionary and Web API Core read them. Add/Edit and EntityEvent ignore them.**
- They may sit at entry level or inside that endorsement's own options block. **The options block wins** when both are set.
- **Name takes precedence over ID** when both are present, so supply one.

```json
{
  "serviceRootUri": "https://api.example.com/odata",
  "recipientUoi": "M00000554",
  "providerUsi": "50039",
  "token": "your-bearer-token",
  "originatingSystemName": "MYSYSTEM"
}
```

### Where the Reports Land

Each run writes to a directory keyed by the identifiers in the config:

```
{output-dir}/{endorsement}-{version}/{providerUoi}-{providerUsi}/{recipientUoi}/current
```

The previous run is moved to `archived/{timestamp}` beside it, so repeated runs against the same server build up a history rather than overwriting one another.

An identifier missing from the config appears in that path as its own name. A segment reading `providerUsi` is therefore a signal that the field was not supplied, rather than a system actually called that.

What lands in that directory, file by file and endorsement by endorsement, is in [Reading a Certification Run](RUN-REFERENCE.md).

### Samples

A downloadable sample for each endorsement, with the full field reference, is in [`sample-configs/`](../sample-configs/README.md).

---

## Running in RESO's Cloud

Testing on your own machine is how you get a server ready. The run that certifies happens in RESO's cloud, with RESO's own copy of the tests, so its result does not depend on anyone's machine.

A cloud run starts from a local run that passed, and there is no other way to start one. Run the local tests from a config file with `--start-cloud-run`. At the end, the CLI sends every entry that passed and can be certified:

```bash
reso-cert core --config providers.json --start-cloud-run
```

```
✔ Feed one – 219 passed, 0 failed, 112 skipped (1.5s)
✖ Feed two – 2 passed, 3 failed (20.0s)
Not sent to RESO's cloud (1):
  ✗ Feed two: it failed
Started Web API Core 2.1.0 in RESO's cloud for T00000000.
Request: test-T00000000-1700000000000
Recipients (1):
  M00000000, system 99999
Follow it with: reso-cert cloud status --in-progress
```

### What Is Sent

When entries pass, the CLI first reserves a request ID for them with RESO's service, and then starts the cloud run from that reservation. Nothing is sent before a pass. A reservation can start a cloud run once, within 24 hours, and if the same recipient passes again, the newest pass is the one that counts.

Each entry goes as it ran: its server, its credential, its originating-system scope and its Core options, including any flag that changed them for the local run, such as `--auth-token` or `--field-overrides`. With it goes a record of the local run that passed: the server it tested, the versions, when it ran and its verdict. The credentials travel to RESO's service with the request, and the CLI never prints them.

An entry that failed, stopped before producing a result or cannot be certified is listed with the reason and not sent.

Without `--start-cloud-run`, nothing is sent. A run with entries that could go says how to send them next time:

```
1 passed and can be certified. To start a certification run in RESO's cloud at the end of a run like this one, add --start-cloud-run.
```

`--start-cloud-run` needs `--config`, because a cloud run is addressed to the provider, system and recipient a config file names, and the file has to name its `providerUoi`. It also needs `RESO_SERVICES_URL` and RESO credentials, which it checks before the run so a long run is not wasted.

### How Many at Once

A config file can tell RESO's cloud how many recipients your API can take at once:

```json
{
  "providerUoi": "T00000000",
  "concurrency": 25,
  "configs": [ ... ]
}
```

It has to be a positive whole number. Your own machine runs a config's entries one at a time either way.

### Following a Cloud Run

```bash
reso-cert cloud status --in-progress
reso-cert cloud status --since 2026-10-29T00:00:00Z --json
```

There is one line per recipient of each run: its status (`scheduled`, `running`, `passed`, `failed` or `error`), when that last changed, the report once one is published, and the error or the step it is on.

Cloud runs cover Web API Core. They sign in with the `TOKEN_URI`, `CLIENT_ID` and `CLIENT_SECRET` from your credentials file, the same as the variations commands. If RESO's service refuses a request, the CLI prints its reason and exits `2`.

---

## Choosing the Output Format

The default output is a progress display with spinners – good for interactive runs where a human is watching. For everything else, there are three other formats:

```bash
# Default: progress with spinners
reso-cert core --url https://api.example.com --auth-token TOKEN

# Verbose: line-by-line, no spinners (good for CI logs)
reso-cert core --url https://api.example.com --auth-token TOKEN --verbose

# JSON: machine-readable structured output
reso-cert core --url https://api.example.com --auth-token TOKEN --output json

# Write structured reports to a directory
reso-cert core --url https://api.example.com --auth-token TOKEN --output-dir ./results
```

**Verbose mode** is the right choice for CI – every step prints on its own line with no terminal control codes, so the output reads cleanly in build logs.

**JSON mode** is the right choice when you are processing the cert results downstream – feeding them into a dashboard, archiving them in a results store or comparing two runs to see what regressed. The JSON shape is stable and matches the SDK's `PipelineResult` type.

**`--output-dir`** writes a structured report tree to disk. Every run writes `report.json` and `report-detailed.json`, and each endorsement writes its own artifacts beside them: Core, Add/Edit and EntityEvent carry per-resource scenario detail inside `report-detailed.json`, while a Data Dictionary run writes its metadata report, its data availability report and its schema validation findings as separate files. See [Reading a Certification Run](RUN-REFERENCE.md) for what each one contains. This is the format the official certification submission expects, so a successful local run can be uploaded directly.

---

## Running Cert from Code

The CLI is a thin wrapper around an SDK that you can call directly from your own application. The SDK is the right entry point when you are embedding cert testing inside another tool – a release pipeline, an admin UI, an MCP tool that runs cert on behalf of an agent.

### Running a Single Cert Flow

```typescript
import { runComplianceTests } from '@reso-standards/reso-certification';

const result = await runComplianceTests(
  {
    endorsement: 'core',
    server: {
      url: 'https://api.example.com',
      auth: { mode: 'token', authToken: 'YOUR_TOKEN' },
    },
  },
  (progress) => {
    console.log(`${progress.step}: ${progress.status}`);
  }
);

if (result.status === 'passed') {
  console.log('All scenarios passed');
} else {
  // Scenario tallies live on the scenario-running step, not on the result itself.
  const scenarios = result.steps.find((s) => s.name === 'Run Core scenarios');
  const { passed = 0, failed = 0 } = scenarios?.counts ?? {};
  console.log(`${failed} of ${passed + failed} scenarios failed`);
}
```

The first argument is the test configuration. The second is an optional progress callback that fires on every step transition – use it to drive a progress bar in a UI, stream lines to a log or post status updates to a chat channel.

### Running Multiple Endorsements in Sequence

For a full cert sweep against a server, run each endorsement and collect the results:

```typescript
import { runComplianceTests } from '@reso-standards/reso-certification';

const server = {
  url: 'https://api.example.com',
  auth: { mode: 'token', authToken: 'YOUR_TOKEN' },
};

const endorsements = ['core', 'dd', 'add-edit', 'entity-event'] as const;
const results = [];

for (const endorsement of endorsements) {
  const result = await runComplianceTests({ endorsement, server });
  results.push({ endorsement, result });
}

const passed = results.filter((r) => r.result.status === 'passed').length;
console.log(`${passed} of ${results.length} endorsements passed`);
```

This is exactly how the **[RESO Desktop Client](https://github.com/RESOStandards/reso-tools/releases/latest)**'s certification UI runs cert in the background while a user watches the progress in real time.

### Using Config Files

For more complex cases – multiple servers, different auth per environment, parameterized test runs – the SDK accepts a config file directly:

```typescript
import { loadConfigFile, configEntryToCore } from '@reso-standards/reso-certification';

const config = await loadConfigFile('./reso-cert.config.json');
for (const entry of config.configs) {
  const coreConfig = configEntryToCore(entry);
  const result = await runComplianceTests(coreConfig);
  console.log(`${entry.name}: ${result.status}`);
}
```

The same config files work from the CLI via `--config`. See the **[`sample-configs/`](https://github.com/RESOStandards/reso-tools/tree/main/reso-certification/sample-configs)** directory for examples.

---

## Metadata Report Utilities

Beyond running cert flows, the package ships a small utility for working with metadata reports outside of a full cert run. Most relevant: the **`metadata-report adapt`** subcommand, which prepares a DD 2.0 or 2.1 metadata report for tools that expect a DD 2.2-shaped report (notably the **[RESO Reference Server](../reso-reference-server/)**'s metadata loader).

```bash
reso-cert metadata-report adapt \
  --in path/to/metadata-report.json \
  --out path/to/adapted-report.json \
  --pretty
```

The utility synthesizes the top-level `resources[]` block on the report from the distinct values in `fields[].resourceName`. DD 2.0 and 2.1 metadata reports do not carry that block (the concept arrives in DD 2.2), and tools that expect it cannot load the report directly without this preprocessing step. Idempotent – running it on a report that already has a populated `resources[]` block returns the file unchanged.

The same logic is exposed via the SDK as `synthesizeResourcesFromFields`:

```typescript
import {
  synthesizeResourcesFromFields,
  type MetadataReport,
} from '@reso-standards/reso-certification';

const adapted: MetadataReport = synthesizeResourcesFromFields(report);
```

This is the workflow that makes the "load any cert metadata report into a local Reference Server, generate matching test data, run cert against it" loop possible. The full story is in the **[RESO Reference Server guide](../reso-reference-server/)**.

---

## Running Cert in Docker

Two different things run in Docker, and they are worth telling apart. To run the certification CLI against a real provider from an image built out of this repository rather than from npm, see [the certification image](../README.md#the-certification-image) – that section also covers the `--user` and output-directory handling a bind mount needs.

The cert flows are *also* wired up as Docker Compose profiles inside the **[RESO Reference Server](../reso-reference-server/)**, so you can run them against a freshly seeded reference server with one command:

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

Each endorsement also has MongoDB and SQLite profiles, named `<profile>-mongo` and `<profile>-sqlite`. The Data Dictionary and Web API Core variants also need the backend profile, because they share `server-mongo` and `server-sqlite`; the Add/Edit and EntityEvent variants carry their own database and server inside their compliance profile and do not, for example `--profile mongodb --profile compliance-dd-mongo`.

Each profile spins up a clean server, seeds it with realistic data, runs the cert flow and exits with the cert result code. This is the form most CI pipelines use because it produces a deterministic, reproducible cert result against a known data set.

---

## Exit Codes

The CLI uses three exit codes so scripts and CI pipelines can branch on the result:

| Code | Meaning |
|---|---|
| `0` | All scenarios passed |
| `1` | One or more scenarios failed (the cert run completed; some checks did not pass) |
| `2` | Runtime error (the cert run could not complete; the network failed, the server was unreachable, the metadata could not be parsed), or RESO's service refused a cloud run |

With a config file, one entry whose run could not complete makes the command exit `2`, whatever the other entries did. The CLI lists those entries, with the reason, after the run.

Use code `1` to gate a release, code `2` to alert someone that the test infrastructure itself is broken. They mean different things and the response should be different.

---

## Where to Next

* **A target server to run cert against** – the **[RESO Reference Server](../reso-reference-server/)** is the most useful target during development. Spin it up locally, seed it, point cert at it, get a clean baseline. Every example in this guide runs against it cleanly.
* **Generating test data first** – the reference server seeds itself with realistic records. Run `docker compose --profile seed up seed` from `reso-reference-server/`. The standalone test-data generator is not part of this repository.
* **Calling a server from your own code** – the **[RESO Client SDK](../reso-client/)** is the OData client the cert runner uses internally. If you are integrating with a server outside the cert flow, that is the right entry point.
* **Validating individual records** – the **[reso-validation](../reso-validation/)** library is the field-level and resource-level validator the cert runner uses for record checks. It is also a stand-alone library you can call directly from your own application.
* **Running cert through an AI agent** – the **[RESO MCP Server](../reso-mcp-server/)** exposes RESO tools to AI hosts and is the path toward agent-driven cert workflows. Issue **[reso-tools#104](https://github.com/RESOStandards/reso-tools/issues/104)** tracks the work to expose the cert flows themselves as first-class MCP tools.

## Reference

* **[Reading a Certification Run](RUN-REFERENCE.md)** – what every step does and what every report file contains
* **[Package README](../)** – full CLI flag reference, endorsement details and SDK exports
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/reso-certification)**
* **[RCP-010 Add/Edit](https://github.com/RESOStandards/transport/blob/main/proposals/web-api-add-edit.md)** – the spec the Add/Edit cert flow validates
* **[RCP-027 EntityEvent](https://github.com/RESOStandards/transport/blob/main/proposals/entity-event.md)** – the spec the EntityEvent cert flow validates
* **[RESO Web API Core](https://github.com/RESOStandards/web-api-commander)** – the canonical reference for what Web API Core compliance covers
* **[RESO Data Dictionary](https://dd.reso.org/)** – the published Data Dictionary the DD cert flow validates against
* **[DD reference metadata](https://github.com/RESOStandards/reso-tools/tree/main/reso-common/reference-metadata)** – the exact projection of that Dictionary a run compares to, one file per version
