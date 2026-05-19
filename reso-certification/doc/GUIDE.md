# RESO Certification – User Guide

A task-oriented walkthrough of the RESO Certification toolkit. This is the package that runs the same compliance tests RESO uses for official certification, against any RESO-compliant OData server, from a command line, a CI pipeline, or a programmatic SDK.

If you have ever wondered whether your server actually passes RESO certification before you submit it for the official process, this is the package that answers that question on your laptop.

## Audience

Anyone who needs to know whether a RESO server passes the certification tests. Real examples:

* **MLS and vendor developers** preparing for official RESO certification who want to run the same tests locally before submitting
* **Technology providers** who need to verify their server still passes after every change to the schema, the data, or the platform
* **Integrators and consultants** who need to evaluate a third-party server's compliance before recommending or building against it
* **CI pipelines** that run the cert flows on every pull request so regressions are caught before they ship
* **Test engineers** who want a single source of truth for "is this thing actually conformant" that does not depend on running a Java toolchain
* **AI agents and automation tools** that need to verify a server's behavior end to end as part of a larger workflow

The package covers four endorsements: **Add/Edit (RCP-010)**, **EntityEvent (RCP-027)**, **Web API Core 2.0.0 / 2.1.0**, and **Data Dictionary 2.0**. The same tests RESO runs in the official certification process, available as a CLI, an SDK, and a Docker target.

## Install

This package isn't on npm yet. Install from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo on GitHub:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-certification
npm install
```

The `preinstall` hook automatically builds sibling packages this one depends on (`reso-client`, `reso-validation`). To bootstrap every package at once, run `npm run bootstrap` from the repo root instead. To consume the SDK from another project, link it locally with `npm link` or use a `file:` dependency.

The CLI is available as `reso-cert` after install. The SDK exports work in any Node.js 22+ environment. **No Java required** – the entire toolkit is pure TypeScript, built on the **[RESO Client SDK](../reso-client/)** for OData and the **[reso-validation](../reso-validation/)** library for field-level checks.

---

## Running Your First Cert Flow

The simplest possible run is one command and one URL:

```bash
reso-cert core --url https://api.example.com --auth-token YOUR_TOKEN
```

This runs the **Web API Core 2.0.0** compliance test suite against the server at `https://api.example.com`, authenticating with a bearer token. The CLI:

* Fetches the server's `$metadata` to learn the schema
* Samples live data from each resource to find appropriate field values for every test case
* Generates the test scenarios dynamically from the metadata and the sample data
* Runs every scenario in sequence, with a progress spinner so you can see what is happening
* Reports a per-scenario pass/fail summary at the end
* Exits with code 0 if everything passed, 1 if anything failed, 2 if there was a runtime error

You go from "I have a RESO server URL" to "I know exactly which scenarios pass and fail" in one command, with no Java toolchain, no XML config to edit, and no manual test parameter wiring.

---

## The Four Endorsements

The toolkit ships four cert flows, one per endorsement RESO certifies. They share the same CLI shape, the same auth resolution, and the same output formats – the only thing that changes is which subcommand you run and what it tests.

### Web API Core 2.0.0 / 2.1.0

The OData query surface. Validates `$filter` across every data type, `$select`, `$orderby`, `$top`, `$skip`, `$count`, enumerations, error code shapes, response metadata, and the service document. Version 2.1.0 adds `$expand`, server-driven paging, and string-based enum comparisons.

```bash
# Default version 2.0.0
reso-cert core --url https://api.example.com --auth-token TOKEN

# Version 2.1.0
reso-cert core --url https://api.example.com --auth-token TOKEN --core-version 2.1.0
```

The cert runner samples live records to find good test parameters automatically – it does not need a static config of "use ListPrice = 250000 for the integer test." It looks at what is actually in the server, picks values that exercise each operator and data type, and runs the scenarios against them.

### Data Dictionary 2.0

The metadata and data shape. Validates that the server's metadata document matches the RESO Data Dictionary 2.0 specification, that every declared field maps to a known DD field (or is documented as a local extension), and that the data in each resource is type-correct and lookup-valid.

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN

# Strict mode rejects any unrecognized fields and any data variations
reso-cert dd --url https://api.example.com --auth-token TOKEN --strict
```

The DD flow does several things in sequence:

1. **Fetches the metadata** and parses it into a structured report
2. **Merges the Lookup Resource data** so the metadata report knows what every enumerated field can hold
3. **Checks for variations** – fields, lookups, and enum values that look like local extensions of the standard DD
4. **Replicates a sample of data** using one of several strategies (full, top-of-file, modification timestamp window)
5. **Validates the replicated records** against the merged metadata

The output is a per-resource report showing what passed, what failed, and where the variations are. Strict mode treats variations as failures; the default treats them as warnings so you can see what is non-standard without immediately failing.

### Add/Edit (RCP-010)

Create, Update, and Delete operations with both `representation` and `minimal` response modes. Eight certification scenarios covering the full RCP-010 surface – successful creates, successful updates, successful deletes, validation failures, the right response headers (`Location`, `Preference-Applied`, `OData-EntityId`), the right annotations (`@odata.context`, `@odata.id`, `@odata.editLink`, `@odata.etag`), and the right error format (`error.code`, `error.message`, `error.details[].target`).

```bash
reso-cert add-edit --url https://api.example.com --auth-token TOKEN
```

The runner generates realistic test payloads automatically. It does not need a static fixture file. It samples your server's metadata, picks values that satisfy the type constraints, runs each scenario, and verifies the responses match the spec.

### EntityEvent (RCP-027)

Change tracking. Validates the `EntityEvent` resource shape, the sequence numbering, the polling-replication consumer pattern, and the way creates, updates, and deletes are surfaced in the feed. Two modes:

```bash
# Observe mode: read-only, validates the existing feed
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode observe

# Full mode: writes canary records to exercise the create/update/delete event paths
reso-cert entity-event --url https://api.example.com --auth-token TOKEN --mode full
```

**Observe mode** is the safe default for any server you do not own. It only reads the `EntityEvent` feed and validates that what is there conforms to the spec. Nine scenarios covering shape, sequencing, and the disambiguation logic.

**Full mode** writes a small number of canary records to exercise the full create → observe → update → observe → delete → observe loop. Twelve scenarios. Use it when you control the server and you want to verify that writes actually produce events with the right shape.

The full polling-replication consumer pattern – how to read the feed, how to disambiguate creates from updates from deletes, how to handle the empty-result-on-follow-up-fetch case – is walked through end to end in Section 4 of the **[RESO MCP Server guide](../reso-mcp-server/)** with verbatim tool calls and responses against the **[RESO Reference Server](../reso-reference-server/)**.

---

## Authentication

The cert runner supports every auth shape a real RESO server might use. Auth is resolved automatically from the first source that has credentials, in this order:

1. **CLI flags** – `--auth-token` for bearer, or `--client-id` plus `--client-secret` plus `--token-url` for OAuth2 client credentials
2. **Config file** – `--config path/to/config.json` lets each entry in the file specify its own auth
3. **`.env` file** in the current directory
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

# Same OAuth2, via .env file
node --env-file=.env $(which reso-cert) core --url https://api.example.com
```

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

**JSON mode** is the right choice when you are processing the cert results downstream – feeding them into a dashboard, archiving them in a results store, or comparing two runs to see what regressed. The JSON shape is stable and matches the SDK's `PipelineResult` type.

**`--output-dir`** writes a structured report tree to disk. Each cert run produces a per-scenario JSON file plus a top-level summary. This is the format the official certification submission expects, so a successful local run can be uploaded directly.

---

## Running Cert From Code

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
  console.log(`${result.failedCount} of ${result.totalCount} scenarios failed`);
}
```

The first argument is the test configuration. The second is an optional progress callback that fires on every step transition – use it to drive a progress bar in a UI, stream lines to a log, or post status updates to a chat channel.

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

This is exactly how the **[RESO Desktop Client](../reso-desktop-client/)**'s certification UI runs cert in the background while a user watches the progress in real time.

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

The cert flows are also wired up as Docker Compose profiles inside the **[RESO Reference Server](../reso-reference-server/)**, so you can run them against a freshly seeded reference server with one command:

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

Each profile spins up a clean server, seeds it with realistic data, runs the cert flow, and exits with the cert result code. This is the form most CI pipelines use because it produces a deterministic, reproducible cert result against a known dataset.

---

## Exit Codes

The CLI uses three exit codes so scripts and CI pipelines can branch on the result:

| Code | Meaning |
|---|---|
| `0` | All scenarios passed |
| `1` | One or more scenarios failed (the cert run completed; some checks did not pass) |
| `2` | Runtime error (the cert run could not complete; the network failed, the server was unreachable, the metadata could not be parsed) |

Use code `1` to gate a release, code `2` to alert someone that the test infrastructure itself is broken. They mean different things and the response should be different.

---

## Where to Next

* **A target server to run cert against** – the **[RESO Reference Server](../reso-reference-server/)** is the most useful target during development. Spin it up locally, seed it, point cert at it, get a clean baseline. Every example in this guide runs against it cleanly.
* **Generating test data first** – the **[RESO Data Generator](../reso-data-generator/)** is what produces the records cert runs against. If you want to seed a custom shape, start there.
* **Calling a server from your own code** – the **[RESO Client SDK](../reso-client/)** is the OData client the cert runner uses internally. If you are integrating with a server outside the cert flow, that is the right entry point.
* **Validating individual records** – the **[reso-validation](../reso-validation/)** library is the field-level and resource-level validator the cert runner uses for record checks. It is also a standalone library you can call directly from your own application.
* **Running cert through an AI agent** – the **[RESO MCP Server](../reso-mcp-server/)** exposes RESO tools to AI hosts and is the path toward agent-driven cert workflows. Issue **[reso-tools#104](https://github.com/RESOStandards/reso-tools/issues/104)** tracks the work to expose the cert flows themselves as first-class MCP tools, targeted for the webinar following the Spring RESO 2026 conference.

## Reference

* **[Package README](../)** – full CLI flag reference, endorsement details, and SDK exports
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/reso-certification)**
* **[GitHub source](https://github.com/RESOStandards/reso-tools/tree/main/reso-certification)**
* **[RCP-010 Add/Edit](https://github.com/RESOStandards/transport/blob/main/proposals/web-api-add-edit.md)** – the spec the Add/Edit cert flow validates
* **[RCP-027 EntityEvent](https://github.com/RESOStandards/transport/blob/main/proposals/entity-event.md)** – the spec the EntityEvent cert flow validates
* **[RESO Web API Core](https://github.com/RESOStandards/web-api-commander)** – the canonical reference for what Web API Core compliance covers
* **[RESO Data Dictionary](https://www.reso.org/data-dictionary/)** – the schema the DD cert flow validates against
