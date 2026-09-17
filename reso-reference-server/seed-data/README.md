# Seed dataset

`seed.json.gz` — 948 synthetic records across 12 resources (Property 50, Media 285, Member 39, Office 17, OUID 2, Teams 5, OpenHouse 100, PropertyRooms 150, PropertyUnitTypes 100, PropertyGreenVerification, PropertyPowerProduction, Showing), generated with `reso-data-generator` in July 2026 and loaded by `POST /admin/seed` (keys preserved, so FK links survive across pg / mongo / sqlite).

## Provenance and conformance

- **2026-07-18** — generated (commit `790c367`). The generator of that date chose decimal places by field *name* and ignored the Data Dictionary scale, so nine scale-0 `Edm.Decimal` fields carried fractional values: Property `NumberOfSeparateElectricMeters` / `NumberOfSeparateGasMeters` / `NumberOfSeparateWaterMeters` / `MobileLength` / `MobileWidth`, Media `ImageHeight` / `ImageWidth`, PropertyGreenVerification `GreenVerificationMetric`, PropertyPowerProduction `PowerProductionAnnual` — 482 values the server's own certification rejects ("MUST be integer or null but found decimal").
- **2026-09-17** — repaired in place with `scripts/repair-seed-scale-0.mjs`: exactly those nine fields regenerated under the fixed generator's rule (the field's scale is the ceiling on decimal places) and bounds, from a seeded PRNG (`20260917`) so the repair is reproducible; every key, FK link and other value byte-identical. The generator fix itself is reso-tools-private #103.

The dataset before the repair is kept as `reso-certification/tests/fixtures/seeds/known-bad-scale-0-decimals.json.gz` and this file as `known-good.json.gz`; `reso-certification/tests/seeds/seed-conformance.test.ts` pins both (the nine fields with their counts on known-bad; zero integer findings and zero fractional scale-0 values on known-good; nothing else changed between them).

## Check it yourself

From `reso-certification/`: run the DD 2.0 schema validator over each resource of the seed (`tests/seeds/seed-conformance.test.ts` does exactly this). Note that validating the seed against the *bare* DD reference also reports "MUST be advertised in the metadata" on enum fields — that is an artifact of the reference leaving open lookups unenumerated; the running server advertises the seed's values through its `/Lookup` reconciler, so those are not server defects.
