# Reading a Certification Run

What each part of a run does, and what every file it writes contains.

Every example below comes from a real run against the RESO reference server, which serves synthetic
seed data. No sample here contains provider data.

## What a Run Is

A run is an ordered list of named steps. Each step either passes, fails, or is skipped, and the run
stops at the first failure for the Data Dictionary endorsement. When it finishes, two separate
questions are answered, and keeping them apart is the single most useful thing to understand about a
report:

| Field | Question it answers |
|---|---|
| `outcome` | What happened while the run executed |
| `certification` | Whether what happened is enough to certify |

A run can pass everything it attempted and still not be eligible, because something required never
ran at all. The reverse is not possible: a failed run is never eligible.

`certification` is new in this release. A report produced by an earlier version does not carry it.

## The Steps

The step list differs per endorsement. These are the real names, as they appear in
`report-detailed.json`.

### Data Dictionary

1. **Resolve authentication** – establishes the bearer token for the server under test. It does not
   contact the server. A failure here means the credentials could not be assembled at all, which is
   a configuration problem rather than a conformance one.
2. **Service check** – one request, to confirm the OData service answers before anything expensive
   begins. Skipped only by an SDK caller that sets `skipHealthCheck`.
3. **Generate metadata report** – fetches `$metadata`, validates the CSDL against the XSD and the
   semantic rules, then converts it into a RESO metadata report. If the server serves a Lookup
   Resource, its records are merged in here. This is the step everything downstream depends on, so a
   failure stops the run.
4. **Validate DD metadata** – compares the metadata report against the Data Dictionary reference for
   the version under test. This is where a non-standard resource, field, or type surfaces as a
   conformance error.
5. **Check variations** – asks the Variations Service which local elements look like near-misses
   against the standard. Any variation found fails the step. Requires `RESO_SERVICES_URL` and
   credentials; `--skip-variations` reports it as skipped instead, which makes the run ineligible for
   certification. An absent `RESO_SERVICES_URL` is never treated as a skip, so a misconfigured
   machine cannot quietly stop checking.
6. **Replicate and validate** – pulls a sample of records using each replication strategy
   (timestamp-descending with `$top`, `@odata.nextLink` paging, and a modified-since window), then
   validates every record against the merged metadata. This is the longest step by a wide margin.
7. **Write reports** – emits the report files.

`Write reports` does not appear in its own `steps` array. It is the step writing the report, so the
step list it records is the list as it stood when it began. A report that listed itself would be a
report written mid-flight.

### Web API Core

1. **Resolve authentication**
2. **Service check**
3. **Fetch metadata** – fetches and parses `$metadata`, without the Data Dictionary comparison.
4. **Run Core scenarios** – the endorsement proper. Each resource is sampled, then every applicable
   scenario runs against it: filters, ordering, paging, `$select`, `$expand`, key lookups, and the
   error cases. Scenario-level skips are normal and expected here; see below.
5. **Write reports**

### Add/Edit

Same first three steps, then:

4. **Sample records** – reads existing records to build realistic payloads. Omitted when payloads
   were supplied.
5. **Generate payloads** – writes the six payload files it is about to use.
6. **Run Add/Edit scenarios** – exercises create, update, and delete, in both the succeeding and the
   correctly-rejected direction.
7. **Write reports**

### EntityEvent

Same first three steps, then:

4. **Generate payloads** – only in `full` mode. In `observe` mode this step is absent, because an
   observe run writes nothing.
5. **Run EntityEvent scenarios** – validates the event stream and, in full mode, writes a canary
   record and confirms the event appears.
6. **Write reports**

An observe-mode run is never eligible for certification. It exercises no writes, so there is nothing
to certify.

## Scenario Skips Are Not Step Skips

Web API Core routinely reports something like `219 passed, 0 failed, 112 skipped`. Those 112 are
**scenarios**, not steps. A scenario is skipped when it does not apply to the resource under test,
for example a numeric-range filter on a resource with no numeric field, and the step itself passes.
Such a run is fully certifiable.

A **step** skip is different, and it is what makes a run ineligible. The two live in different places
in the report: scenario tallies sit in a step's `counts`, while a step skip is the step's own
`status`.

## The Files

Every endorsement writes into:

```
<output-dir>/<endorsement>-<version>/<providerUoi>-<providerUsi>/<recipientUoi>/current/
```

In the examples below those path segments are the literal placeholders a reference-server run
produces. A real run carries the organization's own identifiers there.

### `report.json`

The headline, and the file the certification pipeline ingests. Six keys, nothing nested:

```json
{
  "description": "Data Dictionary",
  "version": "2.0",
  "softwareVersion": "0.10.8",
  "generatedOn": "2026-10-06T18:25:48.553Z",
  "remarks": "14 resources, 1,090 fields, 3,788 lookups. Data Dictionary compliance test passed.",
  "outcome": "passed"
}
```

`outcome` is one of `passed`, `failed`, or `incomplete`. `incomplete` means the run ran out of its
time budget: what it gathered is valid, and the rest was not tested.

Read `outcome`, not `remarks`. The remarks sentence is for humans and has in the past said "passed"
on a run that failed.

### `report-detailed.json`

Everything in `report.json`, plus the step list, the timings, and the certification verdict. For the
endorsements that test per resource (Core, Add/Edit, EntityEvent) it also carries `resourceReports`,
with every scenario and its assertions.

The certification verdict, from a run with `--skip-variations`:

```json
"certification": {
  "valid": false,
  "reasons": [
    "Check variations: skipped — Variations not checked, requested with --skip-variations. A run that did not check variations is not eligible for certification."
  ]
}
```

On an eligible run it is simply `{ "valid": true }`. Note that this report carried
`"outcome": "passed"` at the same time. Both are true: the run passed what it ran, and it is not
certifiable.

### `metadata.xml`

The CSDL document exactly as the server served it, saved before any parsing. This is the evidence
behind every metadata finding, so a disagreement about what was served can be settled from the file
rather than from the report.

### `metadata-report.json`

**The canonical metadata report.** Always the final one: merged with the Lookup Resource when the
server serves one, and the base report unchanged when it does not. Downstream consumers can always
read this file without choosing between variants.

From the reference server: 14 resources, 1,090 fields, 3,788 lookups. A field and a lookup entry,
verbatim:

```json
{ "resourceName": "Property", "fieldName": "AboveGradeFinishedArea",
  "type": "Edm.Decimal", "scale": 2, "precision": 14, "annotations": [] }
```

```json
{ "lookupName": "AccessibilityFeatures", "lookupValue": "Accessible Approach with Ramp",
  "type": "Edm.String",
  "annotations": [
    { "term": "RESO.OData.Metadata.LegacyODataValue", "value": "AccessibleApproachWithRamp" },
    { "term": "RESO.OData.Metadata.StandardName", "value": "Accessible Approach with Ramp" }
  ] }
```

Older bundles used the opposite convention, where `metadata-report.json` was the base and
`metadata-report.processed.json` the merged result. When reading a bundle produced before that was
inverted, prefer `metadata-report.processed.json` if it is present.

### `metadata-report.raw.json`

The metadata report as it stood **before** the Lookup Resource merge. Written only when a merge
actually happened, because otherwise it would be byte-identical to the canonical file. Its purpose is
provenance: it answers which lookups came from the metadata document and which came from the Lookup
Resource.

### `lookup-resource-lookup-metadata.json`

The Lookup Resource as served, one record per lookup value, before any merging. 3,788 records from the
reference server, each carrying `LookupKey`, `LookupName`, `LookupValue`, `StandardLookupValue`,
`LegacyODataValue`, and `ModificationTimestamp`. Written only when the server serves a Lookup
Resource.

### `data-availability-report.json`

What the replicated sample actually contained, which is a different question from what the metadata
advertised. Three sections:

- `resources` – per resource: the record count, the unique records fetched, and the date range
  covered by the timestamp field used.
- `fields` – a frequency per field: how many sampled records had a value.
- `lookupValues` – a frequency per lookup value.

From the reference server: 13 resources, 5,572 field entries, 15,669 lookup-value entries. A field
advertised in metadata but never populated appears here with a frequency of zero, which is the signal
that a field is declared but unused.

### `data-availability-responses.json`

The raw responses behind the availability report. Large, and the evidence trail for any availability
number that is questioned.

### `payloads/` and `entity-event-payloads/`

The request bodies Add/Edit and EntityEvent used, written before they were sent so a result can be
reproduced exactly. Add/Edit writes six: `create-succeeds`, `create-fails`, `update-succeeds`,
`update-fails`, `delete-succeeds`, and `delete-fails`. The "fails" payloads are deliberately invalid:
the scenario passes when the server correctly rejects them.

A generated create payload against the reference server carries `ListPrice`, `BedroomsTotal`,
`BathroomsTotalInteger`, `City`, `StateOrProvince`, `PostalCode`, and `Country`.

## How a Run Fails, and What You Still Get

The Data Dictionary run stops at the first failing step. Everything after it is recorded as `skipped`,
which is honest: those steps did not run. The report files are still written, because the step that
writes them always runs, so a failed run leaves the same evidence on disk as a passing one.

That is worth knowing when a run fails early. A failure in `Generate metadata report` means there is
no metadata report to inspect, but `metadata.xml` is already on disk and is usually enough to see why.

## Quick Reference

| File | Written by | Always present |
|---|---|---|
| `report.json` | Write reports | yes |
| `report-detailed.json` | Write reports | yes |
| `metadata.xml` | Generate metadata report / Fetch metadata | once metadata was fetched |
| `metadata-report.json` | Generate metadata report | Data Dictionary runs |
| `metadata-report.raw.json` | Generate metadata report | only when a Lookup Resource merge happened |
| `lookup-resource-lookup-metadata.json` | Generate metadata report | only when a Lookup Resource was served |
| `data-availability-report.json` | Replicate and validate | Data Dictionary runs that reached replication |
| `data-availability-responses.json` | Replicate and validate | Data Dictionary runs that reached replication |
| `payloads/*.json` | Generate payloads | Add/Edit runs |
| `entity-event-payloads/*.json` | Generate payloads | EntityEvent runs in full mode |
