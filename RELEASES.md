# RESO Tools – Release Notes

---

## reso-common 0.4.1 · reso-certification 0.10.8 – 2026-10-06

**The `reso-cert` CLI has not been runnable from npm since 0.10.2.** Five consecutive releases
shipped it non-executable. This release fixes that, and it is the reason to upgrade.

Publish `reso-common` first. `reso-certification` calls `parseReplicationProgress` and
`summarizeReplicationProgress` at runtime, and those arrive in 0.4.1. Installing 0.10.8 against
`reso-common` 0.4.0 resolves a package whose progress renderer calls two functions that are not
there.

### The executable bit

`tsc` emits files in `dist/` as 0644. `prepublishOnly` runs the build, `npm pack` preserves whatever
mode is on disk, and nothing downstream restores it, because npm does not chmod bin targets on
install. So every tarball from 0.10.2 onward carried `package/dist/cli/index.js` as `-rw-r--r--`, and
`reso-cert` answered `Permission denied`.

It misdirected as well as failed. `npx` treats a non-executable local bin as unusable and falls
through to the registry copy, which had the same defect, so the error named a path inside the npx
cache and pointed away from both the cause and the local build the user meant to run.

The build now sets the bit, and a test in each package asserts it by reading the path out of the
`bin` field, so renaming an entry point cannot leave the test passing against a file nobody ships.

### Plain http on loopback

`ensureHttps` normalizes `TOKEN_URI` and `RESO_SERVICES_URL`, upgrading a plain `http` address to
`https` because a credential travels on both. It was doing that on loopback too, which is wrong: the
only way to satisfy it is to generate and trust a local certificate to run a service on your own
machine, and the rewrite was silent, so the failure arrived later as a connection error naming
neither the rewrite nor the variable.

`localhost`, the whole 127.0.0.0/8 block and `[::1]` now keep plain http. They are matched by exact
equality on the parsed hostname, so a lookalike such as a host ending in `localhost` is still
upgraded. `host.docker.internal` is deliberately not exempt, because it resolves off the container
and Docker can reach a loopback address directly. Everything else still upgrades, and an empty
value, an unparseable address and a non-http scheme are all still refused.

**Worth knowing if you rely on the old behavior:** an http address that is *not* loopback is still
rewritten to https silently rather than refused. That is deliberate, since no operator means to send
a credential unencrypted, but it does mean a non-loopback http endpoint will fail to connect rather
than report a scheme problem.

### Packaging

Two tarballs carried files nobody needs. `reso-certification` shipped seven test fixtures inside
`dist/etl/test`, swept in because the build copies `src/etl` wholesale. `reso-mcp-server` declared no
`files` field, the only package that did not, so its tarball carried its own source, its four test
files and its `tsconfig.json`.

### Refreshed Data Dictionary reference metadata

`reso-common` carries the DD reference metadata that the certification pipeline validates against,
and the copy it has been publishing is wrong. Every version published so far ships a DD 2.1 with
`FeedTypes` on the EntityEvent Resource.

`FeedTypes` annotates a data element with the feed types it is available in: BBO, IDX, PDAP and VOW.
EntityEvent is the change-notification envelope rather than a data resource, so the annotation does
not describe anything a consumer can act on. A client does not subscribe to EntityEvent per feed
type.

Corrected upstream in the authoritative sheet, since these files are a pure projection of it and
hand-editing them is not a repair. DD 2.1 goes from 2,140 fields to 2,139 and `FeedTypes` from 41
resources to 40. `Property` and the Field Resource keep it, which is where it belongs. The 1.7 and
2.0 files are unchanged apart from their generation stamp, because `FeedTypes` is a DD 2.1 element
and those sheets carry no `FeedTypes` rows at all.

Two consumers do not pick this up from a `reso-common` publish and need their own step. The
certification backend's DD reference Lambda layer holds an independent copy, so server-side batch
validation keeps answering from the old data until that layer is republished. The desktop client
packages these files from the published `reso-common`, so it needs this release and then a rebuild.

## reso-common 0.4.0 – shared lock identifiers for certification variations – 2026-09-29

Additive. Two builders and a stem constant, no behaviour change to anything existing.

A variations lock is coordinated by string equality on an identifier and nothing else. There is no requirement on what a lock may be taken on, and the table holding them is shared with other resource kinds, so the identifier is the entire contract. It was being built independently by the certification service, to find a lock, and by the review client, to take one – in two repositories that share no package.

Drift between two such copies is silent. A lock exists that nobody else can address, its holder believes they hold the resource, everyone else sees it free, and both proceed. Nothing errors. A test on each side spelling out the format catches an accidental edit but not a deliberate one-sided change, which is how the two came to disagree while both suites stayed green.

Now exported from the package root:

- `variationsReportUrn(environmentName, ddVersion, providerUoi, providerUsi, recipientUoi)`
- `variationsCanonicalStoreUrn(environmentName)`
- `VARIATIONS_URN_STEM`

They name the thing rather than the mechanism acting on it. Locking is the first consumer and the one that forced the shape, but the same identifier is what any other use would want – a notification about a report, an audit entry, a permission attached to one. A lock stores it as its `resourceId`: the id of the resource being locked, not an id of the lock.

The form follows the ARN discipline rather than any existing `urn:reso:` precedent – every scoping dimension is a named position, and the resource type precedes the identity so it selects which rules apply. Past the `urn:reso` stem each sub-branch is owned by different functionality and governs its own grammar, so this subtree owes its shape to neither `metadata` nor `upi`.

Two dimensions the previous path-shaped keys were missing. The **environment**, without which the same report in QA and in production produced the identical key and a reviewer in one environment locked out a reviewer in the other – there is one locks table and the row carries no environment. And the **resource type**, without which a report lock and the canonical-store lock shared a prefix and were told apart by counting segments; a validation check that inferred the type that way would have rejected the canonical lock and broken the decisions endpoint.

The builders refuse an empty coordinate or one carrying the `:` separator. Both produce a well-formed-looking identifier that silently means the wrong thing: an empty position collides with any other identifier missing the same one, and an embedded separator shifts every position after it, so `('A:B', 'C')` and `('A', 'B:C')` are the same string. This validates construction, which is a different thing from validating an identifier handed in – the latter imposes a shape the system does not require.

Safe to re-format at any time: every lock expires on its TTL, so no identifier minted under an earlier grammar is ever read back.

---

## reso-reference-server 0.8.2 – exported metadata utilities for embedding hosts – 2026-09-28

A published-package patch – no monorepo release. Additive: four symbols exported from the package root, no behaviour change.

`createApp` returns `{ app, dal, cleanup }`, so a host embedding the server can already mount its own routes on the Express app before listening. But anything it mounts needs the same metadata and data access the built-in routes use, and the package's `exports` map is `.` only, which blocks deep imports into `dist/`. So an embedding host could reach the `dal` and then do nothing useful with it.

Now exported from the root:

- `TARGET_RESOURCES` and `reconcileLookups`
- the `DataAccessLayer` and `ResourceContext` types

The other metadata helpers a caller is likely to want – `getFieldsForResource`, `getKeyFieldForResource`, `getLookupsForType`, `isEnumType` – are already public from `@reso-standards/reso-common`, as are the `ResoMetadata`, `ResoField` and `ResoLookup` types. So this closes the gap rather than opening a new surface.

Prompted by the desktop client, which mounts a data generator of its own and had been reaching the server's internals through a patched build rather than a supported entry point.

---

## reso-certification 0.10.7 + reso-reference-server 0.8.1 – 2026-09-28

A published-package patch to two packages – no monorepo release. Both already declared `@reso-standards/reso-common ^0.3.0` in source, but neither had been republished since, so the versions on npm still carried `^0.2.0`. Every consumer therefore resolved reso-common to 0.2.x and nothing could reach 0.3.0, however recently it had been installed.

### What that cost

- **Pre-rollback DD 2.1.** reso-common 0.2.1 ships the DD 2.1 reference metadata from before the 2026-09-18 sheet rollback – 44 resources and 2,167 fields, still carrying the `Model` resource. 0.3.0 ships the corrected 43 / 2,140.
- **No element level.** The variations record model landed in reso-common 0.3.0. Consumers pinned to 0.2.x have no element-level surface, so code written to read the level falls back to inferring it – which is how expansions came to be reported as fields with no suggestion.

### The change

Version numbers only. Both dependency ranges were already correct; npm simply rejects a republish at an unchanged version, so `reso-certification` goes 0.10.6 → 0.10.7 and `reso-reference-server` 0.8.0 → 0.8.1. Consumers on `^0.10.0` and `^0.8.0` pick these up automatically, and reso-common then resolves to 0.3.0.

No behaviour change in either package beyond what the newer reso-common brings.

---

## Web API Core 2.1.0 — `$expand` data-validation + version normalization (desktop v1.0.0-beta.12) – 2026-09-11

A coordinated patch across `reso-metadata-utils` (0.1.1 → 0.1.2) and `reso-certification` (0.10.5 → 0.10.6), shipped in desktop **v1.0.0-beta.12**. Consumers on `^0.1.0` / `^0.10.0` pick these up automatically. Three separate bugs let Web API Core 2.1.0 `$expand` per-item schema validation silently skip in real (desktop / config-mode) runs; this closes all three and tightens the `$expand` gate.

### `reso-metadata-utils` 0.1.2 – declared EntityTypes in the metadata report

- **Contained / expansion-only types are no longer dropped.** `getAllFields` keyed the report off the entity container's EntitySets, so a declared EntityType with no EntitySet — an OData containment-navigation target (`ContainsTarget="true"`, e.g. a contained `Media` collection) — was omitted. Downstream JSON-Schema generation then emitted a `$ref` to a definition that was never built, ajv failed to compile, and the whole `$expand` validator degraded to a 200-only gate, so schema-invalid expanded data went uncaught (a false-pass). Every declared EntityType is now emitted, keyed by type name so a `Collection(Ns.Type)` reference always resolves; deduped against the served entry keys so a contained type can never clobber a served resource. No-op for conformant RESO metadata (EntitySet name == type name).

### `reso-certification` 0.10.6 – `$expand` gating + Core version normalization

- **Config-mode version normalization.** Config sources supply the Core version as `"2.1"` (two-part) while the gates compared against the literal `"2.1.0"`; a bare cast let `"2.1"` through, so the `$expand` schema-validator gate read false in config-file mode — the data-validation half never ran on desktop / config-mode runs (a false-pass). Versions are normalized once at the SDK boundary (`coerceCoreVersion`), and an unknown/newer version clamps **up** to the current minor rather than down to the oldest baseline.
- **The `$expand` gate enforces the data.** A present expansion must be a Collection of the target EntityType (a JSON array of entity objects; a malformed 200 envelope fails). Non-2xx (403/501) skips — expansion is optional, and not-accessible ≠ non-conformant. A collection navigation-property-path returning 204 fails: a collection returns 200 with an empty result set, never 204 (OData §11.2.7 / web-api-core §2.5.10.2, §2.6.1).
- **`$expand` and the navigation-property-path form must be data-consistent (OData §11.2.7).** Both resolve the same relationship on the same entity, so they must agree on whether related entities exist; a records↔empty disagreement is a determinate fail. Both legs treat an empty page + `@odata.nextLink` as has-records, so server-driven paging never false-fails.
- **`$select` may return additional fields** (OData 4.01 §11.2.5.1 — a service may return more than requested): the prior extra-field warning is dropped.

**Tests:** Full monorepo suite now 2,181 passing across 8 packages.

---

## reso-certification 0.10.5 – 2026-09-02

A published-package patch to `reso-certification` – no monorepo release. Consumers on `^0.10.0` pick it up automatically; behavior-preserving for the CLI and cert-backend (no test-count change), and no other package changed.

### `reso-certification` 0.10.5 – bundle-static legacy-schema + DD-reference loads (reso-tools-private #102)

- **Desktop cert-worker fix.** The legacy JSON-schema module and the DD reference JSON were loaded via a computed `createRequire` path and a template-literal `require()`, which esbuild could not statically follow — so in the packaged desktop app they did not load, and Web API Core 2.1.0 `$expand` per-item schema validation silently degraded to "unavailable" (the nav gated on the HTTP 200 alone). Both loads are now bundle-static: a lazy dynamic `import()` with a literal specifier for the legacy module, and a per-version `switch` for the DD reference JSON, so esbuild inlines them into the cert-worker bundle.
- **Behavior-preserving** for the CLI and cert-backend (they run from `dist`, where the old paths resolved); full cert suite green (1,064 passed / 2 expected-fail). The desktop bundle now inlines the legacy schema and all three DD JSONs, verified by a new runtime load smoke in the bundler (reso-tools-private).
- Unsupported-version metadata lookups now **fail loud** (log) instead of silently returning empty.

---

## reso-certification 0.10.4 – 2026-09-02

A published-package patch to `reso-certification` – no monorepo release. Consumers on `^0.10.0` pick it up automatically; no other package changed (`reso-client` stays 0.2.2, `reso-common` 0.2.1).

### `reso-certification` 0.10.4 – Web API Core 2.1.0 Lookup Resource certification

- **Exhaustive `/Lookup` fetch by `LookupName`.** The served Lookup Resource is paged all the way through for each queried `LookupName` (`@odata.nextLink` followed with no page cap), so value presence reflects the provider's entire catalogue rather than the first page – there is no server-side value filter on `/Lookup` yet. A per-run cache keyed by `LookupName` dedupes the fetch across fields that share an enumeration.
- **Value presence across all three wire forms.** A served value is matched against the union of `LookupValue`, `StandardLookupValue`, and `LegacyODataValue`, so a provider serving any legal form of a catalogued value is not false-failed.
- **Gating StandardLookupValue validity.** Each declared `StandardLookupValue` is validated against the Data Dictionary standard set for the field's DD type – never the provider's arbitrary `LookupName` – with an any-DD-enum fallback for open enumerations that carry no standard set. A non-standard declared value fails Core.
- **Both gates honor `ignoreEnumerations`.** The committee-approved `schema-validation-settings.json` exemption (keyed by DD major.minor version) is threaded into both the presence and validity checks, so an exempt open or local field is never false-failed.
- **Tests:** new coverage for exhaustive paging, the tri-form presence union, the field-type DD-standard join, and the ignore-list exemption. Full monorepo suite now 1,963 passing across 8 packages.

---

## reso-certification 0.10.3 – 2026-09-01

A published-package patch to `reso-certification` – no monorepo release. Consumers on `^0.10.0` pick it up automatically; no other package changed (`reso-client` stays 0.2.2, `reso-common` 0.2.1).

### `reso-certification` 0.10.3 – Web API Core 2.1.0 `$expand` + served-resource gating

- **Declared-but-not-served carve-out for top-level resources.** A required 2.1.0 resource (Property, Member, Office plus Field, Lookup) that is declared in the metadata but absent from the service document now resolves to Not Applicable under the 2.1.0 carve-out instead of hard-failing as in 2.0.0. Backed by a new service-document parser and a run/fail/na serving decision, masking only on positive determinate agreement across both authoritative surfaces.
- **`$expand` per-item schema-validation gate.** Each expanded child item is validated against its target entity type in DD/Core mode (strict: unadvertised field, wrong type, over-length value, and null collection all fail), and a declared collection navigation is gated on that validation – a schema-invalid expanded item fails Core. New `expand-schema` SDK module; the validator degrades conservatively (gates on the 200 alone) if it cannot be built.
- **Non-gating related-record-key warning.** When an expanded item's `ResourceRecordKey` does not match the parent key, the run emits a non-gating warning – instrumenting the pain point per the cert-warnings convention rather than gating on it.
- **CLI:** shared option builders (auth, server URL, output, report directory) centralized in `shared-options.ts` – an internal refactor standardizing universal flags across commands, no behavior change.
- **Tests:** 8 new or expanded test files covering serving decisions, `$expand` gating, the RRK warning, and `$expand` sampling. Full monorepo suite now 1,944 passing across 8 packages.

---

## reso-client 0.2.2 · reso-certification 0.10.2 – 2026-08-30

A targeted post-Luna patch to two published packages – no monorepo release. Consumers on `^` ranges pick these up automatically (`reso-certification` resolves the new `reso-client` through its `^0.2.0` range).

### `reso-client` 0.2.2 – resilient HTTP client (#273)

- **Retry with capped backoff** on transient `429` / `503` responses, so a certification run survives provider rate-limiting instead of failing on the first throttle. A shared `createResilienceSession` wraps the client with this behavior.
- **Graceful deadline stop:** when a run's time budget is spent, remaining checks report NOT TESTED (the run is `incomplete`) rather than failing. `isDeadlineError` lets callers propagate the stop cleanly without discarding already-collected results.

### `reso-certification` 0.10.2 – `reso-cert rcf` + hardening

- **New `reso-cert rcf` command** – RESO Common Format certification. It infers a DD-2.0 metadata report from RCF payload data, then runs DD schema validation and variations against the inferred report.
- **Inference correctness:** detect payload-local collection enums, keep leading-zero codes (`01`, `007`) as string values rather than numbers, and reject impossible calendar datetimes (`2023-02-30T…`) instead of mis-typing them as `Edm.DateTimeOffset`.
- **Recover mis-named expansions by shape,** including depth-≥2 nested renames (kind matching).
- **Canonical RESO Data Availability Report** shape from the `rcf` command, and a fail-closed non-zero exit on a zero-record submission so an empty or unreadable payload never reads as a clean pass.
- Adopts the `reso-client` resilience layer for graceful deadline handling.

---

## v1.0.0 – "Luna"

The first stable release. RESO Tools splits into a **public, npm-published core** and a private application tier, so any project can consume the RESO libraries and the certification runner without the monorepo.

### Public/private split + npm publishing

- **Seven public packages now publish to npm** via per-package Trusted-Publishing (OIDC) CI: `reso-common`, `reso-metadata-utils`, `reso-client`, `odata-expression-parser`, `reso-validation`, `reso-certification`, and `reso-reference-server`. Consumers install them from the registry with `^` version ranges – no monorepo required.
- **The application tier moved to `reso-tools-private`:** the browser UI, the Electron desktop client, the CORS proxy, and the test-data generator. The public reference server switches to committed static seeds; the desktop app is still built and published here as a downloadable release.
- **npm workspaces** replace the bootstrap script – `npm install` links every package once and `npm run build` builds in dependency order (#230).
- Pre-publish package audit plus LICENSE / `publishConfig` / `files` readiness across the public set (#220).

### New shared metadata packages (the metadata split, #221)

- **`reso-common`** – the universal, zero-dependency RESO metadata model, projections and EDMX generator, and the single source of truth for the metadata shape: `buildMetadataMap`, the variations-matching helpers, and the DD reference metadata are all consolidated here. Runs unchanged in the browser and on the server.
- **`reso-metadata-utils`** – the dependency-requiring side: CSDL parsing and validation (CSDL/XSD), EDMX → metadata-report serialization, and live metadata fetching, migrated out of `reso-client`.
- Cut the legacy `@reso/reso-certification-etl` tarball dependency – the in-package v2 ETL now supplies the DD reference and stats engine.

### `reso-cert` – per-step certification CLI (#251)

Each certification step is now a standalone `reso-cert` command, so vendors can run any step in CI:

- **`schema`** – validate a payload against DD JSON Schema, or generate the schema from a metadata report.
- **`metadata`** – validate CSDL metadata (now requiring an `EntityContainer`) and convert it to a RESO metadata report.
- **`replicate`** – sample a resource via all four replication strategies (TopSkip, Timestamp Asc/Desc, NextLink), with `--strict`.
- **`find-variations`** – run DD value variations over the v2 Variations Service, from a `--metadata` file or `--from-server`.

These join the existing `add-edit`, `entity-event`, `core`, and `dd` commands.

### Certification correctness

- **Web API Core enum handling (IsFlags):** a shared enum-value decoder, the `resolveEnum` / `EnumField` abstraction, and correct IsFlags / collection / string-enum value selection, with adversarial fixes.
- **Fail-closed schema validation** for enum values a server serves but does not advertise.
- **DD metadata gate** wired into the pipeline – disallowed synonyms, closed-enum membership, field-type mapping, Lookup Resource sentinels, and finding severity + SHOULD warnings.
- CSDL semantic validation now requires an `EntityContainer`.

### Security

- Cleared npm vulnerabilities across all packages; removed the unused legacy cert-utils and the `xlsx` dependency; bumped Vitest to 4.
- Recorded the v1.0.0 pre-publish security audit.

---

Releases before v1.0.0 are not listed here. The full history is retained in RESO's internal
archive. Most earlier versions also carry a git tag in this repository, though not all of them do:
tagging began at v0.2, and v0.1, v0.3, v0.11 and the v0.0.x series were never tagged.
