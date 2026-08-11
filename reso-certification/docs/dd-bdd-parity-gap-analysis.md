# DD BDD Parity Gap Analysis

Maps the Web API Commander's Data Dictionary BDD test surface to the Node port's coverage, to drive
the fail-fast DD **metadata gate** (metadata issues, run after the semantic/structural OData tests
and before the variations check).

Source: `web-api-commander/src/main/java/org/reso/certification/` – `features/data-dictionary/{v1.7,v2.0}/`
(generated `.feature` files) and `stepdefs/{DataDictionary,LookupResource}.java` (the step
implementations – the authoritative check logic).

## Surface

- **`resource-tests/*.feature`** – one file per resource, one `Scenario` per field. property.feature
  (v2.0) alone has 632 field scenarios. Implemented by `DataDictionary.java`.
- **`metadata-resource-tests/lookup-resource-tests.feature`** – the Lookup Resource (string
  representation) tests, RCP-032. Implemented by `LookupResource.java`. **Two scenarios.**

## Per-Field Checks (`DataDictionary.java`)

| Gherkin step | Semantics | Severity | Coverage |
|---|---|---|---|
| `"X" exists in the "X" metadata` | field-existence guard; scenario SKIPS if absent | n/a | N/A by design – DD fields are optional; the gate checks only declared fields |
| `"X" MUST be "X" data type` | EDM type-class match (8 DD types) | MUST | ✅ `checkFieldTypes` (full parity with `assertDataTypeMapping`) |
| `synonyms for "X" DO NOT exist` | disallowed synonym field absent (resource-scoped) | MUST | ✅ `checkDisallowedSynonyms` (matches the step-def: `getFieldMap(resource).containsKey(synonym)`) |
| `"X" MUST contain only standard enumerations` | closed enum: every member is standard (`standardMembers.containsAll(found)`) | MUST | ✅ `checkClosedEnumValues` – see note 1 |
| `"X" length SHOULD be equal to the RESO Suggested Max Length of N` | string max-length recommendation | SHOULD (warn) | ❌ **gap** (254 in property.feature) |
| `"X" precision SHOULD be equal to … Max Precision of N` | decimal precision recommendation | SHOULD (warn) | ❌ **gap** (62) |
| `"X" scale SHOULD be equal to … Max Scale of N` | decimal scale recommendation | SHOULD (warn) | ❌ **gap** (62) |
| `"X" MAY contain any of the following standard lookups` | informational (logs standard members) | MAY | not needed (no assertion) |
| `"X" MUST contain at least one of the following standard lookups` | ≥1 standard member present | MUST | ❌ gap – see note 2 |

**Note 1 – closed-enum is latent in the generated features.** `MUST contain only standard
enumerations` has **0 occurrences** in the v1.7 *and* v2.0 generated `.feature` files, yet the
step-def is fully implemented. So this is real Commander infrastructure that the generator stopped
emitting; carrying it over (dynamically, for `lookupStatus = "Locked with Enumerations"` fields) is
the right "old Commander rule." Our join is by transport FQDN (`field.type === lookup.lookupName`),
which is stricter/more correct than the step-def's join-by-field-name (it handles shared enums like
`IanaTimeZoneValues`).

**Note 2 – `MUST contain at least one standard lookup` is also 0 in v1.7/v2.0 features.** Defined but
not emitted. Low priority; revisit if a provider-facing need appears.

## Lookup Resource Checks (`LookupResource.java`, RCP-032) – Entirely Uncovered

The string representation serves enum values at `/Lookup`. These tests validate that surface.

| Gherkin step | Semantics | Coverage |
|---|---|---|
| `"Lookup" Resource data and metadata MUST contain the following fields` | mandatory fields present: `LookupKey, LookupName, LookupValue, ModificationTimestamp` | ❌ **gap** |
| `RESO Lookups using String or String Collection data types MUST have the annotation "RESO.OData.Metadata.LookupName"` | every string-enum field carries the LookupName annotation | ❌ **gap** |
| `fields with the annotation term "X" MUST have a LookupName in the Lookup Resource` | referential integrity: annotated fields resolve to Lookup Resource entries | ❌ **gap** |
| `valid data is replicated from the "Lookup" Resource` (Background) | replicate the Lookup dataset | replication layer (separate) |

These only apply to the **string + Lookup Resource** representation (not the EnumType rep).

## Summary of Gaps

1. **Lookup Resource tests** (string rep) – the category flagged: mandatory fields, the LookupName
   annotation requirement, and annotation↔Lookup-Resource referential integrity. Distinct from the
   per-field checks; a new check group fed by the metadata report + the Lookup Resource dump.
2. **precision / scale / length SHOULD** – per-field numeric/string constraints. SHOULD-severity, so
   warnings, not gate failures. Mechanically simple (compare against the reference's
   maxLength/precision/scale, which the dd-json already carries).
3. `MUST contain at least one standard lookup` – latent, low priority.

## Covered Today (Committed)

`checkFieldTypes`, `checkDisallowedSynonyms`, `checkClosedEnumValues` – `src/metadata/dd-metadata-checks.ts`,
reference-clean against dd-1.7/2.0/2.1, with teeth controls.

## Next (Separate)

Core BDD (`WebAPIServerCore.java`) gap analysis – handcrafted, parallel to the DD BDD.
