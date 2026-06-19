# Data Dictionary Compliance Testing

Validates OData servers against the RESO Data Dictionary 2.0 specification. DD 2.1 coming soon.

Replaces the Commander-based DD workflow entirely – metadata serialization, Lookup Resource fetching, and replication all happen natively in TypeScript, calling cert-utils inner functions directly for the replication strategies and variations checking.

> **Note:** RESO no longer certifies providers on DD 1.7. The CLI enforces DD 2.0. DD 1.7 is available via the SDK for historical compatibility only.

## Usage

```bash
reso-cert dd --url https://api.example.com --auth-token TOKEN

# Strict mode (fail on variations and schema validation errors)
reso-cert dd --url https://api.example.com --auth-token TOKEN --strict

# Batch expand optimization (see below)
reso-cert dd --url https://api.example.com --auth-token TOKEN --batch-expand

# Limit records per resource
reso-cert dd --url https://api.example.com --auth-token TOKEN --limit 10000
```

## Pipeline

The DD pipeline executes these steps:

| Step | What It Does |
|------|-------------|
| Health check | Wait for server to respond |
| Resolve auth | Bearer token or OAuth2 Client Credentials |
| Generate metadata report | Fetch `/$metadata`, serialize to metadata-report.json, fetch and merge Lookup Resource data if available |
| Initialize replication state | Shared state service that tracks stats across all replication strategies |
| Check variations (DD 2.0) | Compare metadata against reference DD, flag non-standard fields/lookups |
| Replicate: TIMESTAMP_DESC | Fetch all records ordered by ModificationTimestamp descending |
| Replicate: NEXT_LINK (DD 2.0) | Fetch all records using server-driven paging |
| Replicate: NEXT_LINK + filter (DD 2.0) | Fetch recent records with ModificationTimestamp filter |

### DD 2.0 Testing

| Capability | Details |
|------------|---------|
| Replication strategies | TIMESTAMP_DESC + NEXT_LINK + NEXT_LINK with filter |
| Variations check | Yes |
| JSON schema validation | Yes (in strict mode) |
| Page size | 1000 |

## Expansion Strategies

During replication, the DD pipeline fetches both top-level resources and their expanded navigation properties (e.g., `Property?$expand=Media`). Two strategies are available:

### Default: One Expansion per Request

Each navigation property gets its own request:
```
GET /Property
GET /Property?$expand=Media
GET /Property?$expand=OpenHouse
GET /Property?$expand=PropertyRooms
...
```

This is the safer approach – each response is manageable in size, and a failure on one expansion does not affect others.

### `--batch-expand`: All expansions in a single request

All navigation properties for a resource are batched into one request:
```
GET /Property
GET /Property?$expand=Media,OpenHouse,PropertyRooms,UnitTypes,...
```

This reduces the number of HTTP round-trips significantly (e.g., 18 separate requests become 1). However, each response is much larger since it includes all related records inline.

### Benchmark Results

Tested against the RESO reference server (Docker, PostgreSQL, 153 Property records with 18 navigation properties):

| Strategy | Default (one-at-a-time) | Batch expand |
|----------|------------------------|-------------|
| TIMESTAMP_DESC | 215s | 417s |
| NEXT_LINK | 154s | 114s |
| NEXT_LINK + filter | 155s | 420s |
| **Total** | **8m 44s** | **15m 51s** |

**Key findings:**

- Batch expand was **slower** for this server because each expanded response was massive (153 records × 18 nav properties = huge JSON payloads)
- The NEXT_LINK strategy was faster with batch expand because server-driven paging handles large payloads more efficiently
- Batch expand is most beneficial for servers with many resources but lightweight expansions, or when combined with parallel execution
- The default one-at-a-time approach is safer and faster for servers with large expansion payloads

**Recommendation:** Use the default unless you know your expansions are lightweight. Batch expand shines when round-trip latency is the bottleneck rather than payload size.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--dd-version` | 2.0 | DD version (2.0) |
| `--limit` | 100000 | Max records to replicate per resource |
| `--strict` | false | Fail on variations, enforce JSON schema validation |
| `--batch-expand` | false | Batch all expansions per resource into a single `$expand` request |

## Metadata Report

The pipeline always generates a canonical metadata report at `metadata-report.json` in the RESO standard format. When a Lookup Resource is present it holds the merged result; otherwise it holds the base report:

```json
{
  "description": "RESO Data Dictionary Metadata Report",
  "version": "2.0",
  "generatedOn": "2026-04-06T00:00:00.000Z",
  "resources": [{ "resourceName": "Property" }, ...],
  "fields": [
    {
      "resourceName": "Property",
      "fieldName": "ListPrice",
      "type": "Edm.Decimal",
      "nullable": true,
      "scale": 2,
      "precision": 14,
      "isEnumeration": false,
      "annotations": [...]
    }
  ],
  "lookups": [
    {
      "lookupName": "StandardStatus",
      "lookupValue": "Active",
      "type": "Edm.String",
      "annotations": [...]
    }
  ]
}
```

When the Lookup Resource is available, it is fetched (using `@odata.nextLink` pagination with `$top`/`$skip` fallback) and merged with the EDMX-based report. Fields with `LookupName` annotations get their type replaced with the lookup name.

## Output Directory Structure

Results are written to a directory structure compatible with `reso-certification-utils`:

```
.reso-cert/
  data-dictionary-<version>/
    <providerUoi>-<providerUsi>/
      <recipientUoi>/
        current/
          metadata.xml                           # Raw EDMX XML from /$metadata
          metadata-report.json                   # Canonical metadata report (merged when Lookup Resource present, else base)
          metadata-report.raw.json               # Pre-merge base report (only when a Lookup Resource merge occurred)
          lookup-resource-lookup-metadata.json    # Raw Lookup Resource data dump
          data-availability-report.json          # Replication results and field coverage
          data-availability-responses.json       # Raw OData response data
          data-dictionary-variations.json        # Variations report (DD 2.0)
        archived/
          20260406T033000000Z/                   # Previous run (auto-archived)
            ...
```

### Path Construction

When using a config file (`--config`), the path components come from the config:
- `providerUoi` and `providerUsi` from the top-level config
- `recipientUoi` from each config entry

When running from CLI flags (no config), local placeholders are generated:
- `LOCAL-<timestamp>` for providerUoi
- `LOCAL-SYSTEM` for providerUsi
- `LOCAL-RECIPIENT` for recipientUoi

### Archiving

Each run automatically archives the previous `current/` directory to `archived/<timestamp>/` before writing new results. This preserves a full history of all runs for a given provider/recipient combination.

### Migration from reso-certification-utils

For providers currently using `reso-certification-utils`, the output structure is identical. The `results/` directory becomes `.reso-cert/` – you can symlink for backward compatibility:

```bash
ln -s .reso-cert results
```

### Report Files

| File | Description |
|------|-------------|
| `metadata.xml` | Raw EDMX XML downloaded from `/$metadata` |
| `metadata-report.json` | Canonical metadata report — merged with Lookup Resource data when available, base (EDMX-serialized) report otherwise |
| `metadata-report.raw.json` | Pre-merge base report from EDMX, written only when a Lookup Resource merge occurred |
| `lookup-resource-lookup-metadata.json` | Raw Lookup Resource records (LookupName, LookupValue, StandardLookupValue, LegacyODataValue) |
| `data-availability-report.json` | Field coverage, record counts, and data availability statistics per resource |
| `data-availability-responses.json` | Raw OData response payloads from replication |
| `data-dictionary-variations.json` | Non-standard fields and lookups found during variations checking (DD 2.0) |

## Future Optimizations

- **Parallel execution**: Split the precomputed query list across N workers, each replicating a subset of resources concurrently. The replication state service is shared across workers for consistent tallying. Combined with batch expand, this could reduce DD testing time by an order of magnitude for servers with many resources.
- **Selective batching**: Batch small expansions (Rooms, UnitTypes) but keep large ones (Media) as separate requests, based on estimated payload size from metadata field counts.
- **Schema validation error accumulation**: Allow non-strict mode to continue past schema validation errors, collecting all errors and reporting them at the end rather than stopping on the first one (see #95).

## Files

```
src/sdk/dd.ts                    # DD pipeline (calls cert-utils inner functions)
src/metadata/serializer.ts       # EDMX → metadata-report.json
src/metadata/lookup-resource.ts  # Lookup Resource fetch + merge
src/data-dictionary/             # DD-specific types and exports
legacy-cert-utils/               # Local copy of cert-utils v3.0.0 (for direct modification)
```
