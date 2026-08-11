# RESO MCP Server – User Guide

A walkthrough of using the RESO MCP server through an AI assistant. Each section is a real conversation: the user asks a question, the assistant calls the appropriate MCP tool, and the answer comes back grounded in live data from the **[reso-reference-server](../../reso-reference-server/)** seeded with the bundled fixtures.

The format is intentional – this is what working with a RESO OData server *should* feel like once you have an MCP-aware assistant in the loop. The boxed JSON tool calls are collapsed by default so the dialogue stays readable; click them open when you want to see the exact arguments.

> **A note on tone.** The dialogues below are real captures from working sessions, and the conversational voice in the assistant's replies is deliberate. Do not normalize them to a more formal register – the whole point of the guide is to show what working with the MCP server actually feels like, not to read as polished marketing copy. Style-guide rules (Title Case headings, spaced en-dashes, no contractions) apply to the narration prose around the dialogue blocks; everything inside a blockquoted dialogue stays exactly as it was captured.

## How It Works

AI agents never touch provider APIs directly. The MCP server sits between the AI and the data – the agent forms queries and interprets results, while RESO's certified OData client handles all API communication and authentication.

<div align="center">
  <a href="https://raw.githubusercontent.com/RESOStandards/reso-tools/main/reso-mcp-server/doc/reso-mcp-architecture.svg" target="_blank">
    <img src="https://raw.githubusercontent.com/RESOStandards/reso-tools/main/reso-mcp-server/doc/reso-mcp-architecture.svg" alt="RESO MCP Server Architecture – AI agents use RESO-certified tooling, never touching provider APIs directly" style="max-width: 720px; width: 100%;" />
  </a>
  <br/>
  <sub>Click to expand full size</sub>
</div>

---

## Setup

The MCP server runs in Docker and is wired into your client via `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "reso": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--add-host=host.docker.internal:host-gateway", "reso-mcp-server"]
    }
  }
}
```

Because the MCP server runs inside a container, use `http://host.docker.internal:<port>/` to reach services on the host. The reference server's default URL is `http://host.docker.internal:8080/`.

---

## Section 0 – Getting Authenticated

> **User:** I want to start exploring my RESO server through you. How do I authenticate?
>
> **Assistant:** The MCP server supports two auth methods. **Bearer token** is the simplest – if you already have a token from your IdP, just pass it as `authToken` on every call. **Client Credentials** is the full OAuth2 round-trip: you give me a `clientId`, `clientSecret`, and `tokenUrl`, and I fetch a fresh token before each request. Use that one if your server issues short-lived tokens or if you want to exercise the full handshake. Which would you like?
>
> **User:** Let us use Client Credentials – it will exercise both code paths.
>
> **Assistant:** Great. What credentials should I use?
>
> **User:** It is the reference server, so anything works – its mock OAuth endpoint hands out tokens for any client id and secret. Let us use `test` / `test`.
>
> **Assistant:** Perfect. From here on I will use these as your auth context for every call:
>
> ```jsonc
> {
>   "url":          "http://host.docker.internal:8080/",
>   "clientId":     "test",
>   "clientSecret": "test",
>   "tokenUrl":     "http://host.docker.internal:8080/oauth/token"
> }
> ```
>
> If you ever want to switch to bearer-token auth instead, just hand me a token and I will use this shape:
>
> ```jsonc
> {
>   "url": "http://host.docker.internal:8080/",
>   "authToken": "mock-access-token-abc123"
> }
> ```
>
> > **Tip:** if you ever see `Error: fetch failed`, the `url` or `tokenUrl` is not reachable from inside the MCP container. Double-check the port and that you are using `host.docker.internal` (not `localhost`).

For the rest of the guide, assume the Client Credentials shape above is implicitly attached to every tool call. The collapsed tool-call blocks omit the auth fields to keep the dialogue scannable.

---

## Section 1 – Exploring Metadata

### 1.1 What Is on This Server?

> **User:** What resources does this server actually expose?
>
> **Assistant:** Let me pull the metadata.
>
> <details><summary>Tool call – <code>mcp__reso__metadata</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__metadata",
>   "arguments": { /* auth context */ }
> }
> ```
>
> </details>
>
> The server exposes **14 entity types** under the `org.reso.metadata` namespace. Here they are with their key field and field count:
>
> | Resource | Key | Fields |
> |---|---|---|
> | Property | ListingKey | 722 |
> | Member | MemberKey | 81 |
> | Office | OfficeKey | 66 |
> | OUID | OrganizationUniqueIdKey | 43 |
> | Teams | TeamKey | 40 |
> | Media | MediaKey | 39 |
> | OpenHouse | OpenHouseKey | 34 |
> | Showing | ShowingKey | 34 |
> | PropertyRooms | RoomKey | 18 |
> | TeamMembers | TeamMemberKey | 18 |
> | PropertyUnitTypes | UnitTypeKey | 16 |
> | PropertyGreenVerification | GreenBuildingVerificationKey | 14 |
> | PropertyPowerProduction | PowerProductionKey | 11 |
> | Lookup | LookupKey | 7 |
>
> A few things stand out:
>
> - **`Property` dwarfs everything else** at 722 fields – most of the schema's gravity is in the listing record itself.
> - **Every resource has a single-field key** named `<Resource>Key`. This is the convention the rest of the DD relies on for joins and filters.
> - The **`Lookup`** resource sitting alongside the others is the v2.0+ "Lookup Resource" enum mode at work – enumerated values are queryable rows instead of CSDL `EnumType` members.

### 1.2 What Does a `Property` Field Look Like?

> **User:** Show me what a typical field on `Property` looks like in the metadata.
>
> **Assistant:** The metadata I just fetched has every field's normalized JSON. Two patterns dominate. A lookup-backed string field looks like this:
>
> ```json
> {
>   "name": "AboveGradeFinishedAreaSource",
>   "type": "Edm.String",
>   "annotations": {
>     "RESO.OData.Metadata.LookupName": "AreaSource"
>   }
> }
> ```
>
> The `RESO.OData.Metadata.LookupName` annotation is the bridge between a string field and the Lookup resource – it tells you which `LookupName` to filter by when you want the allowed values for this field. We will use it in §2.1.
>
> A plain decimal field looks like this:
>
> ```json
> {
>   "name": "AboveGradeFinishedArea",
>   "type": "Edm.Decimal",
>   "precision": 14,
>   "scale": 2
> }
> ```
>
> No annotation, just the OData primitive type and numeric precision.

### 1.3 How Is `Property` Shaped Overall?

> **User:** Of those 722 fields, what is the type breakdown?
>
> **Assistant:** Grouping `Property`'s fields by OData type:
>
> | OData type | Field count |
> |---|---|
> | `Edm.String` | 371 |
> | `Collection(Edm.String)` | 99 |
> | `Edm.Decimal` | 90 |
> | `Edm.Int64` | 77 |
> | `Edm.Boolean` | 52 |
> | `Edm.Date` | 17 |
> | `Edm.DateTimeOffset` | 16 |
>
> Things to notice:
>
> - **The schema is overwhelmingly textual.** More than half of `Property`'s fields are `Edm.String`, and another ~14% are `Collection(Edm.String)` – multi-valued lookup fields like `Appliances`, `InteriorFeatures`, or `PoolFeatures`.
> - **Lookup-backed strings are the dominant pattern.** Of those 371 `Edm.String` fields, **200** carry a `RESO.OData.Metadata.LookupName` annotation – the v2.0+ "string + Lookup Resource" enum mode in action.
> - **Numeric fields cluster around `Decimal` and `Int64`** – `Decimal` for money and measurements (with explicit `precision`/`scale`), `Int64` for counts and identifiers.
> - **Dates split into `Edm.Date` and `Edm.DateTimeOffset`** – `Date` for things like `ListingContractDate`, `DateTimeOffset` for timestamps like `ModificationTimestamp`.

### 1.4 Which Lookups Are Reused Most?

> **User:** Which `LookupName`s get reused across the most fields?
>
> **Assistant:** The annotations let me build that reverse index from the same metadata response – no extra round-trip:
>
> | Reuses | LookupName |
> |---|---|
> | 16 | LinearUnits |
> | 15 | AreaUnits |
> | 14 | FeedTypes |
> | 12 | AOR |
> | 10 | StateOrProvince |
> | 8 | AreaSource |
> | 6 | Country |
> | 6 | CountyOrParish |
> | 5 | FeeFrequency |
> | 4 | SocialMediaType |
>
> The unit-of-measure lookups (`LinearUnits`, `AreaUnits`) lead because every dimensional measurement on `Property` is paired with a `*Units` field. This is the same reverse index that powers the [DD documentation site](https://dd.reso.org/).

---

## Section 2 – Querying Data

### 2.1 What Values Are Actually Allowed for a Lookup Field?

> **User:** OK so `AboveGradeFinishedAreaSource` uses the `AreaSource` lookup. What values can it take?
>
> **Assistant:** Querying the `Lookup` resource for that `LookupName`.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Lookup",
>     "filter": "LookupName eq 'AreaSource'",
>     "select": "LookupName,LookupValue,StandardLookupValue"
>   }
> }
> ```
>
> </details>
>
> Nine allowed values:
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#Lookup",
>   "value": [
>     { "LookupName": "AreaSource", "LookupValue": "Appraiser",      "StandardLookupValue": "Appraiser" },
>     { "LookupName": "AreaSource", "LookupValue": "Assessor",       "StandardLookupValue": "Assessor" },
>     { "LookupName": "AreaSource", "LookupValue": "Builder",        "StandardLookupValue": "Builder" },
>     { "LookupName": "AreaSource", "LookupValue": "Estimated",      "StandardLookupValue": "Estimated" },
>     { "LookupName": "AreaSource", "LookupValue": "Other",          "StandardLookupValue": "Other" },
>     { "LookupName": "AreaSource", "LookupValue": "Owner",          "StandardLookupValue": "Owner" },
>     { "LookupName": "AreaSource", "LookupValue": "Plans",          "StandardLookupValue": "Plans" },
>     { "LookupName": "AreaSource", "LookupValue": "Public Records", "StandardLookupValue": "Public Records" },
>     { "LookupName": "AreaSource", "LookupValue": "See Remarks",    "StandardLookupValue": "See Remarks" }
>   ]
> }
> ```
>
> Two columns matter:
>
> - **`LookupValue`** is what shows up in the actual data – the string a server returns when you `$select=AboveGradeFinishedAreaSource`.
> - **`StandardLookupValue`** is the DD-standard label. On the seeded reference server they match, but on a real MLS feed they often do not – `LookupValue` may be `"Appr"` or `"PUB REC"` while `StandardLookupValue` stays canonical. That is the column to join on when normalizing across multiple feeds.

### 2.2 Just Give Me the First Few

> **User:** I just want a quick peek – first three values.
>
> **Assistant:** Same call with `top: 3`.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Lookup",
>     "filter": "LookupName eq 'AreaSource'",
>     "select": "LookupName,LookupValue",
>     "top": 3
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#Lookup",
>   "value": [
>     { "LookupName": "AreaSource", "LookupValue": "Appraiser" },
>     { "LookupName": "AreaSource", "LookupValue": "Assessor" },
>     { "LookupName": "AreaSource", "LookupValue": "Builder" }
>   ]
> }
> ```
>
> `top` pairs naturally with `skip` for paging and `orderby` for stable ordering – all three are thin pass-throughs to their OData equivalents.

### 2.3 Pull Some Real Listings

> **User:** Show me a handful of listings over $500k with just the headline columns.
>
> **Assistant:** Filtering `Property` on `ListPrice` and selecting the human-readable columns.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "filter": "ListPrice gt 500000",
>     "select": "ListingKey,ListPrice,StandardStatus,PropertyType,City,StateOrProvince",
>     "top": 5
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#Property",
>   "value": [
>     { "ListingKey": "50ddad45-…", "ListPrice": 6170936.83, "StandardStatus": "Active", "PropertyType": "Land",                 "City": "Ashland",     "StateOrProvince": "AZ" },
>     { "ListingKey": "1f484f2b-…", "ListPrice": 4901728.24, "StandardStatus": "Delete", "PropertyType": "Residential Lease",    "City": "Springfield", "StateOrProvince": "MD" },
>     { "ListingKey": "58bfa697-…", "ListPrice": 8784706.06, "StandardStatus": "Active", "PropertyType": "Manufactured In Park", "City": "Manchester",  "StateOrProvince": "AZ" },
>     { "ListingKey": "8d595bf7-…", "ListPrice": 8534762.75, "StandardStatus": "Hold",   "PropertyType": "Land",                 "City": "Madison",     "StateOrProvince": "FL" },
>     { "ListingKey": "ba4de598-…", "ListPrice": 3673103.69, "StandardStatus": "Active", "PropertyType": "Commercial Sale",      "City": "Madison",     "StateOrProvince": "NC" }
>   ]
> }
> ```
>
> Notice that `StandardStatus` and `PropertyType` come back as plain strings (`"Active"`, `"Commercial Sale"`) – these are the `LookupValue`s that correspond to entries in the `Lookup` resource. To translate them back to their canonical labels you would join on `LookupName eq 'StandardStatus'` or `'PropertyType'` using the same pattern from §2.1.

---

## Section 3 – Searching

Section 2 used `$filter` for the simplest possible cases – equality and a single comparison. Real searches lean on the full OData `$filter` toolkit: range expressions, string functions, collection lambdas and date windows. The MCP `query` tool is a thin pass-through, so anything OData supports is available here. This section walks through the patterns most teams reach for first.

### 3.1 Range and Status – Active Listings Between $300k and $600k

> **User:** Show me a few active listings priced between $300k and $600k, cheapest first, with bed/bath counts.
>
> **Assistant:** Combining `eq` for status with two range bounds and `$orderby` for the sort.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "filter": "StandardStatus eq 'Active' and ListPrice ge 300000 and ListPrice le 600000",
>     "select": "ListingKey,ListPrice,City,StateOrProvince,BedroomsTotal,BathroomsTotalInteger",
>     "orderby": "ListPrice asc",
>     "top": 3
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#Property",
>   "value": [
>     { "ListingKey": "8313b3a7-…", "ListPrice": 409481.86, "City": "Oxford", "StateOrProvince": "CT", "BedroomsTotal": 3, "BathroomsTotalInteger": 3 },
>     { "ListingKey": "0deedc4f-…", "ListPrice": 433155.60, "City": "Oxford", "StateOrProvince": "MA", "BedroomsTotal": 2, "BathroomsTotalInteger": 1 },
>     { "ListingKey": "474b21d8-…", "ListPrice": 486267.81, "City": "Salem",  "StateOrProvince": "PA", "BedroomsTotal": 4, "BathroomsTotalInteger": 3 }
>   ]
> }
> ```
>
> Three things worth noticing:
>
> - **`and` chains naturally** – three predicates joined left-to-right, no parentheses needed.
> - **`StandardStatus eq 'Active'`** is the canonical "is this listing on the market?" filter. It is the lookup-backed string we resolved in §2.1, used here directly as a literal.
> - **`orderby` is a thin pass-through to `$orderby`** – `asc`/`desc` modifiers work, multi-column ordering works (`ListPrice asc, ModificationTimestamp desc`), and ordering on lookup-backed strings sorts alphabetically by `LookupValue`.

### 3.2 String Matching – Anything in a Springfield

> **User:** Find me active listings whose city contains "spring" – case-insensitive if possible.
>
> **Assistant:** OData's `contains()` function does substring matching. Most servers (the ref server included) treat the comparison case-insensitively for `Edm.String`, so `'spring'` matches `Springfield`.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "filter": "contains(City, 'spring') and StandardStatus eq 'Active'",
>     "select": "ListingKey,City,StateOrProvince,ListPrice",
>     "top": 3
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#Property",
>   "value": [
>     { "ListingKey": "37a424a6-…", "City": "Springfield", "StateOrProvince": "NY", "ListPrice": 4944132.06 },
>     { "ListingKey": "9cb9e65a-…", "City": "Springfield", "StateOrProvince": "MA", "ListPrice": 7745886.30 },
>     { "ListingKey": "399390c0-…", "City": "Springfield", "StateOrProvince": "IL", "ListPrice": 9489760.55 }
>   ]
> }
> ```
>
> The same family includes `startswith(City, 'spring')` for prefix matches and `endswith(StreetName, 'Avenue')` for suffix matches. They all work on any `Edm.String` field. For exact matching against an enumerated set of values use `in` instead – `City in ('Austin', 'Dallas', 'Houston')` is much cheaper than three `contains()` calls combined with OR.

### 3.3 Multi-Value Lookup Fields – Homes with an ENERGY STAR Fridge

> **User:** Find listings whose `Appliances` includes an ENERGY STAR refrigerator.
>
> **Assistant:** `Appliances` is a `Collection(Edm.String)` – a multi-valued lookup field. Filtering against a collection uses an OData lambda expression: `any(<var>: <predicate>)`. The lambda binds each element of the collection to the variable in turn and the row matches if *any* element satisfies the predicate.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "filter": "Appliances/any(a: a eq 'ENERGY STAR Qualified Refrigerator')",
>     "select": "ListingKey,City,Appliances",
>     "top": 3
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#Property",
>   "value": [
>     {
>       "ListingKey": "50ddad45-…",
>       "City": "Ashland",
>       "Appliances": ["Built-In Gas Range", "ENERGY STAR Qualified Refrigerator"]
>     },
>     {
>       "ListingKey": "75bb9927-…",
>       "City": "Ashland",
>       "Appliances": ["ENERGY STAR Qualified Refrigerator"]
>     }
>   ]
> }
> ```
>
> Two practical notes:
>
> - **The variable name (`a`) is arbitrary** – use whatever reads well. `Appliances/any(appliance: appliance eq '…')` is identical.
> - **`all(...)` is the dual of `any(...)`** when you want every element to satisfy the predicate. Less common in real searches, but it shows up in negative filters: `not Appliances/any(a: a eq 'Trash Compactor')` is the way to ask for "no trash compactor."

### 3.4 Sanity-Checking a Complex Filter with `parse-filter`

> **User:** Before I run this, can you confirm I built the filter correctly? `StandardStatus eq 'Active' and ListPrice ge 300000 and ListPrice le 600000 and contains(City, 'spring')`
>
> **Assistant:** That is exactly what `parse-filter` is for. It runs the same OData expression parser the rest of the RESO toolchain uses and returns the AST. If the parse succeeds, the syntax is valid; if it fails, you get a precise error. No server round-trip needed.
>
> <details><summary>Tool call – <code>mcp__reso__parse-filter</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__parse-filter",
>   "arguments": {
>     "filter": "StandardStatus eq 'Active' and ListPrice ge 300000 and ListPrice le 600000 and contains(City, 'spring')"
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "type": "logical", "operator": "and",
>   "left": {
>     "type": "logical", "operator": "and",
>     "left": {
>       "type": "logical", "operator": "and",
>       "left":  { "type": "comparison", "operator": "eq", "left": { "type": "property", "name": "StandardStatus" }, "right": { "type": "literal", "value": "Active",  "dataType": "string" } },
>       "right": { "type": "comparison", "operator": "ge", "left": { "type": "property", "name": "ListPrice" },      "right": { "type": "literal", "value": 300000,    "dataType": "number" } }
>     },
>     "right":   { "type": "comparison", "operator": "le", "left": { "type": "property", "name": "ListPrice" },      "right": { "type": "literal", "value": 600000,    "dataType": "number" } }
>   },
>   "right":     { "type": "function", "name": "contains", "args": [ { "type": "property", "name": "City" }, { "type": "literal", "value": "spring", "dataType": "string" } ] }
> }
> ```
>
> Reading the AST tells you three things at a glance:
>
> 1. **The left-associativity is correct** – `a and b and c and d` parses as `((a and b) and c) and d`, which is what you want for a chain of conjunctions.
> 2. **Literal types were inferred correctly** – `'Active'` is a string, `300000` is a number. If `ListPrice` had accidentally been quoted (`'300000'`) the literal would come back as `string` and the eventual server query would 400.
> 3. **`contains` parses as a function call**, not a comparison – confirming it will be sent as `contains(City,'spring')` rather than mangled.
>
> Use `parse-filter` whenever you are hand-building a filter from string concatenation, especially when user input is involved – it catches quoting errors and operator typos before they reach the network.

### 3.5 Date Windows – The Foundation of Incremental Sync

> **User:** Show me listings modified since the start of 2025, newest first.
>
> **Assistant:** `ModificationTimestamp` is the standard DD field for "when did this record last change". Combine it with `ge` and an ISO-8601 literal and you have an incremental-sync filter – the same shape every replication client uses to pull only what is new since its last sync cursor.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "filter": "ModificationTimestamp ge 2025-01-01T00:00:00Z",
>     "select": "ListingKey,ModificationTimestamp,StandardStatus",
>     "orderby": "ModificationTimestamp desc",
>     "top": 3
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#Property",
>   "value": [
>     { "ListingKey": "d7bc1b86-…", "ModificationTimestamp": "2026-04-07T03:31:48.422Z", "StandardStatus": "Delete" },
>     { "ListingKey": "0deedc4f-…", "ModificationTimestamp": "2026-04-07T03:31:48.417Z", "StandardStatus": "Active" },
>     { "ListingKey": "43ab432f-…", "ModificationTimestamp": "2026-04-07T03:31:48.413Z", "StandardStatus": "Active" }
>   ]
> }
> ```
>
> Notice that all three results have nearly identical timestamps in early April 2026 – that is the moment the seed step ran, not the moment the listings were "actually" modified. This is what you would expect from a freshly bulk-loaded database: every record's `ModificationTimestamp` reflects the load, and the *real* incremental-sync story starts when the next mutation happens. Sections 4 and 5 cover both sides of that: making changes (Add/Edit) and tracking them (EntityEvent).
>
> Two things worth knowing about timestamp filters:
>
> - **`Edm.DateTimeOffset` literals do not take quotes.** It is `ge 2025-01-01T00:00:00Z`, not `ge '2025-01-01T00:00:00Z'`. This is one of the most common mistakes when hand-building filters; `parse-filter` will catch it for you.
> - **The DD also defines `ModificationTimestamp`'s Date sibling, `ListingContractDate`**, which is `Edm.Date` (no time component). For Date fields the literal is `2025-01-01` with no `T...Z` suffix.

### 3.6 What Is *Not* Covered Here

`$filter` has a few more corners worth knowing about, even if we will not demo each one in detail:

- **Geospatial functions** (`geo.distance`, `geo.intersects`) – for radius and polygon search. RESO defines them in the spec, but support varies by server. Worth checking your `$metadata` capabilities annotations before relying on them.
- **`$count=true`** – returns `@odata.count` alongside the page so you know the total result-set size, not just the current page. The MCP `query` tool exposes it as the `count` boolean parameter.
- **`$expand`** – pulls related records inline (e.g. `$expand=Media`). The MCP `query` tool exposes it as the `expand` parameter. Whether it works depends on the server's navigation properties, which is server-specific.

These are best learned the same way Sections 3.1–3.5 demonstrated: form a question, send it, and read the AST or the response. The MCP server does not care which OData feature you reach for – it just forwards the call.

---

## Section 4 – Add/Edit

Reading data is half the story. The other half is making changes – creating listings, updating fields, deleting records – and the MCP server's `create`, `update`, and `delete` tools make that possible through natural conversation. This section walks through CRUD operations against a RESO server: what happens when things work, what happens when they do not and how an AI assistant can turn structured errors into actionable guidance.

### 4.1 Creating a Listing

> **User:** Add a new residential listing in Bend, Oregon. 4 bedrooms, 3 baths, 2,200 sqft on a quarter acre, listed at $425,000.
>
> **Assistant:** I will create a Property record with those details. Let me start with the basics and see what the server requires.
>
> <details><summary>Tool call – <code>mcp__reso__create</code> (first attempt)</summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__create",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "record": {
>       "StandardStatus": "Active",
>       "ListPrice": 425000,
>       "City": "Bend",
>       "StateOrProvince": "OR",
>       "PropertyType": "Residential",
>       "BedroomsTotal": 4,
>       "BathroomsTotalInteger": 3,
>       "LivingArea": 2200,
>       "LotSizeAcres": 0.25
>     }
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "error": {
>     "code": "20100",
>     "message": "2 validation errors occurred",
>     "target": "Create",
>     "details": [
>       { "code": "30212", "target": "PostalCode", "message": "PostalCode is required." },
>       { "code": "30212", "target": "Country",    "message": "Country is required." }
>     ]
>   }
> }
> ```
>
> The server rejected the create with two validation errors – `PostalCode` and `Country` are both required. This is RESO Add/Edit certification behavior in action: the server validates inbound payloads against the Data Dictionary's required-field rules and returns structured 400s with field-level error codes. Adding both and retrying:
>
> <details><summary>Tool call – <code>mcp__reso__create</code> (retry)</summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__create",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "record": {
>       "StandardStatus": "Active",
>       "ListPrice": 425000,
>       "City": "Bend",
>       "StateOrProvince": "OR",
>       "PostalCode": "97702",
>       "Country": "US",
>       "PropertyType": "Residential",
>       "BedroomsTotal": 4,
>       "BathroomsTotalInteger": 3,
>       "LivingArea": 2200,
>       "LotSizeAcres": 0.25
>     }
>   }
> }
> ```
>
> </details>
>
> Server returned **HTTP 201** with the created record:
>
> ```json
> {
>   "@odata.id":       "http://server:8080/Property('e00039a8-b71c-448f-93b3-adf35bcd1980')",
>   "@odata.editLink": "http://server:8080/Property('e00039a8-b71c-448f-93b3-adf35bcd1980')",
>   "@odata.etag":     "W/\"MjAyNi0wNC0xMlQxOTo0ODo0Mi40ODNa\"",
>   "ListingKey":      "e00039a8-b71c-448f-93b3-adf35bcd1980",
>   "StandardStatus":  "Active",
>   "ListPrice":       425000,
>   "City":            "Bend",
>   "StateOrProvince": "OR",
>   "PostalCode":      "97702",
>   "Country":         "US",
>   "PropertyType":    "Residential",
>   "BedroomsTotal":   4,
>   "BathroomsTotalInteger": 3,
>   "LivingArea":      2200,
>   "LotSizeAcres":    0.25,
>   "ModificationTimestamp": "2026-04-12T19:48:42.465Z"
> }
> ```
>
> A few things to notice:
>
> - **The server assigned its own `ListingKey`** (`e00039a8-…`). On this server, `ListingKey` is always server-generated. Different servers have different policies – some accept client-supplied keys, some require them, some always overwrite. Always read the response body to learn the canonical key.
> - **`ModificationTimestamp` was set automatically.** You did not send it; the server stamped the record at creation time.
> - **`@odata.etag`** is there for optimistic concurrency. If you want to update this record later, you can send the ETag back in an `If-Match` header to prevent clobbering a change someone else made in between.

### 4.2 Updating a Record

> **User:** That Bend listing just went under contract. Mark it as Pending and set the contract date to today.
>
> **Assistant:** Just to confirm before I touch anything: you want me to PATCH listing `e00039a8-…` – the Bend, OR property at $425,000 – to `StandardStatus: Pending` with `PurchaseContractDate: 2026-04-12`. Correct?
>
> **User:** Correct.
>
> <details><summary>Tool call – <code>mcp__reso__update</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__update",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "key": "e00039a8-b71c-448f-93b3-adf35bcd1980",
>     "record": {
>       "StandardStatus": "Pending",
>       "PurchaseContractDate": "2026-04-12"
>     }
>   }
> }
> ```
>
> </details>
>
> Server returned **HTTP 200** with the updated record:
>
> ```json
> {
>   "ListingKey": "e00039a8-b71c-448f-93b3-adf35bcd1980",
>   "StandardStatus": "Pending",
>   "PurchaseContractDate": "2026-04-12",
>   "ListPrice": 425000,
>   "ModificationTimestamp": "2026-04-12T19:48:52.873Z",
>   "@odata.etag": "W/\"MjAyNi0wNC0xMlQxOTo0ODo1Mi44ODVa\""
> }
> ```
>
> The PATCH landed. Notice the server bumped `ModificationTimestamp` automatically and returned a fresh `@odata.etag`. Both are standard OData behaviors and are useful if you maintain a local cache.
>
> **User:** Now reduce the price to $399,000.
>
> <details><summary>Tool call – <code>mcp__reso__update</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__update",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "key": "e00039a8-b71c-448f-93b3-adf35bcd1980",
>     "record": { "ListPrice": 399000 }
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "ListingKey": "e00039a8-b71c-448f-93b3-adf35bcd1980",
>   "StandardStatus": "Pending",
>   "ListPrice": 399000,
>   "ModificationTimestamp": "2026-04-12T19:49:00.202Z",
>   "@odata.etag": "W/\"MjAyNi0wNC0xMlQxOTo0OTowMC4yMTNa\""
> }
> ```
>
> Price reduction applied. Each PATCH touches only the fields you send – `StandardStatus` stayed at `Pending` because we did not include it in this call. This is the standard OData PATCH semantic: merge the supplied fields into the existing record, leave everything else unchanged.

### 4.3 Deleting a Record

> **User:** That Portland listing from earlier was a test. Delete it.
>
> **Assistant:** Just to confirm – you want me to permanently delete listing `21d8fa80-af04-41c8-96e0-ce52d0200474`. This is a destructive operation: the `delete` tool advertises `destructiveHint: true`, so any MCP-aware host should also prompt you before invoking it. Proceed?
>
> **User:** Yes, delete it.
>
> <details><summary>Tool call – <code>mcp__reso__delete</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__delete",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "key": "21d8fa80-af04-41c8-96e0-ce52d0200474"
>   }
> }
> ```
>
> </details>
>
> ```json
> { "status": 204, "body": null }
> ```
>
> HTTP **204 No Content** – the OData convention for a successful DELETE. There is no body, just the status code. The record is gone from `Property`.

### 4.4 When Things Go Wrong – Error Handling

The happy path is the easy part. What separates a usable AI integration from a frustrating one is how it walks the user through *errors* – and RESO Add/Edit servers return them in a structured way the assistant can translate into plain language.

#### Missing Required Fields (HTTP 400)

We already hit this in §4.1 – the first `create` attempt left out `PostalCode` and `Country`. The error shape is worth understanding:

```json
{
  "error": {
    "code": "20100",
    "message": "2 validation errors occurred",
    "target": "Create",
    "details": [
      { "code": "30212", "target": "PostalCode", "message": "PostalCode is required." },
      { "code": "30212", "target": "Country",    "message": "Country is required." }
    ]
  }
}
```

Three things make this useful for AI-assisted Add/Edit:

- **The outer `error` envelope follows the OData JSON error format** – every compliant Add/Edit server returns this shape, so the assistant can parse it the same way regardless of whose server is on the other end.
- **`details[]` is the field-level breakdown.** Each entry has `target` (the field name) and `message` (a human-readable description). The assistant does not have to guess which fields need fixing – the server is explicit.
- **`code: 30212` is a stable RESO error code** for "required field missing." A more sophisticated client could map error codes to localized messages or trigger automatic remediation (e.g., "looks like you forgot Country – should I default it to `US`?").

The recovery pattern: parse the structured error, summarize it in plain language, propose a concrete fix, retry with consent. No raw JSON in the user-facing dialogue unless the user asks for it.

#### Record Not Found (HTTP 404)

> **User:** Delete listing `does-not-exist-12345`.
>
> **Assistant:** Sending the DELETE.
>
> <details><summary>Tool call – <code>mcp__reso__delete</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__delete",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "key": "does-not-exist-12345"
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "error": {
>     "code": "40400",
>     "message": "No Property record found with key 'does-not-exist-12345'.",
>     "target": "Delete",
>     "details": []
>   }
> }
> ```
>
> The server does not have a record with that key, so the DELETE failed with a 404. No EntityEvent is generated – failed writes do not produce events. If you were treating this as part of a sync loop, the right response is "the record was already gone, my local cache is consistent, move on."

#### The Silent Failure: When the Server Accepts Bad Data

This is the trap nobody warns you about. The user asks for a status change to a value that is not in the lookup and the server returns **HTTP 200** instead of a 400.

> **User:** Set that listing's `StandardStatus` to `ImaginaryStatus`.
>
> **Assistant:** Heads up – `ImaginaryStatus` is not a value in the `StandardStatus` lookup. From §2.1's pattern, the allowed values come from `Lookup` with `LookupName eq 'StandardStatus'`, and the standard ones are `Active`, `Pending`, `Closed`, `Hold`, `Expired`, `Withdrawn`, etc. Did you mean one of those, or do you want me to try it anyway to see what the server does?
>
> **User:** Try it anyway.
>
> The server returned **HTTP 200** with `"StandardStatus": "ImaginaryStatus"` in the response body. The server *accepted the bad value*. Worth pausing on what just happened:
>
> - **Not every server enforces lookup membership on PATCH.** This server validates required fields but does not validate that lookup-backed string fields contain values from the corresponding `Lookup` resource. Different servers make different choices about write-path validation.
> - **An AI assistant should not treat HTTP 200 as proof of correctness.** "The server accepted my call" and "the value I sent was valid" are not the same statement. The right pattern is: warn before sending if the assistant suspects the value is wrong, and sanity-check constrained fields after a successful response.

#### Putting the Three Patterns Together

| Server response | What it means | Recovery |
|---|---|---|
| `400` with `details[]` | Structured validation failure – server told you exactly what is wrong | Parse `details`, summarize to user, propose fix, retry with consent |
| `404` with empty `details[]` | The target record is not there | Acknowledge, treat as no-op, do not retry |
| `200` with a bad value visible | Server accepted something it probably should not have | Do not trust silence – sanity-check constrained fields after every write |

These three cover the vast majority of Add/Edit failure modes. Network errors and 5xx responses need infrastructure responses (retry with backoff, surface to the user) rather than RESO-specific reasoning.

### 4.5 What Add/Edit Makes Possible

With just the three write tools covered above, an AI assistant can act as a full data-entry and management interface for any RESO-compliant server:

- **Listing input** – create new listings conversationally, with the server's validation rules catching anything the assistant misses. No forms, no dropdowns, no training on a specific MLS system's UI.
- **Status management** – walk a listing through its lifecycle (`Active` → `Pending` → `Closed`) with appropriate companion fields set at each transition.
- **Price adjustments** – apply price changes with a single instruction and confirm the new price in the response.
- **Bulk corrections** – "update every listing in ZIP 97702 to `Country: US`" becomes a query-then-iterate loop the assistant can execute with consent at each step.
- **Data cleanup** – find and delete test or duplicate records, with the assistant confirming each destructive action.
- **Validation exploration** – intentionally test edge cases to discover what a specific server enforces and what it lets through, as we did with `ImaginaryStatus` above.

The next section builds on these operations by adding *change tracking* – the ability to know when *someone else* made a change and to consume those changes programmatically.

---

## Section 5 – EntityEvent

Reading data is half the story. Tracking *other people's* changes – and knowing what changed, when and to which records – is what the `EntityEvent` resource is for. This section walks through enabling the change feed, watching events land as mutations happen and reasoning about how a real polling client consumes them. It builds on the Add/Edit operations from Section 4.

### 5.1 Why EntityEvent Matters

> **User:** Before we touch anything, what *is* EntityEvent and why should I care?
>
> **Assistant:** EntityEvent is the RESO standard change feed. Every time a record on the server changes – created, updated, or deleted – the server appends a row to the `EntityEvent` resource. Clients pull from it on a cursor (`EntityEventSequence`) to learn what is new since their last sync. It is the foundation of incremental replication in the RESO ecosystem.
>
> The schema is intentionally lean. The DD 2.1 definition has just five fields:
>
> | Field | Type | What it tells you |
> |---|---|---|
> | `EntityEventSequence` | `Edm.Int64` | monotonic cursor – the only field you need to track between syncs |
> | `ResourceName` | `Edm.String` | which resource changed (`Property`, `Member`, `Media`, …) |
> | `ResourceRecordKey` | `Edm.String` | the key of the changed record |
> | `ResourceRecordUrl` | `Edm.String` | a fetchable URL pointing at the current state of the record |
> | `FeedTypes` | `Collection(Edm.String)` | which feed(s) the event belongs to, for multi-feed servers |
>
> Three things to absorb up front, because they will shape how you use it:
>
> 1. **The event is a *pointer*, not a *diff*.** It tells you "record X in resource Y changed, here is where to fetch the new version" – not what changed about it. If you want to know whether the price moved or the status flipped, you follow the pointer and compare.
> 2. **There is no `EventType` field, and that is intentional.** Creates, updates, and deletes all produce the same row shape. The polling client derives the semantics for itself, using two simple rules:
>    - **If the follow-up fetch returns 404 (or an empty result for a key you used to know about), it is a delete.** Drop it from your local feed.
>    - **Otherwise it is a change.** Compare the freshly-fetched record against your last-known copy field-by-field, or hash the records and compare hashes – whichever is cheaper for your data shape. If anything differs, apply the change. If nothing differs, treat the event as a no-op (which can happen with re-saves and re-publishes).
>
>    A future optional `EventTypes` extension is on the roadmap to make this distinction explicit on the server side, but the polling rules above work against every compliant server today.
> 3. **Today's model is pull, not push.** You poll `EntityEvent` on whatever interval suits you – every few seconds for near-real-time sync, every few minutes for slower feeds. Subscription/push semantics are on the RESO roadmap (server-sent events, webhooks, filterable subscriptions) but not in the current spec. Build your client around polling for now and the migration to push will be a layer on top, not a rewrite.

### 5.2 Enabling EntityEvent on the Reference Server

> **User:** OK, I want to try it. How do I turn it on?
>
> **Assistant:** EntityEvent is feature-flagged on the reference server. Set the `ENTITY_EVENT` env var to `true` and recreate the `server` container – the postgres data volume is untouched, so your seed data stays put.
>
> ```bash
> cd reso-reference-server
> ENTITY_EVENT=true docker compose up -d --force-recreate server
> ```
>
> You should see this in `docker logs reso-reference-server-server-1`:
>
> ```
>   EntityEvent: enabled
> EntityEvent compaction scheduled every 3600000ms.
>   Registered routes for EntityEvent (5 fields, key: EntityEventSequence, read-only, navProps: none)
> ```
>
> "Read-only" is important: clients can `GET` from `EntityEvent` but cannot `POST`/`PATCH`/`DELETE` against it directly. Rows appear there *only* as a side effect of writes against other resources.

### 5.3 The Empty Feed

> **User:** Cool. Show me what is changed in my feed lately.
>
> **Assistant:** Pulling the most recent rows.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "EntityEvent",
>     "orderby": "EntityEventSequence desc",
>     "top": 10
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#EntityEvent",
>   "value": []
> }
> ```
>
> Empty – and that is expected. The seed step bulk-loaded the fixture data directly into the underlying tables, bypassing the data-access layer that emits EntityEvent rows. This is consistent with how real replication works: a fresh database load is a *backfill*, not a stream of events. EntityEvent only starts populating once mutations flow through the OData API.
>
> Let us generate one. I will edit a listing and we will watch it appear in the feed.

### 5.4 Editing a Listing – The Confirm-Then-PATCH Dance

> **User:** Mark listing `50ddad45-e172-448d-8e9e-9aa5e2746873` as Pending.
>
> **Assistant:** Just to confirm before I touch anything: that is the Ashland AZ Land listing from §2.3 – the one currently `Active` at $6.17M. You want me to PATCH it to `StandardStatus: Pending`. Anything else change with it? In RESO it is customary to set `PurchaseContractDate` at the same time so downstream consumers know when the contract went under negotiation.
>
> **User:** Yeah, set `PurchaseContractDate` to today.
>
> **Assistant:** OK, here is what I am about to send. Confirm and I will run it.
>
> ```jsonc
> { "StandardStatus": "Pending", "PurchaseContractDate": "2026-04-06" }
> ```
>
> **User:** Go.
>
> **Assistant:** Calling `update`. Note that this is a write operation – your MCP-aware client should also surface its own confirmation prompt before invoking it, because the `update` tool advertises an `openWorldHint`. (Of the three write tools, only `delete` carries a `destructiveHint: true`; `create` and `update` are reversible enough that the assistant-side confirmation is the primary safety check.)
>
> <details><summary>Tool call – <code>mcp__reso__update</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__update",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "key": "50ddad45-e172-448d-8e9e-9aa5e2746873",
>     "record": {
>       "StandardStatus": "Pending",
>       "PurchaseContractDate": "2026-04-06"
>     }
>   }
> }
> ```
>
> </details>
>
> Server returned **HTTP 200** with the full updated record. The relevant fields:
>
> ```json
> {
>   "ListingKey": "50ddad45-e172-448d-8e9e-9aa5e2746873",
>   "StandardStatus": "Pending",
>   "PurchaseContractDate": "2026-04-06",
>   "ModificationTimestamp": "2026-04-07T04:10:29.770Z",
>   "@odata.etag": "W/\"MjAyNi0wNC0wN1QwNDoxMDoyOS43OTFa\""
> }
> ```
>
> The PATCH landed. Notice the server bumped `ModificationTimestamp` automatically and returned a fresh `@odata.etag` – those are both standard OData behaviors and useful if you are holding a local cache.

### 5.5 The First Event Appears

> **User:** Did it land in the feed?
>
> **Assistant:** Re-querying EntityEvent.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "EntityEvent",
>     "orderby": "EntityEventSequence desc",
>     "top": 10
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#EntityEvent",
>   "value": [
>     {
>       "EntityEventSequence": 1,
>       "ResourceName": "Property",
>       "ResourceRecordKey": "50ddad45-e172-448d-8e9e-9aa5e2746873",
>       "ResourceRecordUrl": null,
>       "FeedTypes": []
>     }
>   ]
> }
> ```
>
> Sequence #1, pointing at exactly the record we just edited. A few things to notice:
>
> - **`EntityEventSequence` started at 1** – that is the very first event ever produced by this server. Production servers will be at much higher numbers, and your client persists "I last saw sequence N" between syncs.
> - **`ResourceRecordUrl` is `null`** on this server. That is vendor-specific – the ref server has it disabled by default (controlled by a separate flag). Servers that populate it return something like `http://server:8080/Property('50ddad45-…')` so a client can navigate straight to the new state with a single GET.
> - **`FeedTypes` is empty** for the same reason – single-feed server, no need to tag events.
> - **There is no `EventType: 'Update'` here.** A consumer that wants "what kind of change was this?" has to derive it: keep a known-keys set, and treat events for unknown keys as creates, events for known keys as updates, and events whose follow-up GET returns 404 as deletes.

### 5.6 Adding a Brand New Listing

> **User:** OK now add a brand new listing – minimal fields, just enough to pass validation.
>
> **Assistant:** I will start small and let the server tell me what is required.
>
> <details><summary>Tool call – <code>mcp__reso__create</code> (first attempt)</summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__create",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "record": {
>       "StandardStatus": "Active",
>       "ListPrice": 425000,
>       "City": "Demo City",
>       "StateOrProvince": "CA",
>       "PropertyType": "Residential",
>       "BedroomsTotal": 3,
>       "BathroomsTotalInteger": 2
>     }
>   }
> }
> ```
>
> </details>
>
> ```
> Server returned HTTP 400: {
>   "error": {
>     "code": "20100",
>     "message": "2 validation errors occurred",
>     "target": "Create",
>     "details": [
>       { "code": "30212", "target": "PostalCode", "message": "PostalCode is required." },
>       { "code": "30212", "target": "Country",    "message": "Country is required." }
>     ]
>   }
> }
> ```
>
> The server told me exactly what is missing – `PostalCode` and `Country`. This is the ref server's RESO Add/Edit certification behavior in action: it validates inbound payloads against the DD's required-field rules and returns structured 400s with field-level error codes. Adding both:
>
> <details><summary>Tool call – <code>mcp__reso__create</code> (retry)</summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__create",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "record": {
>       "StandardStatus": "Active",
>       "ListPrice": 425000,
>       "City": "Demo City",
>       "StateOrProvince": "CA",
>       "PostalCode": "94000",
>       "Country": "US",
>       "PropertyType": "Residential",
>       "BedroomsTotal": 3,
>       "BathroomsTotalInteger": 2
>     }
>   }
> }
> ```
>
> </details>
>
> Server returned **HTTP 201** with the created record. Trimmed to the interesting parts:
>
> ```json
> {
>   "@odata.id":       "http://server:8080/Property('1bd91490-4574-4b20-8827-0114b420d46d')",
>   "@odata.editLink": "http://server:8080/Property('1bd91490-4574-4b20-8827-0114b420d46d')",
>   "ListingKey":      "1bd91490-4574-4b20-8827-0114b420d46d",
>   "StandardStatus":  "Active",
>   "ListPrice":       425000,
>   "City":            "Demo City",
>   "StateOrProvince": "CA",
>   "PostalCode":      "94000",
>   "Country":         "US",
>   "PropertyType":    "Residential",
>   "ModificationTimestamp": "2026-04-07T04:11:04.152Z"
> }
> ```
>
> One thing worth flagging: **the server assigned its own `ListingKey`** (`1bd91490-…`). On the ref server, `ListingKey` is server-generated regardless of what you supply. Different servers have different policies – some accept client-supplied keys, some require them, some always overwrite. Always read the response body to learn the canonical key, do not assume your input survived.

### 5.7 Deleting a Record – The Destructive Path

> **User:** OK that was a throwaway, delete it.
>
> **Assistant:** Just to confirm – you want me to permanently delete listing `1bd91490-4574-4b20-8827-0114b420d46d` (the one we just created in Demo City, CA). This is a destructive operation: the `delete` tool advertises `destructiveHint: true`, so any MCP-aware host should also prompt you to confirm before invoking it. Should I proceed?
>
> **User:** Yes, delete it.
>
> <details><summary>Tool call – <code>mcp__reso__delete</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__delete",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "key": "1bd91490-4574-4b20-8827-0114b420d46d"
>   }
> }
> ```
>
> </details>
>
> ```json
> { "status": 204, "body": null }
> ```
>
> HTTP **204 No Content** – the OData convention for a successful DELETE. There is no body, just the status code. The record is gone from `Property` and a new EntityEvent row has been appended.

### 5.8 Wearing the Consumer's Hat – Verifying a Delete From the Feed

Sections 4.4–4.7 were about *making* writes. Now let us flip the perspective: you are a polling replication client, you have just pulled a new batch of EntityEvent rows and you need to figure out what each one means. The cleanest way to teach this is to do a clean add → observe → delete → re-observe cycle on a fresh record.

> **User:** Add another listing – minimal fields, somewhere in Oregon – and then walk me through how a polling client would actually consume the events.
>
> **Assistant:** Creating a Faraway, OR record so we have a fresh key to track.
>
> <details><summary>Tool call – <code>mcp__reso__create</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__create",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "record": {
>       "StandardStatus": "Active",
>       "ListPrice": 525000,
>       "City": "Faraway",
>       "StateOrProvince": "OR",
>       "PostalCode": "97000",
>       "Country": "US",
>       "PropertyType": "Residential",
>       "BedroomsTotal": 2,
>       "BathroomsTotalInteger": 1
>     }
>   }
> }
> ```
>
> </details>
>
> Server returned **HTTP 201**, assigned key `bc4fb5d7-b717-4a5c-ad34-291dfcb3a3a8`. Now polling EntityEvent for anything past my last-known cursor.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "EntityEvent",
>     "filter": "EntityEventSequence gt 5",
>     "orderby": "EntityEventSequence asc"
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#EntityEvent",
>   "value": [
>     {
>       "EntityEventSequence": 6,
>       "ResourceName": "Property",
>       "ResourceRecordKey": "bc4fb5d7-b717-4a5c-ad34-291dfcb3a3a8",
>       "ResourceRecordUrl": null,
>       "FeedTypes": []
>     }
>   ]
> }
> ```
>
> One new event, sequence 6, for a key I have never seen before. Per the rules in §5.1: **unknown key + record exists on follow-up fetch = create**. Let me verify by fetching the record:
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "filter": "ListingKey eq 'bc4fb5d7-b717-4a5c-ad34-291dfcb3a3a8'",
>     "select": "ListingKey,StandardStatus,ListPrice,City"
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "value": [
>     { "ListingKey": "bc4fb5d7-…", "StandardStatus": "Active", "ListPrice": 525000, "City": "Faraway" }
>   ]
> }
> ```
>
> Confirmed – record exists, this is a create. I add it to my local cache and advance my cursor to sequence 6.
>
> Now let us delete the record on the server side and watch what happens to the consumer.
>
> <details><summary>Tool call – <code>mcp__reso__delete</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__delete",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "key": "bc4fb5d7-b717-4a5c-ad34-291dfcb3a3a8"
>   }
> }
> ```
>
> </details>
>
> ```json
> { "status": 204, "body": null }
> ```
>
> The DELETE returned 204. Back in the consumer's seat, I poll EntityEvent again past my cursor (sequence 6):
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "EntityEvent",
>     "filter": "EntityEventSequence gt 6",
>     "orderby": "EntityEventSequence asc"
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "value": [
>     {
>       "EntityEventSequence": 7,
>       "ResourceName": "Property",
>       "ResourceRecordKey": "bc4fb5d7-b717-4a5c-ad34-291dfcb3a3a8",
>       "ResourceRecordUrl": null,
>       "FeedTypes": []
>     }
>   ]
> }
> ```
>
> A new pulse on a key I now know about. This *could* be a delete (record gone) or an update (record still there but with different fields). I disambiguate with the same fetch I used for the create:
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "Property",
>     "filter": "ListingKey eq 'bc4fb5d7-b717-4a5c-ad34-291dfcb3a3a8'",
>     "select": "ListingKey,StandardStatus,ListPrice"
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#Property",
>   "value": []
> }
> ```
>
> Empty `value` array – the record is gone. **Pulse in EntityEvent + 404/empty on retrieval = delete.** I drop `bc4fb5d7-…` from my local cache and advance my cursor to sequence 7.
>
> If the follow-up fetch had *returned* the record instead, the next step would be to compare it against my cached copy field-by-field – or, more efficiently for a 700-field resource like `Property`, hash both records and compare the hashes. Equal hash = no-op event (some servers emit those when a record is re-saved without actual changes). Different hash = real update; either compute a field-level diff for downstream consumers, or just replace the cached record wholesale.
>
> That is the entire polling-replication loop for EntityEvent, in pseudocode:
>
> ```
> while true:
>     events = GET EntityEvent?$filter=EntityEventSequence gt {cursor}&$orderby=EntityEventSequence asc
>     for event in events:
>         record = GET {ResourceName}?$filter={key} eq '{ResourceRecordKey}'
>         if record is empty:
>             cache.delete(key)            # delete signal
>         elif key not in cache:
>             cache.put(key, record)       # create
>         elif hash(record) != hash(cache[key]):
>             cache.put(key, record)       # update
>         # else: no-op, ignore
>         cursor = event.EntityEventSequence
>     sleep(poll_interval)
> ```
>
> Every consumer in the RESO ecosystem is, at heart, some variation on that loop. The forthcoming optional `EventTypes` extension will let servers advertise the change type up front so consumers can skip the disambiguation fetch when they care, but the loop above works against every compliant server today.

### 5.9 Summarizing Recent Changes From the Feed

> **User:** Show me everything that is happened in my feed today, oldest first, and summarize.
>
> **Assistant:** Pulling the full feed in sequence order.
>
> <details><summary>Tool call – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     /* auth context */
>     "resource": "EntityEvent",
>     "orderby": "EntityEventSequence asc",
>     "top": 20
>   }
> }
> ```
>
> </details>
>
> ```json
> {
>   "@odata.context": "http://server:8080/$metadata#EntityEvent",
>   "value": [
>     { "EntityEventSequence": 1, "ResourceName": "Property", "ResourceRecordKey": "50ddad45-e172-448d-8e9e-9aa5e2746873", "ResourceRecordUrl": null, "FeedTypes": [] },
>     { "EntityEventSequence": 2, "ResourceName": "Property", "ResourceRecordKey": "1bd91490-4574-4b20-8827-0114b420d46d", "ResourceRecordUrl": null, "FeedTypes": [] },
>     { "EntityEventSequence": 3, "ResourceName": "Property", "ResourceRecordKey": "1bd91490-4574-4b20-8827-0114b420d46d", "ResourceRecordUrl": null, "FeedTypes": [] },
>     { "EntityEventSequence": 4, "ResourceName": "Property", "ResourceRecordKey": "50ddad45-e172-448d-8e9e-9aa5e2746873", "ResourceRecordUrl": null, "FeedTypes": [] },
>     { "EntityEventSequence": 5, "ResourceName": "Property", "ResourceRecordKey": "50ddad45-e172-448d-8e9e-9aa5e2746873", "ResourceRecordUrl": null, "FeedTypes": [] },
>     { "EntityEventSequence": 6, "ResourceName": "Property", "ResourceRecordKey": "bc4fb5d7-b717-4a5c-ad34-291dfcb3a3a8", "ResourceRecordUrl": null, "FeedTypes": [] },
>     { "EntityEventSequence": 7, "ResourceName": "Property", "ResourceRecordKey": "bc4fb5d7-b717-4a5c-ad34-291dfcb3a3a8", "ResourceRecordUrl": null, "FeedTypes": [] }
>   ]
> }
> ```
>
> Seven events on `Property`, in the order they happened. Notice what the rows *do not* tell you on their own – there is nothing here that distinguishes a create from an update from a delete. Applying the polling rules from §5.1 and §5.8, here is what a fresh consumer would reconstruct:
>
> | Seq | Key | Known before? | Follow-up fetch | Verdict |
> |---|---|---|---|---|
> | 1 | `50ddad45-…` | Yes (seed) | Returns record | **Update** – compare to cached copy; `StandardStatus` and `PurchaseContractDate` differ → apply (§5.4 PATCH to Pending) |
> | 2 | `1bd91490-…` | No | Returns record | **Create** – add to cache (§5.6 Demo City throwaway) |
> | 3 | `1bd91490-…` | Yes (just learned at seq 2) | Returns empty | **Delete** – drop from cache (§5.7) |
> | 4 | `50ddad45-…` | Yes | Returns record | **Update** – compare; `StandardStatus` differs → apply (foreshadowing §5.10) |
> | 5 | `50ddad45-…` | Yes | Returns record | **Update** – compare; `StandardStatus` differs again → apply |
> | 6 | `bc4fb5d7-…` | No | Returns record | **Create** – add to cache (§5.8 Faraway, OR) |
> | 7 | `bc4fb5d7-…` | Yes (just learned at seq 6) | Returns empty | **Delete** – drop from cache (§5.8) |
>
> A real incremental-sync client does not need to do any of this reasoning by hand – it just runs the loop from §5.8 and the `if record is empty / elif key not in cache / elif hash differs` branches do the work mechanically. But it is worth seeing the *shape* of the reasoning at least once: the feed gives you the sequence and the pointer; you decide what kind of change it represents by comparing what you knew to what you can fetch now.

### 5.10 Error Handling in the Context of EntityEvent

The Add/Edit error patterns from §4.4 apply here too – structured 400s for validation failures, 404s for missing records, and silent acceptance of bad data. The key difference in the EntityEvent context: **failed writes do not produce events.** Only successful mutations (HTTP 2xx) append a row to EntityEvent. A 400 or 404 is invisible to the feed, which means a polling consumer never needs to reason about server-side validation failures – it only sees the changes that actually landed.

### 5.11 What Is Next for EntityEvent

The current spec is solid for batched, polling-based replication. Two things on the RESO roadmap will make it more interactive:

- **Subscriptions** – clients will be able to register a long-lived subscription against EntityEvent and have new rows pushed to them as they are produced, instead of having to poll. The protocol will likely use server-sent events or webhooks; the underlying data shape stays the same.
- **Filtering on subscription** – `subscribe to EntityEvent where ResourceName eq 'Property' and PostalCode in ('94000', '94001')`. This is the piece that turns EntityEvent from "raw firehose" into "personalized change stream" and is what most production clients are actually waiting for.

There is also an optional **`EventTypes`** extension coming that will let servers advertise change types up front so consumers can skip the disambiguation fetch from §5.8 when the server cares to opt in. The polling rules in §5.1 will continue to work either way.

When those land, the MCP server's `query` tool will support them on day one (it is a generic OData passthrough), and a future `subscribe` tool in this MCP server will surface the push side. Until then, build against the polling model – it is portable, it is standard and it works against every compliant server today.

---

> **Note:** the `validate` tool is currently a stub on the MCP server side ([handlers.ts](https://github.com/RESOStandards/reso-tools/blob/main/reso-mcp-server/src/handlers.ts#L137)) and is intentionally not covered here. It will be wired up to `@reso-standards/reso-validation` in a follow-up and added to this guide once it has something real to demonstrate.

---

## 6. RESO Cloud MCP Server

RESO hosts a cloud MCP server at `services.reso.org/mcp` that provides the same tools as the local MCP server without requiring any local installation. Any MCP-capable AI agent can connect to it with an API key and start querying RESO-compliant servers immediately.

### 6.1 Requesting Access

The cloud MCP server requires an API key. To request one, contact **dev@reso.org** with:

- Your name and organization
- Your intended use case (development, testing, demo, integration)

RESO will issue a bearer token for the beta program. Keys are available for RESO members and conference attendees.

### 6.2 Connecting

The cloud server uses MCP's Streamable HTTP transport. Point your MCP client at:

```
URL:    https://services.reso.org/mcp
Method: POST
Auth:   Authorization: Bearer <your-api-key>
```

Each request is a standard MCP JSON-RPC message. For example, to list available tools:

```json
POST https://services.reso.org/mcp
Authorization: Bearer <your-api-key>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

### 6.3 Available Tools

The cloud server exposes the core RESO tools:

| Tool | Description |
|------|-------------|
| `authenticate` | Obtain a bearer token via OAuth2 Client Credentials |
| `query` | Query any RESO OData resource with $filter, $select, $orderby, $top, $skip, $expand |
| `metadata` | Fetch and parse OData CSDL metadata from any RESO server |
| `create` | Create a new record (POST) |
| `update` | Update a record (PATCH) |
| `delete` | Delete a record (DELETE) |
| `parse-filter` | Parse an OData $filter expression into an AST |

Certification tools (`run-compliance`, `metadata-report`) will be added in a future update.

### 6.4 Example: Query via the Cloud Server

To query a RESO server through the cloud MCP, your AI agent sends:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "query",
    "arguments": {
      "url": "https://api.example.com/odata",
      "resource": "Property",
      "top": 5,
      "select": "ListingKey,ListPrice,City,StandardStatus",
      "filter": "ListPrice ge 200000 and StandardStatus eq 'Active'",
      "authToken": "Bearer your-server-token"
    }
  }
}
```

The cloud server makes the OData request on your behalf and returns the results. Your agent never needs to know OData syntax, it just calls the tool.

### 6.5 Authentication: Bearer Token vs. Client Credentials

Some RESO servers support OAuth2 Client Credentials. The cloud MCP server handles both patterns:

**Bearer token** – if you already have a token, pass it directly as `authToken` in any tool call:

```json
"arguments": {
  "url": "https://api.example.com/odata",
  "resource": "Property",
  "authToken": "your-bearer-token"
}
```

**Client Credentials** – if the server requires OAuth2, use the `authenticate` tool first to obtain a token:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "authenticate",
    "arguments": {
      "clientId": "your-client-id",
      "clientSecret": "your-client-secret",
      "tokenUrl": "https://auth.example.com/oauth2/token"
    }
  }
}
```

The server returns a bearer token. Use that token as `authToken` in subsequent calls. You can also skip the `authenticate` step and pass `clientId`, `clientSecret`, and `tokenUrl` directly on any tool call – the cloud server will obtain the token automatically before making the request.

### 6.6 Cloud vs. Local

| | Cloud (`services.reso.org/mcp`) | Local (`reso-mcp`) |
|---|---|---|
| **Setup** | Just an API key | Install Node.js, clone repo |
| **Tools** | Core tools (query, metadata, CRUD) | All tools including certification |
| **Latency** | Network round-trip through AWS | Direct on your machine |
| **Use case** | Quick demos, remote agents, conference | Development, cert testing, offline |

Both use the same tool interfaces and return the same response shapes. An agent built against the cloud server will work identically with the local server and vice versa.
