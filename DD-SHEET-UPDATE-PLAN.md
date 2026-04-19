# DD Sheet Update Plan — DD 2.1 Support

**Status:** Draft — needs review before implementation
**Risk level:** High — changes affect all certification testing
**Policy:** Yukkuri — verify at every step

---

## Current State

### ETL (`reso-certification-etl`)
- Has `dd-1.7/metadata-report.json` and `dd-2.0/metadata-report.json` in `lib/references/`
- **No dd-2.1 directory** — `getReferenceMetadata('2.1')` silently returns null
- Version routing via template literal: `require('./references/dd-${version}/metadata-report.json')`
- Default version is `'1.7'` (hardcoded in `common.js`)

### Legacy cert-utils (`reso-certification/legacy-cert-utils/`)
- `DATA_DICTIONARY_VERSIONS` only defines `v1_7` and `v2_0` — **no 2.1**
- `findVariations()` uses `getReferenceMetadata()` from ETL — will fail for 2.1
- Scoring/replication uses server metadata (not reference) — unaffected

### SDK (`reso-certification/src/sdk/dd.ts`)
- Accepts `'1.7' | '2.0' | '2.1'` in config
- Routes correctly for replication, variations, schema validation
- Schema validation settings file only has version `"2.0"` section — **no 2.1**

### Reference metadata (`reso-certification/reference-metadata/`)
- Has `dd-2.0.json` and `dd-2.1.json` but **these are NOT loaded by the pipeline**
- Pipeline loads from `node_modules/@reso/reso-certification-etl/lib/references/` instead

---

## What Needs to Change

### 1. Add DD 2.1 reference to ETL

**Action:** Create `lib/references/dd-2.1/metadata-report.json` in the ETL package

**Source:** Generate from the new DD 2.1 XLSX sheet using the ETL's own processing

**Risk:** Must match the exact format of dd-1.7 and dd-2.0 reference files (fields, lookups, resources arrays with annotations)

**Validation:** Compare field/lookup counts against XLSX (expect 1,610 unique fields, ~4,140 lookups)

### 2. Retain dd-1.7 and dd-2.0 references

**Action:** Keep existing reference files unchanged — old reports depend on them

**Rationale:** Users may run DD 1.7 or 2.0 tests locally for comparison purposes. Removing the references would break `findVariations()` for those versions.

**Future:** When we move to one sheet per major version with all elements (draft, deprecated), these can be consolidated. Not now.

### 3. Update legacy cert-utils version definitions

**Action:** Add `v2_1: '2.1'` to `DATA_DICTIONARY_VERSIONS` in `legacy-cert-utils/common.js`

**Risk:** Low — this constant is used for reference only, not for routing

### 4. Update schema-validation-settings.json

**Action:** Add a `"2.1"` section. Start by copying the `"2.0"` section and adjusting for any DD 2.1 changes (renamed unit fields, etc.)

**Question for Josh:** Should the 2.1 section be identical to 2.0 initially, or are there known schema validation differences?

### 5. Update default version

**Action:** Change `CURRENT_DD_VERSION` from `'1.7'` to `'2.1'` in ETL `common.js`

**Risk:** Medium — this is the fallback when no version is specified. Any code that relies on the default getting 1.7 will now get 2.1. Need to audit callers.

**Question for Josh:** Should the default stay at 1.7 for backward compatibility, or move to 2.1?

### 6. Wire ETL into reso-certification as a lib

**Action:** Copy ETL source into `reso-certification/lib/etl/` (or similar). Remove standalone package.json. Import from the local path instead of node_modules.

**Risk:** Medium — need to verify all imports resolve correctly after the move

**Deferred detail:** Ticket #132 covers the TS conversion. For now, keep as CommonJS under the lib directory.

### 7. UI: DD 2.1 as only certification option

**Action:** In the config builder, only show DD 2.1 as the version option for certification jobs

**CLI:** DD 1.7 and 2.0 still available via `--version` flag but cannot be submitted to cloud

**Risk:** Low — UI change only

### 8. Reference metadata files in reso-certification/reference-metadata/

**Action:** Regenerate `dd-2.0.json` and `dd-2.1.json` from the new XLSX sheets. Add `dd-1.7.json` if not present.

**Question for Josh:** These files exist but aren't loaded by the pipeline (it loads from ETL's node_modules). Should we switch the pipeline to load from `reference-metadata/` directly, making the ETL package unnecessary for reference data? Or keep both in sync?

---

## Execution Order

1. Generate dd-2.1 reference metadata JSON from the new XLSX
2. Add to ETL `lib/references/dd-2.1/`
3. Add `v2_1` to legacy cert-utils version definitions
4. Update schema-validation-settings.json with 2.1 section
5. Copy ETL into reso-certification as a lib
6. Update imports to use local ETL instead of node_modules
7. Run all existing tests — must pass unchanged
8. Run DD 2.0 test against local reference server — verify no regression
9. Run DD 2.1 test against local reference server — verify new fields/lookups detected correctly
10. Update UI to default to DD 2.1

---

## Decisions (Confirmed)

1. **Default version:** 2.1
2. **Schema validation 2.1:** Dynamically generated from reference metadata — pass the new 2.1 ref sheet
3. **Reference metadata source:** Move to `reso-certification/etl/reference-metadata/`, update all paths, export from top level. One source of truth in the repo, no npm package indirection.
4. **Cloud submission:** DD 1.7 and 2.0 local-only. Manual push if needed.
5. **DD 2.0 reference update:** Regenerate all three (1.7, 2.0, 2.1) from the corrected XLSX sheets. Old reference had errata — updated version scores correctly.

---

## Rollback Plan

If anything breaks:
1. Revert the ETL lib copy (git revert)
2. The existing node_modules ETL package is untouched
3. Reference metadata files are additive (dd-2.1 added, others unchanged)
4. Schema validation settings are version-keyed, so 2.0 behavior is unaffected
