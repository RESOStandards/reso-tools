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

The following scenarios are defined. The actual number executed depends on the server's enum mode and data availability — scenarios are skipped (not failed) when their required data type or test data is unavailable.

### Structural Tests (always run)

| Scenario | What's Tested |
|----------|---------------|
| metadata-validation | Valid EDMX XML, OData-Version header, required resources present |
| service-document | Service root returns 200, valid JSON, OData-Version header |
| fetch-by-key | Single entity retrieval by key field |
| select | `$select` restricts returned fields |
| top | `$top` limits result count |
| skip | `$skip` returns different records than first page |
| count | `$count=true` returns `@odata.count` >= result count |

### Filter Tests (require matching data type in resource)

**Integer** (9 scenarios) — requires at least one Edm.Int16/Int32/Int64 field with data:

| Scenario | Filter |
|----------|--------|
| filter-int-eq | `IntegerField eq value` |
| filter-int-ne | `IntegerField ne value` |
| filter-int-gt | `IntegerField gt value` |
| filter-int-ge | `IntegerField ge value` |
| filter-int-lt | `IntegerField lt value` |
| filter-int-le | `IntegerField le value` |
| filter-int-and | `IntegerField gt low and IntegerField lt high` |
| filter-int-or | `IntegerField gt low or IntegerField lt high` |
| filter-int-not | `not(IntegerField eq value)` |

**Decimal** (5 scenarios) — requires at least one Edm.Decimal/Double field:

| Scenario | Filter |
|----------|--------|
| filter-decimal-ne | `DecimalField ne value` |
| filter-decimal-gt | `DecimalField gt value` |
| filter-decimal-ge | `DecimalField ge value` |
| filter-decimal-lt | `DecimalField lt value` |
| filter-decimal-le | `DecimalField le value` |

**Date** (6 scenarios) — requires at least one Edm.Date field:

| Scenario | Filter |
|----------|--------|
| filter-date-eq | `DateField eq 'yyyy-mm-dd'` |
| filter-date-ne | `DateField ne 'yyyy-mm-dd'` |
| filter-date-gt | `DateField gt 'yyyy-mm-dd'` |
| filter-date-ge | `DateField ge 'yyyy-mm-dd'` |
| filter-date-lt | `DateField lt 'yyyy-mm-dd'` |
| filter-date-le | `DateField le 'yyyy-mm-dd'` |

**Timestamp** (5 scenarios) — requires at least one Edm.DateTimeOffset field:

| Scenario | Filter |
|----------|--------|
| filter-datetime-gt | `TimestampField gt DateTimeOffset` |
| filter-datetime-ge | `TimestampField ge DateTimeOffset` |
| filter-datetime-lt-now | `TimestampField lt now()` |
| filter-datetime-le-now | `TimestampField le now()` |
| filter-datetime-ne-now | `TimestampField ne now()` |

### OrderBy Tests (require Edm.DateTimeOffset field)

| Scenario | Query |
|----------|-------|
| orderby-timestamp-asc | `$orderby=TimestampField asc` |
| orderby-timestamp-desc | `$orderby=TimestampField desc` |
| orderby-timestamp-asc-filter-int-gt | `$orderby=TimestampField asc&$filter=IntegerField gt value` |
| orderby-timestamp-desc-filter-int-gt | `$orderby=TimestampField desc&$filter=IntegerField gt value` |

### Enumeration Tests (depend on enum mode)

Three enum modes exist. The mode is auto-detected from metadata or set with `--enum-mode`:

| Mode | How Single Lookups Work | How Multi Lookups Work | Detection |
|------|------------------------|----------------------|-----------|
| **string** | `Edm.String` + LookupName annotation | `Collection(Edm.String)` | LookupName annotations present |
| **collections** | `Edm.EnumType` | `Collection(Edm.EnumType)` | Collection enum types present |
| **isflags** | `Edm.EnumType` | `Edm.EnumType` with `IsFlags=true` | IsFlags attribute on enum definitions |

**OData enum type scenarios** (run in `collections` and `isflags` modes):

| Scenario | Filter | Modes |
|----------|--------|-------|
| filter-enum-single-has | `SingleLookupField has Namespace'Value'` | isflags |
| filter-enum-single-eq | `SingleLookupField eq Namespace'Value'` | collections, isflags |
| filter-enum-ne | `SingleLookupField ne Namespace'Value'` | collections, isflags |
| filter-enum-multi-has | `MultiLookupField has Namespace'Value'` | isflags |
| filter-enum-multi-has-and | `MultiLookupField has Value1 and has Value2` | isflags |
| filter-coll-enum-any | `MultiLookupField/any(x:x eq Value)` | collections |
| filter-coll-enum-all | `MultiLookupField/all(x:x eq Value)` | collections |

**String enum scenarios** (v2.1.0, run in `string` mode):

| Scenario | Filter |
|----------|--------|
| filter-string-enum-single-eq | `StandardStatus eq 'Active'` |
| filter-string-enum-single-ne | `StandardStatus ne 'Active'` |
| filter-string-enum-multi-any | `Features/any(x:x eq 'Value1' or x eq 'Value2')` |
| filter-string-enum-multi-all | `Features/all(x:x eq 'Value1' or x eq 'Value2')` |

### Error Code Tests (always run)

| Scenario | Expected |
|----------|----------|
| response-code-400 | HTTP 400 for invalid query syntax |
| response-code-404 | HTTP 404 for non-existent resource |

### v2.1.0 Additional Tests

| Scenario | What's Tested |
|----------|---------------|
| server-driven-paging | `@odata.nextLink` pagination — multiple pages, final page has no nextLink |
| expand | `$expand` navigation property — expanded data present in response |

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
