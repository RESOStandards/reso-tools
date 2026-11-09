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

Integer, decimal, date, timestamp and lookup fields can be named. The timestamp field defaults to
`ModificationTimestamp`, and a named one serves every timestamp test, the `lt now()` and `le now()`
ones included. So it must hold a value in the past, or those two would compare nothing, and a named
field without one is reported as unmatched.

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

See [Field Selection](https://tools.reso.org/packages/reso-certification/web-api-core/#field-selection) for how the ranking works and
when overriding it is worth doing.

**Full type coverage.** The Core tests exercise six data types: integer, decimal, date, timestamp,
single-valued lookup and multi-valued lookup. A run achieves full type coverage when each type is met
on some field of some resource it tested. A single-valued lookup is met with one sampled value and a
multi-valued lookup with two, as the specification gives them. Every run records whether it achieved
full type coverage, in `report-detailed.json` as `typeCoverage`.

Core 2.0.0 testing worked differently: the provider had to have every type on the same resource. Now
the run looks across all the resources it tested. A server that cannot meet every type in its standard
or local fields is recorded as not having achieved full type coverage, and can still be certified.

To test as Core 2.0.0 did, name the resource and require full type coverage. With `--full-coverage`, a
type that is not met fails the run. Add `--spec-version 2.0.0` to run the 2.0.0 tests themselves rather
than 2.1.0's:

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN \
  --resources Property --full-coverage
```

For full equivalence, also name the fields your Core 2.0.0 report used, as field overrides:

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN \
  --resources Property --full-coverage \
  --field-overrides Property.BedroomsTotal,Property.ListPrice,Property.ListingContractDate,Property.ModificationTimestamp,Property.StandardStatus,Property.InteriorFeatures
```

The timestamp field is `ModificationTimestamp` unless you name another. Two things stay the run's own.
The key field comes from your metadata. And the run samples the values it tests from your data, so
they can differ from the values in your 2.0.0 report, and a field you name is used only when the
sample holds at least two of its values, one of them in the past for a timestamp field. In a config file,
the settings are `coreOptions.resources`, `coreOptions.fullCoverage` and `coreOptions.fieldOverrides`.

### Data Dictionary 2.1

The metadata and data shape. Validates that the server's metadata document matches the RESO Data Dictionary 2.1 specification, that no local name is a near-miss of a standard one, and that the data in each resource is type-correct and lookup-valid.

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN

# Relaxed: record schema validation errors without failing on them, so one pass
# collects everything a feed needs fixed. The run is NOT eligible for certification.
reso-cert dd --url https://api.example.com --auth-token TOKEN --no-strict
```

The DD flow does several things in sequence:

1. **Fetches the metadata** and parses it into a structured report
2. **Merges the Lookup Resource data** so the metadata report knows what every enumerated field can hold
3. **Checks for variations** – local resources, fields, lookup values and expansions whose names look like near-misses of a standard one (see [Reading a Variations Report](#reading-a-variations-report))
4. **Replicates a sample of data** using one of several strategies (full, top-of-file, modification timestamp window)
5. **Validates the replicated records** against the merged metadata

The output is a per-resource report showing what passed, what failed and where the variations are. Strict mode governs schema validation and nothing else: it is on by default, and it fails the run when a replicated record does not validate against the merged metadata. `--no-strict` keeps the run going and records every error instead of stopping at the first, which is how you survey a feed in one pass – at the cost of the run's eligibility, since nothing enforced what it validated. Variations are separate and fail a run whether or not strict is on.

### Add/Edit (RCP-010)

Create, update and delete. Each action is a test that should succeed and one that should fail, and create and update each answer in two formats, `representation` (the record comes back) and `minimal` (headers only). Up to eight scenarios cover the RCP-010 surface: the successes, the validation failures, the right response headers (`Location`, `Preference-Applied`, `EntityId`), the right annotations (`@odata.context`, `@odata.id`, `@odata.editLink`, `@odata.etag`) and the right error format (`error.code`, `error.message`, `error.details[].target`).

RCP-010 lets a provider implement as many or as few actions as its business needs, so a run tests the ones you choose, and passing those is a pass. The report says what was tested.

```bash
# Every action, both formats
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./payloads \
  --actions create,update,delete --create-formats representation,minimal --update-formats representation,minimal

# Creates only, headers-only responses
reso-cert add-edit --url https://api.example.com --auth-token TOKEN --payloads ./payloads \
  --actions create --create-formats minimal
```

The payloads are yours, as RCP-010 asks: for each action tested, a record that should succeed and one that should fail, in a folder (`create-succeeds.json`, `create-fails.json`, `update-…`, `delete-…`) or inline in a config file. A folder needs only the files of the actions tested. An update or a delete that names no record uses one the run created, so a run that tests every action leaves your own records alone. A run with no payloads is refused before it writes anything.

On the reference server, `--auto-payloads` has the tool write the payloads instead, for Property.

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

* **One variation.** `BedroomTotal` is one letter away from the standard field `BedroomsTotal`, so it is reported as a near-miss with `BedroomsTotal` as the suggestion. A variation is something to change, or to explain in a review (see [Reading a Variations Report](#reading-a-variations-report)).
* **Two values in their machine-friendly form.** RCF accepts a lookup value written either way: `Coming Soon` or `ComingSoon`. The machine-friendly form is accepted until Data Dictionary 3.0, so `ComingSoon` and `ResidentialLease` are not variations. They are listed as deprecations, each with the standard value it stands for, so they can be changed before 3.0 arrives.
* `Coming Soon` on the second record is already the standard value and raises nothing.

The variations check uses your RESO services credentials, the `credentials.env` the certification site gives you (see [Authentication](#authentication)). `--skip-variations` runs without them and leaves the check out.

#### What the Run Writes

`rcf` writes straight into `--output-dir`:

* `metadata-report.json` – every field and lookup value the records carry, with Data Dictionary fields linked to their Data Dictionary pages
* `data-availability-report.json` – for each field, how many records carry it and what share of all the records that is
* `data-dictionary-variations.json` – the variations, with the deprecations under `deprecations`
* `report.json` and `report-detailed.json` – the summary and the full record of the run, as every run writes them, even when it fails. The detailed report holds a fingerprint of the files read, so a later run can confirm it scored the same data.

A run is eligible for certification only when it checked every record against the Data Dictionary and checked variations. It does both by default. What each file contains is in [Reading a Certification Run](RUN-REFERENCE.md#reso-common-format-rcf).

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

Every run checks each record against the Data Dictionary. RCF is extensible, so local fields and local values are accepted. A field the Data Dictionary defines has to have the right type, though: a `ListPrice` of `"three eighty-nine"` is an error. The run prints how many errors it found and exits with `1`. `--strict` stops at the first one.

`--skip-schema-validation` turns the check off, for a quick look at what the files contain. A run made with it is not eligible for certification, and neither is one made with `--skip-variations`. `--schema-validate` is still accepted and changes nothing.

#### Which Data Dictionary Version

`--dd-version` when you give it. Otherwise the version in the files' `@reso.context`, which is 2.1 in the sample, and 2.1 when neither says. Certification is on 2.1, the latest minor, so files that declare 2.0 run as a retest and are not eligible. To certify, update the version in each file's `@reso.context`, for example to `urn:reso:metadata:2.1:resource:property`.

#### Exit Codes for `rcf`

| Code | Meaning |
|---|---|
| `0` | The files were read and checked. Variations and deprecations do not change the code, so read them in the report. |
| `1` | Schema errors |
| `2` | The run could not do what was asked: nothing certifiable was read, a file's `@reso.context` could not be read under `--skip-schema-validation` (otherwise it is a schema error, so `1`), the three identity options were incomplete or the variations check could not run |

## Reading a Variations Report

A variation is a name in your data that has no exact match in the Data Dictionary but looks like it was meant to be one. A field called `BedroomTotal` when the standard field is `BedroomsTotal` is one. So is the value `Built In Gas Oven` when the standard value is `Built-In Gas Oven`. The variations report lists each one with the standard element RESO suggests it is, and each one needs a decision. Either change your data to use the standard element, or ask RESO to review the suggestion.

In a Data Dictionary run, any variation fails the **Check variations** step, so the run cannot be certified until every one is resolved. An RCF run lists its variations without failing on them.

### Where to Find It

* A Data Dictionary run writes `variations-report.json` beside its other reports, and only when it found variations.
* `find-variations` and `rcf` write `data-dictionary-variations.json`. It holds the same kind of entries, and `rcf` adds the values it found in their machine-friendly form under `deprecations` (see [RESO Common Format](#reso-common-format-rcf)).
* The RESO desktop app shows the same report on its Variations Review screen, which is also where you ask for a review.

### What an Entry Says

The report opens with what produced it: `version`, `providerUoi`, `providerUsi`, `recipientUoi`, `generatedOn` and `fuzziness`. Then come the entries, grouped by kind. Each entry names your element, lists what RESO suggests it is and carries an `enforcement` tag:

```json
{
  "level": "field",
  "resourceName": "Property",
  "fieldName": "BedroomTotal",
  "suggestions": [
    {
      "suggestedResourceName": "Property",
      "suggestedFieldName": "BedroomsTotal",
      "ddWikiUrl": "https://dd.reso.org/DD2.1/Property/BedroomsTotal/",
      "distance": 1,
      "maxDistance": 3,
      "strategy": "Edit Distance",
      "closeMatch": true
    }
  ],
  "enforcement": "must-fix"
}
```

* **`ddWikiUrl`** opens the suggested element's definition. Read it before deciding. The question is whether your element holds what the definition describes.
* **`strategy`** says where the suggestion came from (see [Where a Suggestion Comes From](#where-a-suggestion-comes-from)).
* **`distance` and `maxDistance`** appear on an Edit Distance suggestion: how many characters differ, and how many the match allows.
* **`closeMatch` and `exactMatch`** mark the near-certain cases, below.
* **`enforcement`** is `must-fix` or `warning` (see [Must-Fix and Warning](#must-fix-and-warning)).

### The Kinds of Variation

| Kind | What it is | Example | Suggestion |
|---|---|---|---|
| `resources` | A resource whose name is close to a standard resource | `OpenHouses` | `OpenHouse` |
| `fields` | A field whose name is close to a standard field of the same resource | `BedroomTotal` on `Property` | `BedroomsTotal` |
| `lookups` | A value of an enumerated field that is close to a standard value | `Built In Gas Oven` in `Appliances` | `Built-In Gas Oven` |
| `expansions` | An expansion, the kind of property read with `$expand`, whose name is close to a standard expansion | `ListAgents` on `Property` | `ListAgent` |
| `complexTypes` | Part of the report's shape. Nothing is reported here today | – | – |

A field is compared only with standard fields and an expansion only with standard expansions, so a plain field is never suggested as an expansion or the other way around. A lookup entry carries `lookupValue` beside its `fieldName`. Its suggestion is usually a standard value of the same field. A Fast Track suggestion can name a value of a different field, or more than one element.

### Where a Suggestion Comes From

| `strategy` | Source |
|---|---|
| `Substring` | One name contains the other, ignoring case and special characters. `XYZ_ListPrice` contains `ListPrice`. |
| `Edit Distance` | The names differ by a few characters, up to the match sensitivity in `fuzziness`. At `0.25` that is a quarter of the name's length. |
| `Fast Track` | The RESO Fast Track Subgroup, which decides how nonstandard elements map to the Data Dictionary |
| `Admin Review` | RESO staff |

Names of three characters or fewer are not matched by machine. Machine matching works like a spelling checker. It finds near-misses, and some of them are false positives, which is what a review is for.

**Close and exact matches must be resolved.** A suggestion marked `exactMatch` differs from the standard name only by case, spaces or special characters, like `Built In Gas Oven` and `Built-In Gas Oven`. One marked `closeMatch` is within one character, like `BedroomTotal` and `BedroomsTotal`. Disagreeing with one of these usually means something in the Data Dictionary needs a workgroup's attention, so say so when you ask for a review.

### Must-Fix and Warning

* **`must-fix`** – a suggested element is part of the Data Dictionary version you are certifying on. Nearly every entry is this.
* **`warning`** – every suggestion on the entry points at an element that becomes standard only in a later major version.

A Data Dictionary run fails on every entry in the report, whichever tag it carries.

### What to Do About Each Entry

Open the suggested element's definition from `ddWikiUrl`, then decide which of these it is:

1. **Your element is the standard one.** Change your data to use the standard name or value, and run the test again. Serve `BedroomsTotal` rather than `BedroomTotal`, and send `Built-In Gas Oven` rather than `Built In Gas Oven`.
2. **Your value is a more specific kind of the standard one.** The Data Dictionary defines a fireplace `Insert` as "a device inserted into an existing masonry or prefabricated fireplace", so a `Catalytic Insert` is an `Insert`. Map it to `Insert` until the Data Dictionary adds the more specific value. On a field served as a string through the Lookup Resource, nothing is lost: keep `Catalytic Insert` as the `LookupValue` and give `Insert` as its `StandardLookupValue`. Check the definition rather than the name. A value the definition does not describe is not that value, which is the next case.
3. **The suggestion is wrong.** A price per acre is not a list price, so `XYZ_ListPricePerAcre` suggested as `ListPrice` is a false positive. Ask RESO to review it, and say what your element holds. Once RESO staff ignore a suggestion, it is not raised again, and your element is treated as local.
4. **It belongs in the standard, but not as suggested.** Send it to Fast Track. The subgroup can confirm the suggestion, offer a different or an additional one, or ignore the element. A Fast Track suggestion can be disputed too, and the dispute goes back to the subgroup.

### Asking for a Review

In the desktop app, open the run's Variations Review. For each entry you are not changing, choose **Ignore** for a false positive or **Fast Track** for the subgroup, and add a comment saying what your element holds. Then choose **Submit Review**. RESO staff make the decision, and the app lets you know when they do.

From the command line, the report a run wrote starts a review, and `variations-review-status` shows where each of your submissions stands:

```bash
reso-cert submit-variations-report --report out/.../variations-report.json
reso-cert variations-review-status
```

To give a choice and a comment for each entry without the desktop app, `submit-variation-decisions` takes them from a sheet. The [CLI reference](https://tools.reso.org/packages/reso-certification/cli/#submit-variation-decisions) has the details.

For a question about a suggestion, write to RESO at certification@reso.org with the entry exactly as the report shows it.

---

## Authentication

The cert runner supports every auth shape a real RESO server might use. Auth is resolved automatically from the first source that has credentials, in this order:

1. **CLI flags** – `--auth-token` for bearer, or `--client-id` plus `--client-secret` plus `--token-url` for OAuth2 client credentials
2. **Config file** – `--config path/to/config.json` lets each entry in the file specify its own auth
3. **A credentials file** – `credentials.env`, as the certification site hands it out, or a `.env`. The CLI reads the first one it finds at startup, from the places the [CLI reference](https://tools.reso.org/packages/reso-certification/cli/#environment-env) lists
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

**Add/Edit is the exception.** It creates, updates and deletes records, so it is told what to test and what to send: the actions in `addEditOptions.actions`, the formats of each create or update among them in `addEditOptions.formats`, and your payloads, inline in `payloads` or in a folder named by `payloadsDir`. A run missing any of them is refused before it writes anything. `"autoPayloads": true` has the tool write the payloads instead, for the reference server and the mock.

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

A downloadable sample for each endorsement, with the full field reference, is in [`sample-configs/`](https://github.com/RESOStandards/reso-tools/tree/main/reso-certification/sample-configs).

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

Cloud runs cover every endorsement: Data Dictionary, Web API Core, Add/Edit, EntityEvent and RESO Common Format. They sign in with the `TOKEN_URI`, `CLIENT_ID` and `CLIENT_SECRET` from your credentials file, the same as the variations commands. If RESO's service refuses a request, the CLI prints its reason and exits `2`.

### Following Many Runs

With many runs going, watch them instead of asking again and again. `reso-cert cloud watch` takes the updates RESO's service pushes as each run changes:

```bash
reso-cert cloud watch
```

```
Watching your cloud runs in qa. Ctrl-C to stop.
2026-11-04T18:05:00  running    qa-T00000000-1700000000001  M00000123, system 50000  data-dictionary 2.1
2026-11-04T18:09:12  passed     qa-T00000000-1700000000001  M00000123, system 50000  data-dictionary 2.1  report 0000report01
0 scheduled · 3 running · 12 passed · 1 failed · 0 error
```

Each update is one line. The last line is a running tally of the runs watched, rewritten in place on a terminal. When the output goes to a file or a pipe, the tally is printed at the start and at the end instead, so a log stays clean.

To wait on particular runs, name their requests and add `--until-done`. The watch exits once every one has finished, with `0` when all passed and `1` when any failed or errored, so a script can start many runs and then wait on all of them:

```bash
reso-cert cloud watch --request qa-T00000000-1700000000001 --request qa-T00000000-1700000000002 --until-done
```

Without `--request`, `--until-done` waits on the runs in progress when the watch started. `--endorsement data-dictionary` narrows the watch to one endorsement, and `--json` prints each update as the service sent it, one JSON object per line.

The watch reads where your runs stand once when it starts, so a run that finished before then is counted. If the connection drops, it reconnects and reads once more for what changed meanwhile. If it cannot reconnect, it says so and exits `2`, and `reso-cert cloud status` still shows where everything stands.

It needs one more line in your credentials file or environment, `RESO_CLOUD_UPDATES_URL`, the address of RESO's live updates. The [CLI reference](https://tools.reso.org/packages/reso-certification/cli/#cloud-watch) has every option.

---

## Archiving a Certification Report

A report you no longer want in the RESO Certification System can be archived from the command line, the same way the
certification site archives one from a report's page. Sign in to the site, download `credentials.env`, and run from the
directory that holds it:

```bash
reso-cert archive-report <reportId>
```

Without `--confirm` the CLI reads the report and prints the warning the site shows, then stops:

```text
Archive Endorsement?

By proceeding, the Data Dictionary 2.0 Endorsement for Example MLS will no longer be available in the RESO Certification System.
You will receive a notification it's been archived.

Nothing was archived. Rerun with --confirm to proceed.
```

With `--confirm` it prints the same warning and then archives. Only the provider the report belongs to, or an
administrator, can archive it. `--json` prints what was read and what happened as one object, for scripts. The
[CLI reference](https://tools.reso.org/packages/reso-certification/cli/#archive-report) has the rest.

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

Two different things run in Docker, and they are worth telling apart. To run the certification CLI against a real provider from an image built out of this repository rather than from npm, see [the certification image](https://tools.reso.org/packages/reso-certification/#the-certification-image) – that section also covers the `--user` and output-directory handling a bind mount needs.

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
* **[RCP-027 EntityEvent](https://github.com/RESOStandards/transport/blob/main/proposals/entity-events.md)** – the spec the EntityEvent cert flow validates
* **[RESO Web API Core](https://github.com/RESOStandards/web-api-commander)** – the canonical reference for what Web API Core compliance covers
* **[RESO Data Dictionary](https://dd.reso.org/)** – the published Data Dictionary the DD cert flow validates against
* **[DD reference metadata](https://github.com/RESOStandards/reso-tools/tree/main/reso-common/reference-metadata)** – the exact projection of that Dictionary a run compares to, one file per version
