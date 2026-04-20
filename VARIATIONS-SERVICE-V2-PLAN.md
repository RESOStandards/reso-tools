# Variations Service v2 Plan

## Overview

Rewrite the variations service (search + update) as a TypeScript SDK in a shared Lambda Layer. Fix all known bugs in v1, add timestamps, version targeting, policy-based mappings, and FT access control. Transform existing v1 data to v2 format.

V1 stays frozen and deployed. V2 runs alongside it via API Gateway base path mapping.

---

## V1 Bugs (fixed in v2)

1. **Permission guard inverted** — Admin Review mappings are blocked (should be editable). Fast Track mappings are unprotected without `overwrite` (should be immutable except by FT callers).
2. **Removal filter uses AND instead of OR** — removes too aggressively on field and lookup mappings.
3. **Unsanitized rest spread** — arbitrary keys from input payload stored in mappings.
4. **No concurrency protection** — read-modify-write without ETag check on S3.
5. **Silent drops** — missing `resourceName` silently ignored, no error or stats.
6. **Header casing** — will break on REST API Gateway migration.
7. **No duplicate detection** — same item twice in batch → last-write-wins silently.
8. **Data leak** — `console.log(metadataReportData)` logs full metadata to CloudWatch.

---

## V2 Correct Behavior

### Update Rules

1. **Fast Track mappings are immutable** — only a caller with `isFastTrackAdmin` + `overwrite` can change them.
2. **Admin Review mappings are mutable** — both Fast Track and Admin callers can change, ignore, or remove them. If Fast Track makes the same mapping, promote to `isFastTrack: true`.
3. **No existing flags** — any admin caller can write.
4. **Ignored takes precedence** — setting ignored clears suggestions. Adding a suggestion clears ignored.
5. **Removal** — remove only the exact matching suggestion (all identifying fields must match, use OR in filter). Keep everything else.
6. **Input is sanitized** — allowlist of known fields. Everything else dropped.
7. **Writes are atomic** — ETag-based conditional write on S3. If file changed since read, fail and retry.

### Access Control

| Caller | Can modify Admin Review | Can modify Fast Track | Can ignore anything | Direct write |
|--------|------------------------|----------------------|--------------------|----|
| Admin (`isAdmin`) | Yes | No | Yes | Yes |
| FT Admin (`isFastTrackAdmin`) | Yes | Yes (with `overwrite`) | Yes | Yes |
| Service account (SQS processor) | Yes | Yes | Yes | Yes |
| Provider | No | No | No | No (read-only via search) |

Jason (non-FT admin) resolves variations reports → changes go to SQS → service account processes FT items.

---

## New Fields on Mappings

### Timestamps

- `createdAt`: Unix seconds (number) — when the mapping was first created
- `updatedAt`: Unix seconds (number) — when it was last modified

### Version Targeting

- `targetVersion`: string (e.g., `'3.0'`) — the DD version this mapping targets
- Search logic:
  - Requested version matches targetVersion → **match** (apply)
  - Requested version < targetVersion → **warning** ("upcoming in DD {targetVersion}")
  - Ignore/Admin actions are version-independent

### Policy-Based Mappings (new strategy)

- `strategy: 'Policy'`
- `policyName`: string (e.g., `'Replacement'`)
- Stored separately from provider suggestions — either `policies.json` in S3 or in the codebase
- Evaluated at search time against the metadata report
- Example: WaterBody/WaterfrontFeatures replacement policy

---

## Open Questions

### 1. Raw Data Shape

> Need to see the actual v1 data dump to design the transform. User will provide.

**Data:** Analyzed 2026-04-19. 10 resources, 476 fields, 38,178 lookup entries. 14,851 with suggestions, 22,983 ignored, 21,764 Fast Track, 545 Admin Review. 6,065 cross-field suggestions. Error cases extracted to `reso-certification/tests/fixtures/variations-error-cases.json`.

**Issues found:**
- 741 zombie entries (empty `{}` from removal bug)
- 20,689 inconsistent FT flags (suggestion has FT, parent doesn't)
- 10 flagged-but-empty entries (FT on parent, no suggestions)
- `suggestedRelated*` keys from unsanitized rest spread (legitimate data — compound mappings)

**Decision:** Keep the existing wire format (nested triple-index, same input/output shapes). Fix bugs, add new fields, don't break consumers. `suggestedRelated*` keys become officially supported.

### 2. Transform Strategy

> How to migrate existing v1 mappings to v2 format. Options:
> - One-time script that reads v1 file, transforms, writes v2 file
> - Dual-read in v2 search (reads both formats, merges)
> - Transform on first write (lazy migration)

**Decision:**

### 3. Policy Storage

> Where do policy definitions live?
> - In the codebase (versioned with the SDK)
> - In S3 alongside variations.json.gz
> - In DynamoDB (queryable, but adds complexity)

**Decision:**

### 4. Flat Map vs. Nested Triple-Index

> Current format: `mappings[resource][field][lookup]` (nested, human-readable)
> Alternative: flat hash map (faster iteration, easier comparison)
> Could do: nested for storage, flat index built at load time

**Decision:**

### 5. Test Harness

> Need to route requests to both v1 (frozen, warts and all) and v2 (fixed) for comparison testing. How to structure:
> - Separate Lambda functions with path-based routing?
> - Same Lambda with a version query param?
> - Shadow mode (run both, compare, return v1 result)?

**Decision:**

---

## Implementation Order

1. **Test harness** — route to v1 (frozen) and v2 side by side
2. **V2 search** — bug fixes, module-scope caching, version-aware filtering, forward-looking warnings
3. **V2 update** — collapsed into one generic function, sanitized input, ETag writes, correct permission logic
4. **Data transform** — migrate v1 mappings to v2 format (timestamps, targetVersion)
5. **FT access control** — `isFastTrackAdmin` flag on authorizer
6. **Policy engine** — load policy definitions, evaluate at search time
7. **Tests** — cover every path from the bug list + new behavior

---

## Architecture

```
API Gateway (REST, v2 base path)
  │
  ├── /v2/certification/variations/search  →  Provider Lambda
  │     └── variations-sdk.search()
  │           ├── Load variations.json.gz from S3 (cached at module scope)
  │           ├── Load policies.json (cached)
  │           ├── Match metadata report against triple index
  │           ├── Evaluate policies against metadata report
  │           └── Return matches + warnings + policy violations
  │
  └── /v2/certification/variations  →  Admin Lambda
        └── variations-sdk.update()
              ├── Load variations.json.gz from S3 (with ETag)
              ├── Validate input (allowlist fields)
              ├── Check permissions (isAdmin / isFastTrackAdmin)
              ├── Apply updates (one generic function for all levels)
              ├── Conditional write back to S3 (ETag match)
              └── Return stats
```
