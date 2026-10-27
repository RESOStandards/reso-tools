# RESO Tools – Release Notes

---

## Certification 0.11.4 – 2026-10-27

`reso-certification 0.11.4`

The CLI reads the credentials file the certification site hands out, a new `restore` command puts a certification server backup back on a Cert API, and a host can compute variations with a module of its own. The published package carries no organization identifiers, and publishing now checks the packed artifact before it leaves.

### The CLI reads the downloaded `credentials.env`

The certification site hands out a file named `credentials.env`, but the CLI never looked for it. Someone who put the downloaded file beside the CLI got an authentication error. At startup the CLI now reads the first of these that exists, and no other:

1. `credentials.env` in the working directory
2. `.env` in the working directory
3. `.env` in the `reso-certification` package root
4. `.env` in the `reso-tools` monorepo root

Only the first is new. The other three are where the CLI already looked, in the same order.

- **The environment always wins.** A variable already set in the shell, in CI or inline is never overwritten by the file.
- **The CLI says what it read.** Before a command runs, it prints the file and the names of the variables it set, never their values.
- **Credentials are masked as they load.** A value whose name ends in `SECRET`, `PASSWORD` or `API_KEY` is masked in everything the CLI prints.
- **A file that exists but cannot be read stops the command** with exit code 2, rather than being skipped for the next one.

### `reso-cert restore` puts a certification server backup back

```
reso-cert restore --path <backup root> --url <cert api> [--execute] [--limit n] [--derive-missing-type]
```

It walks the backup, decompresses each report and posts it to the Cert API's restore endpoint, then prints what it found and what it sent.

- **A dry run is the default.** Nothing is sent without `--execute`, and `--limit` sends only the first few.
- **A rerun resumes.** A ledger beside the backup records each report that landed, and a later run skips them. `--ledger` puts it elsewhere.
- **Whether a report was archived comes from where it sits in the backup,** under its own `archived/` tree, never from a flag.
- **A missing report type is supplied only when two sources agree.** With `--derive-missing-type`, a report written before the type field existed takes its type from its directory, and only when the directory's version matches the report's own.
- **It reads `CLIENT_SECRET`,** the value the downloaded credentials file carries, or `CERTIFICATION_API_KEY`.

### A host can compute variations with its own module

A host that runs the SDK can name a module that computes variations in place of the HTTP variations service:

```
RESO_VARIATIONS_HANDLER=/path/to/module.js
```

The module exports `computeVariations(request)`. It takes the body the service's compute route takes (`metadataReportJson`, `version` and an optional `fuzziness`) and answers what that route answers. On that path no service address or token is needed.

- **It is an explicit setting.** Nothing infers where the SDK is running. Without the variable the HTTP service is called exactly as before, so the CLI and the desktop, which never set it, are unaffected.
- **A failure names the variable.** A module that cannot be loaded, exports no `computeVariations`, throws or answers without a variations report fails the variations step.
- `VARIATIONS_HANDLER_ENV` and the `ComputeVariationsRequest` type are exported for hosts writing the module.

### Publishing checks the packed artifact for organization identifiers

- **The README's example configuration uses synthetic identifiers** for the recipient and the provider system.
- **Publishing scans what `npm pack` produces before it publishes.** `scripts/scan-pack.mjs` fails the release on an organization UOI, or on a bare number beside a USI key, that is not a sanctioned example. RESO's own identifier and a small set of synthetic values are sanctioned. It reads the tarball rather than a diff, because a diff cannot see content that was committed before the check existed.
- **Run it locally with `npm run scan:pack:certification`.**
- A source comment no longer names a provider.

### Documentation and housekeeping

- The tools site publishes every document a guide links to, so the certification run reference and the MCP server's architecture open on the site rather than on GitHub.
- The package README and the guide say where the CLI reads its credentials from, and the CLI reference documents `restore` and `RESO_VARIATIONS_HANDLER`.
- The README says which endorsements need production data and which may be tested against a development environment.
- `.gitignore` covers the output directories a comparison run writes, which carry provider payloads.

---

## Certification 0.11.3 – 2026-10-21

`reso-certification 0.11.3` · `reso-reference-server 0.8.5`

A collection field outside the Data Dictionary no longer fails schema validation when its values are correct, a refused token request now says why, and the reference server says why it could not reach a server it proxies to.

### Collection fields are always read as collections of their element type

A metadata report records a field's **element** type, such as `Edm.String`, and marks a list with `isCollection`. Releases of `reso-metadata-utils` before 0.1.4 kept the CSDL form `Collection(Edm.String)` in the type instead. The schema generator does not recognize that form, so it typed each item of the list as an object. Every value then failed:

```
Schema validation (Property): 2,779 errors, 1 type here (2,779 run total) · MUST be object but found string 2,779 on 1 field (<field>)
```

Most fields escaped this by accident, because the Lookup Resource merge rewrites the type of any field with a lookup. A collection field with no lookup, typically a vendor extension, did not. A list of plain strings that matched the metadata exactly produced thousands of errors and failed the run.

`reso-metadata-utils` 0.1.4 already writes the element type. 0.11.2 accepted any 0.1.x, though, so an install that resolved an older release brought the problem back. This release:

- **Requires `reso-metadata-utils` 0.1.4 or later.**
- **Normalizes every metadata report as it enters the engine,** whether it is generated from a server's metadata or read from a file. A report has the same shape whichever version wrote it.
- **Normalizes again where every JSON Schema is built,** so the `replicate` and `schema` commands are covered when they are given a report file written by an older tool.

If a run failed on a collection field with "MUST be object but found string" and the values are plain strings, rerun with this release.

### A refused token request says why

When the token endpoint refuses `CLIENT_ID` and `CLIENT_SECRET`, the CLI now prints the endpoint's address and the server's reason:

```
OAuth2 token mint failed: HTTP 400 Bad Request from https://cert-api.reso.org (access_denied: Unauthorized).
  The token endpoint refused CLIENT_ID and CLIENT_SECRET. Download a fresh Certification Environment File from your account on the certification site and try again.
  CLIENT_ID, CLIENT_SECRET or TOKEN_URI set in your shell take precedence over the .env file, so check those if a new file changes nothing.
```

Before, only the status was printed, and the variations check then suggested setting a different set of variables. The service messages now name `TOKEN_URI`, `CLIENT_ID` and `CLIENT_SECRET` first, and point back to this line when it was printed. Only the two standard OAuth2 error fields are printed, never the rest of a response, and the client secret is masked wherever it appears.

### The reference server says why it could not reach an upstream server

The reference server's `/api/proxy` forwards requests to another server, such as a certification API. When that server could not be reached at all, the proxy answered `502` with a bare "fetch failed" and logged nothing, so a network that blocks the call looked the same as a server that is down.

The `502` body now carries the reason, and the proxy logs it with the origin and path only, never the query string:

```json
{ "error": "unable to get local issuer certificate", "code": "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "kind": "tls" }
```

`kind` is one of `tls`, `dns`, `connect`, `timeout` or `other`, so a client can tell a corporate network that inspects HTTPS from a server that is down.

---

## Certification 0.11.2 – 2026-10-17

`reso-certification 0.11.2`

A schema finding inside an expanded record now names the field that failed.

### An expanded child's failure names the child's field, not the parent expansion

When a key inside an expanded record is not advertised, the validator checks it against the
child's own definition but files the finding under the parent's expansion field, carrying the
real location alongside it. The report summarizer read only the key it was filed under, so a
provider whose `Property` type declares `Media` correctly was told:

```
$expand Listings: 20/20 item(s) schema-invalid against Property
  – item 0: Fields MUST be advertised in the metadata (field: Media)
```

`Media` is advertised. The field that was not advertised sat one level down, on the `Media`
records themselves. The message pointed at correct metadata and omitted the only name that
would have resolved it, which is worse than saying less: a reader checks the named field, finds
it declared, and concludes the tool is wrong. It takes a reading of the error cache to discover
that the answer was recorded the whole time.

The same finding now reads:

```
  – item 0: Fields MUST be advertised in the metadata (field: Media.MimeType)
```

A finding with no nested location recorded renders exactly as before, so existing messages are
byte-identical and anything matching on the rule text still matches. The rule constants are
untouched.

---

## Certification 0.11.1 – 2026-10-16

`reso-certification 0.11.1` · `reso-metadata-utils 0.1.4`

A metadata report stops carrying the CSDL collection wrapper, an exempt enumeration stops
predicting a failure that cannot arrive, and both specifications default to their latest minor.

### A collection reports its element type, not the wrapper

A metadata report has always carried a collection's element type in `type`, with the
collection-ness in `isCollection`. The CSDL parser preserved the `Collection(<inner>)` wrapper,
which is correct for a parser and wrong once it reaches a report. Collection-ness ended up
encoded twice, and every consumer written against a bare `Edm.*` silently misread the wrapped
form: the JSON Schema generator fell through to `object` and typed the array's items as objects,
so every served string failed with "MUST be object but found string", and the maxLength and
integer-range facets were skipped because they test the bare type names.

Most fields escaped by accident, because the Lookup Resource merge rewrites `type` for anything
carrying a LookupName annotation. A vendor extension carries no such annotation and nothing
normalized it, so a single extension field typed `Collection(Edm.String)` produced 1,109,350 of
those errors against a payload that was a plain array of strings. Reports from the Java commander
carry the unwrapped form, which is why results certified under it were unaffected.

### An exempt enumeration no longer predicts a 2.1 failure

A value carved out by `schema-validation-settings.json` was reported as a warning reading "The
following enumerations in the `<Field>` Field were not advertised. This will fail in Data
Dictionary 2.1". The settings grant the identical exemption under both 2.0 and 2.1, so the
sentence was false wherever it appeared: on a 2.1 run it told a provider they would fail the
version they were being tested on. In one run it accounted for all 2,259,945 warnings, burying
the findings that did matter. An exempt value is now accepted outright and reports nothing.

### Both specifications default to their latest minor

The tooling targets the latest minor of each specification, which is Data Dictionary 2.1 and Web
API Core 2.1.0. Three defaults had drifted from that: the Data Dictionary default named 2.0 in two
places and the Web API Core default named 2.0.0, while the matching current-version constants
already named 2.1 and 2.1.0.

The cause was a supported-versions list that did not include 2.1. Everything derived from it, so
`isValidDataDictionaryVersion('2.1')` returned false and the legacy Data Dictionary runner
rejected a 2.1 run outright. Live runs were unaffected, because the current runner passes the
version explicitly rather than relying on a default. Each default now derives from its matching
current-version constant instead of restating a number, so a future version bump is one edit.

### Field selection can be overridden, and an override now decides the outcome

Core testing samples live data and picks, per type, the field most likely to produce a meaningful
query. A provider who knows their own data can name a field instead. That already existed, as
`--prefer-fields` and `coreOptions.preferFields`, but it only moved the named field to the front of
a ranked list. The runner walks that list and falls through when a field is not queryable, so a
named field the service would not filter on quietly handed the test to an automatic choice. The
report then read the same as an unsteered run.

It is now `--field-overrides` and `coreOptions.fieldOverrides`, and the named field is the field
that gets tested. Nothing automatic sits behind it, so a field the service will not filter on fails
its test. That is the point of naming it: if you steer, you own the outcome.

Three limits keep that from being a trap. An override still cannot invent a candidate, so naming a
field that is absent, of the wrong type, or holding one distinct value across the sample leaves that
selection automatic and is reported as unmatched; a typo costs that one override and nothing else.
An override is sparse, replacing selection for one data type on one resource, and for an enumeration
for one representation, so a provider serving `Collection(Edm.String)` and `Collection(Edm.EnumType)`
fields side by side keeps both certified by their own scenarios. And every override is recorded in
the report as `fieldOverrides`, carrying what was requested, what took effect, what matched nothing
and what was not well formed, because a run whose verdict was decided by a named field has to say so.

Each entry is `Resource.Field`. A bare field name is no longer accepted: an override is binding, and
a bare name applies to every resource carrying that field, so one entry could decide several
resources at once.

`--prefer-fields` and `coreOptions.preferFields` are removed. Both are still recognized and print an
explanation naming the replacement, and neither value is carried over, because applying the new
binding behavior to a list written for the old one would change what a run certifies.

### A schema validation failure says what failed, on every page

A replication that failed JSON Schema validation logged one line per page reading only "Schema
validation errors found in the <Resource> payload!" with no count, no field and no error class. A full
replication is thousands of pages, so a run whose first page had a problem produced thousands of
identical copies of a sentence that was impossible to ignore and told the operator nothing. One run
reached roughly 885,000 records that way.

Every page that has errors now prints one line carrying the running totals and the per-class
breakdown. The line is not printed less often: a page with errors that printed nothing would read as
a page that passed, and silence is not a safe default when the subject is a failure. A page with no
errors prints nothing, which is the one case where silence is correct, so total silence across a run
means nothing was found anywhere rather than nothing was reported.

```
Schema validation (Property): 17,715 errors, 3 types here (23,705 run total) · MUST be advertised in
the metadata 17,311 on 6 fields (Rooms, City, CountyOrParish, MlsStatus, StreetSuffix, +1 more) · …
```

Three properties of that line are deliberate. The lead number is **this resource's own** count, so it
reconciles against its own breakdown, and the cumulative figure is shown separately and labeled;
leading with the cumulative figure meant a resource with none of its own printed a five figure count
and no breakdown at all, which read as catastrophe on a clean resource. Error classes and their
fields are both ordered **largest first**, because a cap that hides by insertion order reliably hides
the field that matters: on a live run the largest contributor was collapsed into "+1 more" while a
field with a hundredth of its count kept a visible slot. And the whole state stays on one line, so a
long run is still greppable and a page count is still a line count.

A type mismatch also records **which value** failed, not only how many did. The value was computed to
build the message ("MUST be number or null but found string") and then discarded, so a report could
say "56 strings in CeilingHeight" and leave an operator unable to act, since an empty string, "8.5"
and "N/A" are three different conversations with a provider. Those values now appear on the field in
the errors report, bounded at 25 distinct values with a count of what was omitted, because a type
error can be on free text and its distinct set is unbounded.

Every number here was already in the accumulator at the time, so this reports what the run already
knew. The strict mode failure carries the totals in its message as well, since a caller that surfaces
only the message was reporting a failure with no magnitude.

### Smaller changes

- The OData client reports the version its package publishes. The constant said 0.2.3 while the
  package was 0.2.4, so the client identified itself as the previous version in its User-Agent.
- The standalone `metadata` command takes the Data Dictionary version as `-v, --version` instead
  of stamping one version into every report it produces.
- The certification documentation leads with Data Dictionary 2.1 and Web API Core 2.1.0. Earlier
  minors remain supported and are named as such rather than shown as the default.
- The Core run summary names the field overrides that took effect, so the record of what was tested
  survives in a continuous-integration log rather than only in a live terminal.

---

## Certification 0.11.0 – 2026-10-15

`reso-certification 0.11.0`

Strict mode becomes the default for Data Dictionary runs, and two corrections change which
providers pass.

### A run now enforces what it validates

A Data Dictionary run that did not pass `--strict` validated every payload and then enforced
nothing. The errors were written to the report and the run was reported as passed, so a provider
could hold a passing Data Dictionary result with thousands of schema validation errors recorded
beside it.

Two defaults had drifted apart inside the SDK. Enforcement defaulted to off while validation
defaulted to on, so the work was done and the result was not acted on. The legacy replication module
and the legacy command line had documented strict as the default throughout; only the newer path had
moved away from it.

Strict is now the default. `--no-strict` turns it off, and the run keeps going so that a single pass
collects everything a feed needs fixed. Validation is no longer tied to enforcement: previously an
explicit `strictMode: false` switched validation off altogether, which meant the one mode that
exists to produce a full error list produced none.

A run made with `--no-strict` is **not eligible for certification**, and says so. The reason travels
with the verdict, and `report.json` carries it as well, so a consumer reading only the summary file
cannot mistake the outcome for a certifiable result. That field is present only when a run is
ineligible, so a certifiable run's summary is unchanged.

A relaxed run also produces its full set of reports. Previously a run that found errors wrote the
error file and nothing else, with no warnings file and no availability analytics, so the run with
the most to report produced the least.

### A failed run no longer reads as a crash

Stopping on schema validation printed a stack trace with the entire validation result inspected
beneath it, twenty-five lines of it, for what is an expected outcome of a certification run. With
strict on by default that would have become what every provider with schema errors sees.

The replication step now reports the failure the way the variations step already did, by returning a
failed status rather than throwing, and the replicator's top-level handler follows the rule its own
inner handlers state: log only when swallowing, because a caller that receives the error reports it.
The failure line carries the counts and names the file holding the detail:

```
Failures (1):
  ✗ Replicate and validate: Schema validation errors found in the Property payload – 6,728 errors
    and 3,411 warnings recorded in data-availability-schema-validation-errors.json.
```

### A decimal without a stated scale is no longer typed as an integer

Any numeric field with no `Scale` facet was typed as an integer, including `Edm.Double`. Scale is a
`Edm.Decimal` facet and means nothing on a double, and both RESO specifications name `Edm.Double` as
a sanctioned way to express a decimal value, so this failed providers for declaring what the
specification permits. It was found on a live run against metadata carrying 71 `Edm.Double`
properties, every one of which was typed as an integer.

A field is now typed as an integer only when it is an `Edm.Decimal` whose scale is explicitly zero.
An omitted scale is no longer read as a statement about the value, which matches the Data Dictionary:
decimals may carry precision and scale attributes, and those attributes may also be omitted.

### Variations review

A mapping's strategy now travels through the suggestion sheet, so an exported review states whether
a mapping came from Fast Track or from the matcher rather than losing that on the way out. A review
exports to a sheet that can be filled in and submitted back, and the desktop client's sheet is read
back in the same shape.

### Smaller changes

- A Web API Core run can save what the server returned, not only what was asked for, which makes a
  failed assertion reproducible from the captured payload.
- Assertion text is written with an en dash, the dash RESO style allows.
- Stale test counts in the documentation were corrected.

---

## Documentation patch – 2026-10-14

`odata-expression-parser 0.1.1` · `reso-validation 0.1.1` · `reso-client 0.2.4` ·
`reso-reference-server 0.8.4` · `reso-certification 0.10.9`

Documentation only. No code changed in any of the five packages.

### Every package page on npm said the package was not on npm

Five README files carried the line "This package is not on npm yet. Install from the `reso-tools`
monorepo on GitHub," followed by a `git clone`. All five packages have been published for some time,
so the first thing a reader saw on the package page was an instruction not to install the package
they were looking at.

The same line was in four of the user guides, which is where a reader who follows the guide link
lands: `reso-certification`, `reso-client`, `reso-validation` and `odata-expression-parser`. The
first sweep covered README files only and missed them. The guides are not in any package's `files`
list, so they never shipped to npm; they reach the documentation site from `main`, and those
corrections go live on merge rather than on a publish.

The install sections now lead with `npm install @reso-standards/<package>` and keep the monorepo
build as the secondary path, matching the shape `reso-metadata-utils` already used. The
`reso-certification` page also documents `npx @reso-standards/reso-certification`, which resolves to
the `reso-cert` binary; that was verified against the published package rather than assumed.

Two statements that only made sense while the packages were unpublished are gone with it: the advice
to consume the SDK through `npm link` or a `file:` dependency.

### The certification docs no longer position the toolkit against Java

"No Java required", "does not depend on running a Java toolchain" and "with no Java toolchain" are
out of the `reso-certification` guide and README. The toolkit is described by what it is, pure
TypeScript on Node.js 22+, rather than by what it is not. `MIGRATION.md` still names the Java tools,
because migrating off them is its subject.

`reso-mcp-server` keeps its own wording. It is `private: true` and deliberately unpublished, so
"not published to npm" is correct there.

### It also repairs the provenance link

npm showed a "commit not found" warning against `reso-certification 0.10.8`, because the commit its
provenance attestation names was squashed away when v1.0.0 was cut. Provenance records the commit of
the publishing run, so publishing from the new `main` replaces the dangling reference. Nothing had to
be done for this beyond republishing.

---

## v1.0.0 – "Luna" – 2026-10-13

The first stable release. RESO Tools splits into a **public, npm-published core** and a private application tier, so any project can consume the RESO libraries and the certification runner without the monorepo.

> Everything below shipped in v1.0.0. The package versions listed under "Package
> releases rolled into v1.0.0" were published during its development, so they are part of
> this release rather than successors to it.


Two changes in it alter behavior for everyone, and both are about which environment a run talks
to.

### The desktop client authenticates against production

The login default was `certqa.reso.org`. Because the certification environment also selects which
variations store a run reads, every released client put its users on QA's store. The default is now
`certification.reso.org`.

Flipping the default alone would not have been enough. Four places named the QA host independently
and three of them would have become false: the login modal, the login page and the live-data badge
each printed `certqa.reso.org` as literal text, so a production build would have told a user it was
connecting to QA while authenticating against production. All three now derive the host from the
configured origin.

The fourth was not cosmetic. Cloud submission defaulted its target to QA, so a production build
would have logged a user into production and then offered to submit their results to QA. It now
follows the configured environment. QA remains available as an explicit choice in that dropdown, and
local development still runs against QA – `npm run dev` targets QA and `npm run dev -- --env prod`
targets production.

### Windows builds are signed

Windows installers were unsigned. electron-builder skips code signing and still exits 0 when it
cannot find an identity, so the builds looked green. They are now Authenticode signed through Azure
Trusted Signing, and CI fails the release unless every shipped executable carries a valid signature
with the expected publisher **and a timestamp**. The timestamp is not a formality: the signing
profile issues three-day certificates and rotates them daily, so an untimestamped installer would
stop validating within 72 hours of being built.

macOS builds remain Developer ID signed, notarized and stapled.

### Downloads resolve without a version in the URL

Release assets no longer carry the version in their filename, so the README's per-platform links
always point at the newest build. Rollbacks and specific builds come from the releases list.

### Documentation

The per-package test counts in the root README summed to 1,963 against a badge claiming 2,785. Every
count is now taken from the run that produced the badge. Four package READMEs carried stale counts
as well, the largest understating `reso-certification` by 648 tests.

---

### Public/private split + npm publishing

- **Seven public packages now publish to npm** via per-package Trusted-Publishing (OIDC) CI: `reso-common`, `reso-metadata-utils`, `reso-client`, `odata-expression-parser`, `reso-validation`, `reso-certification`, and `reso-reference-server`. Consumers install them from the registry with `^` version ranges – no monorepo required.
- **The application tier moved to `reso-tools-private`:** the browser UI, the Electron desktop client, the CORS proxy, and the test-data generator. The public reference server switches to committed static seeds; the desktop app is built in `reso-tools-private` and published here as a downloadable release.
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

### Package releases rolled into v1.0.0

Published while v1.0.0 was in development, newest first.

### reso-common 0.4.1 · reso-certification 0.10.8 – 2026-10-06

**The `reso-cert` CLI has not been runnable from npm since 0.10.2.** Five consecutive releases
shipped it non-executable. This release fixes that, and it is the reason to upgrade.

Publish `reso-common` first. `reso-certification` calls `parseReplicationProgress` and
`summarizeReplicationProgress` at runtime, and those arrive in 0.4.1. The manifest requires
`^0.4.1` rather than `^0.4.0`, because a range is the only place that constraint can be stated.
Publishing bottom-up would have hidden it – `^0.4.0` resolves to 0.4.1 once it exists – while anyone
with a lockfile pinning 0.4.0 would get a package whose progress renderer calls two functions that
are not there.

These publish as stable versions, as part of v1.0.0 rather than a beta.15 round. An earlier draft
of this entry planned `-beta.1` prereleases so that the version string itself would disclose that
the vendor replay for this engine delta had not yet run. That is no longer how it is disclosed:
consumers on a caret range pick `0.10.8` up on their next install, so **the replay has to run
before the release rather than be signalled by the version**.

#### A skipped scenario was reported as passed

A scenario that could not run was recorded with `passed: true`, so a report could not distinguish a
check that succeeded from one that never executed. Skipped scenarios now carry `passed: false` and a
`skipReason` naming why, and both tallies guard on the skipped flag.

This is the most important line in the release. A report produced before this change may show a pass
for a check that did not run.

#### A run could pass having verified nothing

`deriveStatus` ignored `skipped` entirely, so a Data Dictionary run whose reference metadata failed
to load reported an outcome of `passed` having validated no metadata at all. `getReferenceMetadata`
returns null rather than throwing when its JSON cannot be read, which makes the validation step
return skipped, and nothing downstream objected.

Every endorsement now states its own rule as `validForCertification`, a required positional
parameter of `createPipeline`. Required rather than optional, because an optional rule would have to
mean something when absent, and the only available meanings are certifiable by omission or refusing
every run of a correctly written endorsement.

#### report.json states its own verdict

`report.json` carried five keys and no verdict field, so the run's outcome existed only inside the
English remarks sentence and a consumer had to pattern-match prose to learn whether a run passed.
That is how the outcome defect above went unnoticed in this file: `report-detailed.json` at least
carried a contradictory steps array that a careful reader could catch it on, while `report.json`
offered nothing to catch it with.

#### The bearer token reached stdout

`--output json` was a bare serialization of the pipeline result. The result carries the accumulated
context, the context carries the bearer token every step uses after authentication resolves, so the
live credential went to standard output – in the output the guide recommends archiving. Measured
with a sentinel, it came back at `context.authToken`.

Two layers now cover it, because each catches what the other cannot. The credential is dropped from
the serialized context, which removes the path we knew about. And a value-keyed mask catches it
wherever else it surfaces, because a denylist of field names only ever protects the fields someone
remembered, and this leak happened precisely because nobody enumerated what the context held.

#### Two silent wrong answers in the Lookup replication walk

A 200 response whose `value` is present but is not an array was read as an empty page, which ended
the walk and reported that the resource exists and has no rows. That is now refused. An absent or
null `value` is still treated as an empty page, deliberately, so this cannot newly fail a provider
that answers an empty collection that way.

And a server that ignores `$skip` serves the same rows at every cursor position. Those pages are
never empty, so the walk's only termination condition never fired. The walk now stops when the
cursor does not move.

#### The executable bit

`tsc` emits a **newly created** file in `dist/` as 0644, and leaves the mode alone when it overwrites
an existing one. `prepublishOnly` runs the build and `npm pack` preserves whatever mode is on disk,
so every tarball from 0.10.2 onward carried `package/dist/cli/index.js` as `-rw-r--r--`.

Two corrections to how this was first described, both measured rather than assumed. **npm does
restore the bit on install** – its `bin-links` step chmods the bin target – so a consumer installing
from the registry was not affected. Verified by packing a tarball with the bit deliberately cleared,
installing it, and finding the installed target at `-rwxr-xr-x`.

Where it bit was **local development**. Nothing chmods anything after a bare `npm run build`, and the
workspace bin link then points at a file that is no longer executable, so `./dist/cli/index.js` and
`npx reso-cert` both answer `Permission denied` inside the repository. Verified by removing the chmod
from the build, deleting `dist/`, and rebuilding: the fresh file comes out `-rw-r--r--` and both
invocations fail. That the mode survives an overwrite is also why this went unnoticed for five
releases – once any developer's copy had the bit, their rebuilds kept it.

It misdirected as well as failed. `npx` treats a non-executable local bin as unusable and falls
through to the registry copy, which had the same defect, so the error named a path inside the npx
cache and pointed away from both the cause and the local build the user meant to run.

The build now sets the bit, and a test in each package asserts it by reading the path out of the
`bin` field, so renaming an entry point cannot leave the test passing against a file nobody ships.

#### Plain http on loopback

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

#### Packaging

Two tarballs carried files nobody needs. `reso-certification` shipped seven test fixtures inside
`dist/etl/test`, swept in because the build copies `src/etl` wholesale. `reso-mcp-server` declared no
`files` field, the only package that did not, so its tarball carried its own source, its four test
files and its `tsconfig.json`.

#### Refreshed Data Dictionary reference metadata

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

### reso-common 0.4.0 – shared lock identifiers for certification variations – 2026-09-29

Additive. Two builders and a stem constant, no behavior change to anything existing.

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

### reso-reference-server 0.8.2 – exported metadata utilities for embedding hosts – 2026-09-28

A published-package patch – no monorepo release. Additive: four symbols exported from the package root, no behavior change.

`createApp` returns `{ app, dal, cleanup }`, so a host embedding the server can already mount its own routes on the Express app before listening. But anything it mounts needs the same metadata and data access the built-in routes use, and the package's `exports` map is `.` only, which blocks deep imports into `dist/`. So an embedding host could reach the `dal` and then do nothing useful with it.

Now exported from the root:

- `TARGET_RESOURCES` and `reconcileLookups`
- the `DataAccessLayer` and `ResourceContext` types

The other metadata helpers a caller is likely to want – `getFieldsForResource`, `getKeyFieldForResource`, `getLookupsForType`, `isEnumType` – are already public from `@reso-standards/reso-common`, as are the `ResoMetadata`, `ResoField` and `ResoLookup` types. So this closes the gap rather than opening a new surface.

Prompted by the desktop client, which mounts a data generator of its own and had been reaching the server's internals through a patched build rather than a supported entry point.

---

### reso-certification 0.10.7 + reso-reference-server 0.8.1 – 2026-09-28

A published-package patch to two packages – no monorepo release. Both already declared `@reso-standards/reso-common ^0.3.0` in source, but neither had been republished since, so the versions on npm still carried `^0.2.0`. Every consumer therefore resolved reso-common to 0.2.x and nothing could reach 0.3.0, however recently it had been installed.

#### What that cost

- **Pre-rollback DD 2.1.** reso-common 0.2.1 ships the DD 2.1 reference metadata from before the 2026-09-18 sheet rollback – 44 resources and 2,167 fields, still carrying the `Model` resource. 0.3.0 ships the corrected 43 / 2,140.
- **No element level.** The variations record model landed in reso-common 0.3.0. Consumers pinned to 0.2.x have no element-level surface, so code written to read the level falls back to inferring it – which is how expansions came to be reported as fields with no suggestion.

#### The change

Version numbers only. Both dependency ranges were already correct; npm simply rejects a republish at an unchanged version, so `reso-certification` goes 0.10.6 → 0.10.7 and `reso-reference-server` 0.8.0 → 0.8.1. Consumers on `^0.10.0` and `^0.8.0` pick these up automatically, and reso-common then resolves to 0.3.0.

No behavior change in either package beyond what the newer reso-common brings.

---

### Web API Core 2.1.0 – `$expand` data-validation + version normalization (desktop v1.0.0-beta.12) – 2026-09-11

A coordinated patch across `reso-metadata-utils` (0.1.1 → 0.1.2) and `reso-certification` (0.10.5 → 0.10.6), shipped in desktop **v1.0.0-beta.12**. Consumers on `^0.1.0` / `^0.10.0` pick these up automatically. Three separate bugs let Web API Core 2.1.0 `$expand` per-item schema validation silently skip in real (desktop / config-mode) runs; this closes all three and tightens the `$expand` gate.

#### `reso-metadata-utils` 0.1.2 – declared EntityTypes in the metadata report

- **Contained / expansion-only types are no longer dropped.** `getAllFields` keyed the report off the entity container's EntitySets, so a declared EntityType with no EntitySet – an OData containment-navigation target (`ContainsTarget="true"`, e.g. a contained `Media` collection) – was omitted. Downstream JSON-Schema generation then emitted a `$ref` to a definition that was never built, ajv failed to compile, and the whole `$expand` validator degraded to a 200-only gate, so schema-invalid expanded data went uncaught (a false-pass). Every declared EntityType is now emitted, keyed by type name so a `Collection(Ns.Type)` reference always resolves; deduped against the served entry keys so a contained type can never clobber a served resource. No-op for conformant RESO metadata (EntitySet name == type name).

#### `reso-certification` 0.10.6 – `$expand` gating + Core version normalization

- **Config-mode version normalization.** Config sources supply the Core version as `"2.1"` (two-part) while the gates compared against the literal `"2.1.0"`; a bare cast let `"2.1"` through, so the `$expand` schema-validator gate read false in config-file mode – the data-validation half never ran on desktop / config-mode runs (a false-pass). Versions are normalized once at the SDK boundary (`coerceCoreVersion`), and an unknown/newer version clamps **up** to the current minor rather than down to the oldest baseline.
- **The `$expand` gate enforces the data.** A present expansion must be a Collection of the target EntityType (a JSON array of entity objects; a malformed 200 envelope fails). Non-2xx (403/501) skips – expansion is optional, and not-accessible ≠ non-conformant. A collection navigation-property-path returning 204 fails: a collection returns 200 with an empty result set, never 204 (OData §11.2.7 / web-api-core §2.5.10.2, §2.6.1).
- **`$expand` and the navigation-property-path form must be data-consistent (OData §11.2.7).** Both resolve the same relationship on the same entity, so they must agree on whether related entities exist; a records↔empty disagreement is a determinate fail. Both legs treat an empty page + `@odata.nextLink` as has-records, so server-driven paging never false-fails.
- **`$select` may return additional fields** (OData 4.01 §11.2.5.1 – a service may return more than requested): the prior extra-field warning is dropped.

**Tests:** Full monorepo suite now 2,181 passing across 8 packages.

---

### reso-certification 0.10.5 – 2026-09-02

A published-package patch to `reso-certification` – no monorepo release. Consumers on `^0.10.0` pick it up automatically; behavior-preserving for the CLI and cert-backend (no test-count change), and no other package changed.

#### `reso-certification` 0.10.5 – bundle-static legacy-schema + DD-reference loads (reso-tools-private #102)

- **Desktop cert-worker fix.** The legacy JSON-schema module and the DD reference JSON were loaded via a computed `createRequire` path and a template-literal `require()`, which esbuild could not statically follow – so in the packaged desktop app they did not load, and Web API Core 2.1.0 `$expand` per-item schema validation silently degraded to "unavailable" (the nav gated on the HTTP 200 alone). Both loads are now bundle-static: a lazy dynamic `import()` with a literal specifier for the legacy module, and a per-version `switch` for the DD reference JSON, so esbuild inlines them into the cert-worker bundle.
- **Behavior-preserving** for the CLI and cert-backend (they run from `dist`, where the old paths resolved); full cert suite green (1,064 passed / 2 expected-fail). The desktop bundle now inlines the legacy schema and all three DD JSONs, verified by a new runtime load smoke in the bundler (reso-tools-private).
- Unsupported-version metadata lookups now **fail loud** (log) instead of silently returning empty.

---

### reso-certification 0.10.4 – 2026-09-02

A published-package patch to `reso-certification` – no monorepo release. Consumers on `^0.10.0` pick it up automatically; no other package changed (`reso-client` stays 0.2.2, `reso-common` 0.2.1).

#### `reso-certification` 0.10.4 – Web API Core 2.1.0 Lookup Resource certification

- **Exhaustive `/Lookup` fetch by `LookupName`.** The served Lookup Resource is paged all the way through for each queried `LookupName` (`@odata.nextLink` followed with no page cap), so value presence reflects the provider's entire catalog rather than the first page – there is no server-side value filter on `/Lookup` yet. A per-run cache keyed by `LookupName` dedupes the fetch across fields that share an enumeration.
- **Value presence across all three wire forms.** A served value is matched against the union of `LookupValue`, `StandardLookupValue`, and `LegacyODataValue`, so a provider serving any legal form of a cataloged value is not false-failed.
- **Gating StandardLookupValue validity.** Each declared `StandardLookupValue` is validated against the Data Dictionary standard set for the field's DD type – never the provider's arbitrary `LookupName` – with an any-DD-enum fallback for open enumerations that carry no standard set. A non-standard declared value fails Core.
- **Both gates honor `ignoreEnumerations`.** The committee-approved `schema-validation-settings.json` exemption (keyed by DD major.minor version) is threaded into both the presence and validity checks, so an exempt open or local field is never false-failed.
- **Tests:** new coverage for exhaustive paging, the tri-form presence union, the field-type DD-standard join, and the ignore-list exemption. Full monorepo suite now 1,963 passing across 8 packages.

---

### reso-certification 0.10.3 – 2026-09-01

A published-package patch to `reso-certification` – no monorepo release. Consumers on `^0.10.0` pick it up automatically; no other package changed (`reso-client` stays 0.2.2, `reso-common` 0.2.1).

#### `reso-certification` 0.10.3 – Web API Core 2.1.0 `$expand` + served-resource gating

- **Declared-but-not-served carve-out for top-level resources.** A required 2.1.0 resource (Property, Member, Office plus Field, Lookup) that is declared in the metadata but absent from the service document now resolves to Not Applicable under the 2.1.0 carve-out instead of hard-failing as in 2.0.0. Backed by a new service-document parser and a run/fail/na serving decision, masking only on positive determinate agreement across both authoritative surfaces.
- **`$expand` per-item schema-validation gate.** Each expanded child item is validated against its target entity type in DD/Core mode (strict: unadvertised field, wrong type, over-length value, and null collection all fail), and a declared collection navigation is gated on that validation – a schema-invalid expanded item fails Core. New `expand-schema` SDK module; the validator degrades conservatively (gates on the 200 alone) if it cannot be built.
- **Non-gating related-record-key warning.** When an expanded item's `ResourceRecordKey` does not match the parent key, the run emits a non-gating warning – instrumenting the pain point per the cert-warnings convention rather than gating on it.
- **CLI:** shared option builders (auth, server URL, output, report directory) centralized in `shared-options.ts` – an internal refactor standardizing universal flags across commands, no behavior change.
- **Tests:** 8 new or expanded test files covering serving decisions, `$expand` gating, the RRK warning, and `$expand` sampling. Full monorepo suite now 1,944 passing across 8 packages.

---

### reso-client 0.2.2 · reso-certification 0.10.2 – 2026-08-30

A targeted post-Luna patch to two published packages – no monorepo release. Consumers on `^` ranges pick these up automatically (`reso-certification` resolves the new `reso-client` through its `^0.2.0` range).

#### `reso-client` 0.2.2 – resilient HTTP client (#273)

- **Retry with capped backoff** on transient `429` / `503` responses, so a certification run survives provider rate-limiting instead of failing on the first throttle. A shared `createResilienceSession` wraps the client with this behavior.
- **Graceful deadline stop:** when a run's time budget is spent, remaining checks report NOT TESTED (the run is `incomplete`) rather than failing. `isDeadlineError` lets callers propagate the stop cleanly without discarding already-collected results.

#### `reso-certification` 0.10.2 – `reso-cert rcf` + hardening

- **New `reso-cert rcf` command** – RESO Common Format certification. It infers a DD-2.0 metadata report from RCF payload data, then runs DD schema validation and variations against the inferred report.
- **Inference correctness:** detect payload-local collection enums, keep leading-zero codes (`01`, `007`) as string values rather than numbers, and reject impossible calendar datetimes (`2023-02-30T…`) instead of mis-typing them as `Edm.DateTimeOffset`.
- **Recover mis-named expansions by shape,** including depth-≥2 nested renames (kind matching).
- **Canonical RESO Data Availability Report** shape from the `rcf` command, and a fail-closed non-zero exit on a zero-record submission so an empty or unreadable payload never reads as a clean pass.
- Adopts the `reso-client` resilience layer for graceful deadline handling.

---

---

Releases before v1.0.0 are not listed here. The full history is retained in RESO's internal
archive. Most earlier versions also carry a git tag in this repository, though not all of them do:
tagging began at v0.2, and v0.1, v0.3, v0.11 and the v0.0.x series were never tagged.
