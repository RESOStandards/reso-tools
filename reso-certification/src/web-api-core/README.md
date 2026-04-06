# Web API Core Compliance Testing

Validates OData query capabilities against the [RESO Web API Core specification](https://transport.reso.org/proposals/web-api-core). Supports both v2.0.0 and v2.1.0. Replaces the Java-based [web-api-commander](https://github.com/RESOStandards/web-api-commander).

## Usage

```bash
# Test all well-known resources
reso-cert core --url https://api.example.com --auth-token TOKEN

# Specific resources
reso-cert core --url https://api.example.com --auth-token TOKEN --resources Property,Member

# Version 2.1.0
reso-cert core --url https://api.example.com --auth-token TOKEN --version 2.1.0

# Require full data type coverage
reso-cert core --url https://api.example.com --auth-token TOKEN --full-coverage
```

## How It Works

1. **Fetch metadata** from `/$metadata` and parse entity types
2. **Sample records** (up to 100 per resource) to find test values for each data type
3. **Auto-detect enum mode** from the metadata (or use `--enum-mode` to override)
4. **Run scenarios** — each one builds an OData query, makes the request, and validates the response
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

| Scenario | What's Tested |
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

**Integer** (9) — Edm.Int16, Int32, Int64: `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not()`

**Decimal** (5) — Edm.Decimal, Double: `ne`, `gt`, `ge`, `lt`, `le`

**Date** (6) — Edm.Date (ISO 8601 `yyyy-mm-dd`): `eq`, `ne`, `gt`, `ge`, `lt`, `le`

**Timestamp** (5) — Edm.DateTimeOffset: `gt`, `ge`, plus `lt`/`le`/`ne` with `now()`

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

### String Function Tests (v2.1.0)

| Scenario | Filter |
|----------|--------|
| filter-string-contains | `contains(Field,'value')` |
| filter-string-startswith | `startswith(Field,'value')` |
| filter-string-endswith | `endswith(Field,'value')` |

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
