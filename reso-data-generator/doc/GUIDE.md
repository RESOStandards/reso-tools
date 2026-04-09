# RESO Data Generator – User Guide

A task-oriented walkthrough of the RESO Data Generator. This is the package that fills a real RESO-compliant server with realistic test data on demand, with the foreign keys wired correctly, the lookups respected, and the relationships between resources resolved automatically.

If you have ever stood up a RESO server, looked at an empty `Property` resource, and wondered what to put in it without writing a thousand lines of seed data by hand, this is the tool that ends that pattern.

## Audience

Developers and test engineers who need real data inside a RESO-shaped server but do not have a production feed to point at. Real examples:

* **Building against a RESO server locally** and needing data to query before any real records exist
* **Reproducing a customer issue** and needing a clean dataset shaped exactly like the production schema
* **CI pipelines** that spin up a RESO server, seed it, run tests against it, and tear it down
* **Demos and walkthroughs** where the audience needs to see real-looking listings, agents, offices and media records on screen
* **Cert tooling** that needs synthetic data to exercise the full surface of a server's read and write paths
* **AI agents and integration tests** that need realistic but disposable records to operate against

The generator runs as a CLI, as a programmatic SDK, and through the **[RESO Desktop Client](../reso-desktop-client/)**'s admin panel. Same engine, three surfaces.

## Install

```bash
npm install @reso-standards/reso-data-generator
```

Node.js 22 or later. The CLI is the most common entry point; the SDK is for embedding the generator inside another tool.

---

## What the Generator Does

The generator's job is the *opposite* of validation. Validation says "is this record well-formed for the schema?" Generation says "give me records that are already well-formed for the schema." The interesting part is that "well-formed" means more than "fields match types" – it means the foreign keys point at real records that exist, the lookups carry valid values, the related child records are linked correctly, and the whole graph reads like a plausible MLS feed.

Three things make that work:

1. **Per-resource generators** that know the shape of each RESO resource and produce values that look like the real thing. `Property` records get plausible addresses, prices in plausible ranges, bedroom and bathroom counts that match each other, geocoordinates that fall on land. `Member` records get names that pair with email addresses that match. `Office` records get brokerage names and contact info that read like real businesses. The values are synthetic but they look like data, not like `foo / bar / baz`.
2. **Automatic foreign-key resolution** so when you ask for 50 Properties, the generator notices that `Property` references `Member` (as `ListAgent`) and `Office` (as `ListOffice`), creates the right number of upstream records first, and then creates the Properties with valid `ListAgentKey` and `ListOfficeKey` values pointing at them. You never have to think about ordering.
3. **A topologically sorted dependency graph** that handles arbitrary chains of references – including the well-known **Office ↔ Member circular dependency** (an Office has a `BrokerKey` pointing at a Member, but a Member has an `OfficeKey` pointing at an Office). The generator creates Office first without the broker links, then Member with valid Office references, then PATCHes the Office records with broker keys pointing at real Members. The circular dependency is resolved invisibly; you just ask for Properties.

The result: one command, a fully wired-up server.

---

## Generating Data Through the CLI

The CLI is the most common entry point. Two modes: interactive (it asks you questions) and non-interactive (you pass everything as flags). Non-interactive is the right choice for scripts and CI; interactive is the right choice when you are exploring.

### The Simplest Possible Run

```bash
npx reso-data-generator -u http://localhost:8080 -r Property -n 50 -t admin-token
```

This asks for **50 Property records** against a server at `localhost:8080`, with the bearer token `admin-token`. With nothing else specified, the generator:

* Fetches the server's metadata to learn the schema
* Discovers that `Property` has foreign-key references to `Member` (as `ListAgent`), `Office` (as `ListOffice`), `OUID`, and `Teams`
* Computes how many of each upstream record it needs (defaults: 1 Office per 5 Properties, 1 Member per 2 Properties, etc.)
* Builds a dependency graph and sorts it topologically
* Creates the upstream records first via POST
* Creates the 50 Properties with valid foreign keys pointing at the records it just made
* Resolves the Office ↔ Member circular dependency by PATCHing Office records after Members exist

You go from "empty server" to "50 listings, agents, offices, all wired correctly" in one command.

### Generating Related Records Too

`Property` is the parent for several child collection resources – `Media` (listing photos), `OpenHouse` (open house events), `Showing` (showing appointments), `PropertyRooms` (room-by-room details). These are not foreign-key dependencies; they are *children* that hang off the parent and reference it via the RESO `ResourceName` + `ResourceRecordKey` convention.

To generate them alongside the Properties, use `--related`:

```bash
npx reso-data-generator -u http://localhost:8080 -r Property -n 50 \
  --related Media:5,OpenHouse:2,PropertyRooms:8 -t admin-token
```

This produces:

* 50 Properties (each with valid Member and Office references)
* 250 Media records (5 per Property, linked back via `ResourceName=Property` and `ResourceRecordKey=<listingKey>`)
* 100 OpenHouse records (2 per Property, linked via `ListingKey`)
* 400 PropertyRooms records (8 per Property)
* Whatever Members, Offices and other upstream records the dependency graph needs

The `--related` flag takes a comma-separated list of `Resource:count` pairs. The count is per *parent* record, so `Media:5` means "5 Media records for every Property generated."

### Choosing the Output Mode

The generator supports three output modes for the same generation logic. Pick the one that fits how the data is going to be used.

**HTTP (default)** – POST records directly to the server's Add/Edit API. This is what you want when you have a running server and you want the data to land in it immediately.

```bash
npx reso-data-generator -u http://localhost:8080 -r Property -n 50 -t admin-token
```

**JSON** – write each record to its own file under a directory. This is what you want when you need disposable test data for a unit test, or when you want to commit a deterministic seed corpus to a repo.

```bash
npx reso-data-generator -r Property -n 50 -f json -o ./seed-data
```

The output directory gets one subdirectory per resource (`./seed-data/Property/`, `./seed-data/Member/`, `./seed-data/Office/`, etc.) with one numbered JSON file per record (`0001.json`, `0002.json`, ...). The dependency graph is resolved before the files are written, so foreign keys in the Property files point at the keys in the Member and Office files.

**curl** – generate a `seed.sh` bash script with curl commands. This is what you want when you need to seed a server from a Dockerfile or a CI step that does not have Node.js installed.

```bash
npx reso-data-generator -r Property -n 50 -f curl -o ./seed.sh -t admin-token
```

The generated script includes a health-check loop at the top so it waits for the server to be ready, then runs the POST commands in dependency order, then runs the PATCH commands for the Office ↔ Member back-fill.

### Skipping Dependency Resolution

If you only want to generate one resource and you do not care that its foreign keys point at nothing, pass `--no-deps`:

```bash
npx reso-data-generator -r Property -n 10 --no-deps -f json -o ./seed-data
```

Useful when you are testing how a server handles records with broken foreign keys, or when you only need the *shape* of the data and not a coherent graph.

### Overriding Dependency Counts

The defaults work for most cases, but if you need more or fewer upstream records than the heuristics produce, override them with `--dep-counts`:

```bash
npx reso-data-generator -u http://localhost:8080 -r Property -n 50 \
  --dep-counts Office:20,Member:100 -t admin-token
```

This forces 20 Office records and 100 Member records, regardless of what the heuristic would have computed. The 50 Properties still get valid foreign keys; they just have a wider pool of agents and brokerages to draw from.

### Interactive Mode

If you would rather walk through the options as questions instead of remembering flags, run the generator with no arguments:

```bash
npx reso-data-generator
```

It prompts for the output format, server URL, auth token, resource name, record count, dependency resolution toggle and related-record configuration. Useful for one-off exploration.

---

## Using the Generator from Code

The CLI is a thin wrapper around an SDK that you can call directly from your own application. The SDK is the right entry point when you are embedding the generator inside another tool – a test harness, a CI orchestrator, an admin UI, an MCP tool that wants to seed data on behalf of an agent.

### Generating With Dependencies

```typescript
import { generateWithDependencies } from '@reso-standards/reso-data-generator';

const result = await generateWithDependencies(
  {
    resource: 'Property',
    count: 50,
    related: { Media: 5, OpenHouse: 2, PropertyRooms: 8 },
    serverUrl: 'http://localhost:8080',
    authToken: 'admin-token'
  },
  { format: 'http' },
  metadata,
  (progress) => {
    console.log(`${progress.resource}: ${progress.created}/${progress.total}`);
  }
);

console.log(`Created ${result.totalRecords} records across ${result.resources.length} resources`);
```

The third argument is the metadata the generator uses to discover foreign-key relationships. You can fetch it via the **[RESO Client SDK](../reso-client/)**'s metadata loader, or pass a `MetadataReport` you have already loaded from somewhere else.

The fourth argument is an optional progress callback that fires once per record. Useful for showing a progress bar in a UI or for streaming logs to a CI runner.

### Generating a Single Resource

If you want to generate one resource and skip the dependency graph entirely (because you have already seeded the upstream records yourself, or because you are testing how the server handles missing references), use `generateSeedData` directly:

```typescript
import { generateSeedData } from '@reso-standards/reso-data-generator';

const result = await generateSeedData(
  {
    resource: 'Property',
    count: 10,
    serverUrl: 'http://localhost:8080',
    authToken: 'admin-token'
  },
  { format: 'http' },
  (progress) => {
    console.log(`Created ${progress.created} of ${progress.total}`);
  }
);
```

Same shape, fewer arguments, no dependency resolution.

### Inspecting What Will Be Generated

If you want to see the dependency graph before the generator runs, use `buildSeedPlan`:

```typescript
import { buildSeedPlan } from '@reso-standards/reso-data-generator';

const plan = buildSeedPlan({
  resource: 'Property',
  count: 50,
  related: { Media: 5, OpenHouse: 2 }
}, metadata);

for (const phase of plan.phases) {
  console.log(`Phase ${phase.order}: ${phase.resource} (${phase.count} records)`);
}
```

The plan is a dry run – it tells you which resources will be created, in which order, with how many of each. Useful for sanity-checking a generation run before it touches a server.

### Using a Specific Generator

Each resource has a domain-specific generator that produces the realistic per-resource values. If you want to call one directly – for example, to produce a single Property record without writing it to a server – use `getGenerator`:

```typescript
import { getGenerator } from '@reso-standards/reso-data-generator';

const propertyGenerator = getGenerator('Property');
const property = propertyGenerator.generate({ fields, lookups, foreignKeys: {} });

console.log(property.City, property.ListPrice);
```

The result is a fully populated record object, ready to be inspected or POSTed by hand.

---

## Per-Resource Realism

The generator does not just produce values that pass type checks. It produces values that *read* like real data. A short tour:

* **Property** – realistic addresses across U.S. cities, listing prices distributed in plausible ranges by region, structure values (bedrooms, bathrooms, living area, lot size) that are internally consistent, geocoordinates that fall on land, listing dates and status combinations that make sense, public remarks that read like an agent wrote them, tax data based on state-specific assessment patterns
* **Member** – first and last names from a realistic distribution, email addresses constructed from the names (`firstname.lastname@brokerage.com`), phone numbers in valid U.S. formats, designations drawn from real industry credentials (CRS, ABR, GRI, e-PRO), NAR member IDs in the right shape
* **Office** – brokerage office records with names that read like real brokerages, addresses that match their declared cities, contact information consistent with the address
* **Media** – image records with placeholder URLs, descriptions, and ordering, linked back to the parent resource via the RESO `ResourceName` + `ResourceRecordKey` convention so they show up in the right `Property` when expanded
* **OpenHouse** – open house events with future-dated start times, durations that look like real open houses, linked to a parent property via `ListingKey`
* **Showing** – showing appointments with realistic time slots, agent and contact references, linked to the parent property
* **PropertyRooms, PropertyGreenVerification, PropertyPowerProduction, PropertyUnitTypes** – child collection records linked to the parent property via `ListingKey`, generated with a generic child generator that respects the field metadata

For resources without a domain-specific generator, the library falls back to a generic field generator that handles every Edm type (`Edm.String`, `Edm.Boolean`, `Edm.Int16`, `Edm.Int32`, `Edm.Int64`, `Edm.Decimal`, `Edm.Date`, `Edm.DateTimeOffset`, `Edm.TimeOfDay`, `Edm.Guid`) plus enum and collection lookups drawn from the server's metadata.

---

## A Note on the Data

The data the generator produces is **synthetic and DD-driven**. It is not sampled from any real listing feed, it is not derived from any production database, and it is not generated by a model trained on real listings. The values come from per-resource generators that understand the shape of each RESO resource and produce values that fit – nothing more.

This matters in a few practical ways:

* **License-clean by construction** – there is no upstream feed to license, no MLS contract to negotiate, no usage restriction inherited from a data vendor
* **Safe to commit** – the generated records can live in a repo, in a Docker image, in a CI fixture set, in any place a license-encumbered feed could not
* **Safe to share** – generated records can be sent to vendors, partners, and AI agents for testing without any chain-of-custody concerns
* **Safe for AI training and inference** – none of the generated data has any provenance link to a real listing, so any tool that processes it cannot leak real-world information through the synthetic set

The current generator produces realistic data **shaped by the RESO Data Dictionary itself plus the per-resource heuristics described above**. A more advanced generator that produces test data shaped to any specific server's metadata report (including local fields) is in flight – see the **[RESO Reference Server guide](../reso-reference-server/)** for the broader story on how the generator pairs with the reference server, and **[reso-tools#106](https://github.com/RESOStandards/reso-tools/issues/106)** for the work to make the generator strictly respect any target server's declared field set.

---

## Where to Next

* **Standing up a server to generate against** – the **[RESO Reference Server](../reso-reference-server/)** is the natural target. Spin it up locally with Docker or SQLite, point the generator at it, and you have a fully populated RESO server in seconds.
* **Validating the generated records** – the **[reso-validation](../reso-validation/)** library checks records against field metadata and resource business rules. The reference server runs it on every generated record automatically; you can also call it directly from your tests.
* **Querying what you generated** – the **[RESO Client SDK](../reso-client/)** is the right entry point for fetching, filtering, and paging the data after the generator has populated it.
* **Browsing it in a UI** – the **[RESO Desktop Client](../reso-desktop-client/)** can connect to any RESO server, including one you just seeded, and exposes the data through a metadata-aware browser.
* **Running compliance against it** – the **[RESO Certification](../reso-certification/)** test runners exercise the cert flows against any RESO server, so the loop "seed → query → cert" is one continuous workflow against the same data.

## Reference

* **[Package README](../)** – full CLI flag table, output mode details, and SDK type reference
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/reso-data-generator)**
* **[npm Package](https://www.npmjs.com/package/@reso-standards/reso-data-generator)**
* **[reso-tools#106](https://github.com/RESOStandards/reso-tools/issues/106)** – the work to make the generator strictly respect any target server's declared field set
