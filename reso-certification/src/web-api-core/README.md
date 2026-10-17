# Web API Core Compliance Testing

Validates OData query capabilities against the [RESO Web API Core specification](https://transport.reso.org/proposals/web-api-core). Supports both v2.0.0 and v2.1.0. Replaces the Java-based [web-api-commander](https://github.com/RESOStandards/web-api-commander).

## Usage

```bash
# Test all well-known resources
reso-cert core --url https://api.example.com --auth-token TOKEN

# Specific resources
reso-cert core --url https://api.example.com --auth-token TOKEN --resources Property,Member

# Version 2.1.0
reso-cert core --url https://api.example.com --auth-token TOKEN --spec-version 2.1.0

# Require full data type coverage
reso-cert core --url https://api.example.com --auth-token TOKEN --full-coverage
```

## How It Works

1. **Fetch metadata** from `/$metadata` and parse entity types
2. **Sample records** (up to 100 per resource) to find test values for each data type
3. **Auto-detect enum mode** from the metadata (or use `--enum-mode` to override)
4. **Run scenarios** – each one builds an OData query, makes the request, and validates the response
5. **Generate reports** with a coverage matrix showing what was tested

Test values are selected using median sampling so filter tests work bidirectionally (records exist both above and below the test value).

## Test Matrix

The actual number of scenarios executed depends on the server's enum mode, spec version, and data availability. Scenarios are skipped (not failed) when their required data type or test data is unavailable.

### Summary

| Category | Count | String | Collections | IsFlags | Version |
|----------|-------|--------|-------------|---------|---------|
| Structural | 7 | all | all | all | 2.0.0 |
| Integer filters | 9 | all | all | all | 2.0.0 |
| Decimal filters | 5 | all | all | all | 2.0.0 |
| Date filters | 6 | all | all | all | 2.0.0 |
| Timestamp filters | 5 | all | all | all | 2.0.0 |
| OrderBy | 4 | all | all | all | 2.0.0 |
| Enum single (eq, ne) | 2 | skip | run | run | 2.0.0 |
| Enum single (has) | 1 | skip | skip | run | 2.0.0 |
| Enum multi (has) | 2 | skip | skip | run | 2.0.0 |
| Collection (any, all) | 2 | skip | run | skip | 2.0.0 |
| Error codes | 2 | all | all | all | 2.0.0 |
| String enum (eq, ne) | 2 | run | skip | skip | 2.1.0 |
| String enum (any, all) | 2 | run | skip | skip | 2.1.0 |
| String functions | 3 | all | all | all | 2.1.0 |
| Server-driven paging | 1 | all | all | all | 2.1.0 |
| $expand | 1 | all | all | all | 2.1.0 |

**v2.0.0 totals**: 38-45 scenarios depending on enum mode
**v2.1.0 totals**: 44-54 scenarios depending on enum mode

### Structural Tests

| Scenario | What is Tested |
|----------|---------------|
| metadata-validation | Valid EDMX XML, OData-Version header, required resources |
| service-document | Service root returns 200, valid JSON |
| fetch-by-key | Single entity retrieval by key field |
| select | `$select` restricts returned fields |
| top | `$top` limits result count |
| skip | `$skip` returns different records than first page |
| count | `$count=true` returns `@odata.count` >= result count |

### Filter Tests

Require a field of the matching data type with sampled data. Test values use **median selection** so records exist both above and below the test value.

**Integer** (9) – Edm.Int16, Int32, Int64: `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not()`

**Decimal** (5) – Edm.Decimal, Double: `ne`, `gt`, `ge`, `lt`, `le`

**Date** (6) – Edm.Date (ISO 8601 `yyyy-mm-dd`): `eq`, `ne`, `gt`, `ge`, `lt`, `le`

**Timestamp** (5) – Edm.DateTimeOffset: `gt`, `ge`, plus `lt`/`le`/`ne` with `now()`

### OrderBy Tests

4 scenarios: ascending, descending, and combined with integer filter. Requires Edm.DateTimeOffset field (prefers a fully-populated field for stable sort results).

### Enumeration Tests

Three enum modes exist. The mode is **auto-detected from metadata** or set with `--enum-mode`:

| Mode | Single Lookups | Multi Lookups | Detection |
|------|---------------|--------------|-----------|
| **string** | `Edm.String` + LookupName | `Collection(Edm.String)` | LookupName annotations |
| **collections** | `Edm.EnumType` | `Collection(Edm.EnumType)` | Collection enum types |
| **isflags** | `Edm.EnumType` | `Edm.EnumType` + `IsFlags=true` | IsFlags attribute |

**IsFlags mode** (5 scenarios):

| Scenario | Filter |
|----------|--------|
| filter-enum-single-has | `Field has Namespace'Value'` |
| filter-enum-single-eq | `Field eq Namespace'Value'` |
| filter-enum-ne | `Field ne Namespace'Value'` |
| filter-enum-multi-has | `Field has Namespace'Value'` |
| filter-enum-multi-has-and | `Field has Value1 and Field has Value2` |

**Collections mode** (4 scenarios):

| Scenario | Filter |
|----------|--------|
| filter-enum-single-eq | `Field eq Namespace'Value'` |
| filter-enum-ne | `Field ne Namespace'Value'` |
| filter-coll-enum-any | `Field/any(x:x eq Value)` |
| filter-coll-enum-all | `Field/all(x:x eq Value)` |

**String mode** (v2.1.0, 4 scenarios):

| Scenario | Filter |
|----------|--------|
| filter-string-enum-single-eq | `StandardStatus eq 'Active'` |
| filter-string-enum-single-ne | `StandardStatus ne 'Active'` |
| filter-string-enum-multi-any | `Features/any(x:x eq 'Value1' or x eq 'Value2')` |
| filter-string-enum-multi-all | `Features/all(x:x eq 'Value1' or x eq 'Value2')` |

### Lookup Resource Validation (v2.1.0, per RCP-039)

| Scenario | Description |
|----------|-------------|
| lookup-resource-validation | `GET /Lookup?$filter=LookupName eq 'X'` then verify the provider-supplied LookupName and sample values are present. Runs first; dependent string-enum scenarios cascade-skip if this fails. |

### `in` Operator Tests (v2.1.0, OData 4.01 only)

| Scenario | Filter |
|----------|--------|
| filter-string-enum-single-in | `StandardStatus in ('Active','Pending','Sold')`. Gated on response advertising OData-Version 4.01; skipped for 4.0-only servers. |

### Error Code Tests

| Scenario | Expected |
|----------|----------|
| response-code-400 | HTTP 400 for invalid query syntax |
| response-code-404 | HTTP 404 for non-existent resource |

### Server-Driven Paging (v2.1.0)

Validates `@odata.nextLink` pagination: multiple pages fetched, each page returns new records, final page has no nextLink.

### $expand (v2.1.0)

Validates `$expand` on a navigation property. Expanded data must be present in the response.

## Coverage Matrix

After running, the report includes a coverage matrix showing which data types were tested for each resource:

```
Property:   integer ✓  decimal ✓  date ✓  timestamp ✓  singleLookup ✓  multiLookup ✓
Member:     integer ✓  decimal -  date -  timestamp ✓  singleLookup ✓  multiLookup -
Office:     integer ✓  decimal -  date -  timestamp ✓  singleLookup ✓  multiLookup -
```

- **Default mode**: Pass as long as no scenarios fail. Skipped scenarios due to missing types are noted in the report.
- **`--full-coverage`**: Fail if any data type category has zero coverage across all tested resources. Use this when full compliance verification is required.

## Report Format

Two reports are generated:

### Generic Report (Cert API compatible)

```json
{
  "description": "Web API Server Core",
  "version": "2.0.0",
  "generatedOn": "2026-04-06T00:00:00.000Z",
  "authentication": ["bearer token"],
  "odataVersion": "4.01",
  "parameters": [
    { "name": "Resource", "value": "Property" },
    { "name": "Key Field", "value": "ListingKey" },
    { "name": "Integer Field", "value": "BedroomsTotal" },
    { "name": "Decimal Field", "value": "ListPrice" },
    { "name": "Date Field", "value": "ListingContractDate" },
    { "name": "Timestamp Field", "value": "ModificationTimestamp" },
    { "name": "Single Lookup Field", "value": "StandardStatus" },
    { "name": "Single Lookup Value", "value": "Active" },
    { "name": "Multi Lookup Field", "value": "InteriorFeatures" },
    { "name": "Multi Lookup Value 1", "value": "Garden Bath" },
    { "name": "Multi Lookup Value 2", "value": "Outside Shower" }
  ]
}
```

### Detailed Report

Per-resource results with every scenario outcome, assertion details, and the coverage matrix.

## Files

```
src/web-api-core/
├── scenarios.ts     # All scenario definitions as typed data
├── assertions.ts    # 5 assertion primitives + comparators
├── sampling.ts      # Field type resolution + value sampling from live data
├── queries.ts       # OData URL builder for each scenario type
├── test-runner.ts   # Runs all scenarios for one resource
└── index.ts         # Exports
```

## Spec References

- [Web API Core specification](https://transport.reso.org/proposals/web-api-core)
- [Approved testing rules (v2.1.0)](https://github.com/RESOStandards/transport/blob/196f0453eb2661c78350b35ac7676287204bff6e/web-api-core.md#approved-testing-rules)

## Field Selection

Most scenarios need a concrete field to query, one per data type. Those are chosen automatically, so
a run needs no field configuration at all.

**How a field is chosen.** Up to 1,000 records are sampled per resource, paging until the sample is
full or the provider runs out of pages. Candidates are then ranked by how populated they are, most
to least, with standard fields ahead of local ones. A sparsely populated field makes for a weak test:
a filter that matches nothing proves nothing about the operator it was meant to exercise.

**When to override it.** Population is a proxy for suitability and sometimes the wrong one. A
provider may know that a field looks well populated in a sample while being unrepresentative, or
prefer a particular field be the one on record as exercising a type.

```bash
reso-cert core --url https://api.example.com --auth-token TOKEN \
  --field-overrides Property.ListPrice,Office.FeedTypes
```

Or in a config entry:

```json
{ "coreOptions": { "version": "2.1.0", "fieldOverrides": ["Property.ListPrice", "Office.FeedTypes"] } }
```

An override **replaces** automatic selection for its data-type slot rather than re-ordering it. The
named field is the one queried, there is no candidate ladder behind it, and a field the service will
not filter on fails its test instead of falling through to an automatic choice. The candidate ladder
exists because ranking is uncorrelated with filterability and the engine is otherwise *guessing*;
under an override it is not guessing, so the provider owns the outcome.

Three things an override cannot do. It cannot add a candidate — naming a field that is absent, of the
wrong type, or unable to discriminate leaves that slot automatic and is reported as unmatched. It
cannot use a bare field name, since a binding instruction needs an explicit resource. And it cannot
steer timestamp selection, which has its own ranker (`rankDatetimeFields`).

The flag **replaces** a config's list rather than merging, so what an operator typed is exactly what
runs, with no invisible union from the file. The desktop client exposes the same list under Web API
Core Options.

Every applied override travels into the compliance report as `fieldOverrides`, with `requested`,
`applied`, and — when they apply — `unmatched` and `malformed`. An overridden run must be visibly
overridden: which field was tested is part of the evidence for the verdict.

`applied` means the override **replaced that resource's candidates** for a slot. It is not a promise
that a scenario queried the field: scenarios are pinned to one representation each, so an override on
a `Collection(Edm.EnumType)` field cannot serve a `Collection(Edm.String)` scenario however highly it
ranks. The field a scenario actually queried is in its own `requestUrl`.

Three properties are worth being explicit about, because each is an easy wrong assumption:

- **It is sparse.** Naming a field does not turn auto-selection off. It replaces the candidates for
  that field's own data type, and for an enumeration its own **representation**; every other type,
  representation and resource is still chosen automatically. An override on a
  `Collection(Edm.String)` field leaves a `Collection(Edm.EnumType)` field on the same resource
  automatic, because the two are certified by different scenarios.
- **A named field owns its outcome.** This is the part that is not a preference: there is no
  candidate behind the field you named, so a field the service will not filter on fails its test.
- **But it cannot fail a run by not resolving.** An entry that does not resolve against the
  provider's metadata — absent, wrong type, or unable to discriminate — never became a candidate, so
  that slot stays automatic and the entry is reported as unmatched. A typo costs you that one
  override and nothing else.
- **The type is detected at runtime**, from the provider's metadata, rather than declared. You name
  the field; which data type and representation it covers follows from what it is.
