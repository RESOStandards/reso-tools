# RESO Web Client – User Guide

A capability tour of the RESO Web Client. This is the browser-based user interface for exploring any RESO-compliant OData server, browsing its metadata, querying its data, and creating, updating, or deleting records – all with no installation beyond opening a URL.

If you have ever needed to look at a RESO server through a real UI instead of a curl command, this is the application that makes that possible from any browser on any device.

## Audience

Anyone who needs to interact with a RESO server visually rather than programmatically. Real examples:

* **MLS and vendor staff** who need to inspect what their server is actually returning, in a UI rather than a raw JSON feed
* **Brokers and agents** evaluating a RESO data source and wanting to see real listings, fields, and relationships before they commit
* **Integration teams** building against a third-party server who need to know what the data looks like in practice
* **AI and proptech teams** exploring a RESO feed to design a new product, where browsing the schema by hand is faster than reading the metadata document
* **RESO members and certification candidates** who want a quick visual sanity check on a server before running formal compliance tests
* **Workshop and demo audiences** who need to see the data flowing on screen, without setting up a desktop application

The web client is built around the **[RESO Client SDK](../reso-client/)** under the hood – everything you can do in the UI is something the SDK can do programmatically. The UI is one front-end built on the SDK; the desktop client is another. Both run against the same servers and use the same authentication paths.

## Install

Two deployment shapes, both via Docker Compose:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-web-client

# Proxy mode: connect to any external RESO or OData Web API server
docker compose --profile proxy up -d
# UI at http://localhost:8888

# Full stack: bundle the reference server, the database and the UI
docker compose --profile full up -d
# UI at http://localhost:5173, API at http://localhost:8080
```

You can also build it as a standalone static bundle and serve it from any web host. The full instructions live in the package README.

---

## What the Web Client Does

The web client is a metadata-driven browser for any RESO-compliant OData server. "Metadata-driven" means the entire UI is generated from the server's `$metadata` document at load time – the resources you see in the navigation, the fields shown in the search results, the form layouts for create and edit, the field-level type validators, the lookup pickers, the field grouping in detail views – none of it is hardcoded. Point the client at a different server and it reshapes itself for that server's schema.

The next sections walk through what you can do, organized by task.

---

## Connecting to a Server

The first thing the web client asks you for is the server you want to look at. It supports any RESO or OData Web API endpoint with the auth shapes RESO servers actually use.

> **[ Image placeholder: Server connection screen ]**
>
> *Description for the eventual screenshot:* the server connection modal at first launch, showing the URL field, the auth method picker (Bearer Token vs OAuth2 Client Credentials), the credential fields appropriate to the chosen method, and a "Connect" button. The form is centered on the page with the RESO logo above and a brief one-line explainer below the form.

Two authentication paths are supported out of the box:

* **Bearer Token** – the simplest path. Paste a token, the client uses it as `Authorization: Bearer <token>` on every request. Use this when you have a token from your IdP, your environment, or a config file.
* **OAuth2 Client Credentials** – the full OAuth2 round-trip. Provide a client ID, client secret and token URL, and the client fetches a fresh access token before each request, refreshes proactively at 90% of the token's TTL, and retries once on 401 responses. Use this when your server issues short-lived tokens.

The connection settings are remembered so you do not need to re-enter them on every visit. You can switch between connected servers from the navigation – the same web client connects to multiple servers in the same browser session.

---

## Browsing Resources

Once connected, the navigation shows every resource declared in the server's metadata. Click a resource to open the search view; the client fetches the metadata for that resource, generates the search and form layouts on the fly, and starts loading data.

> **[ Image placeholder: Resource navigation and search results ]**
>
> *Description for the eventual screenshot:* the main browsing view with the resource navigation on the left (Property, Member, Office, Media, OpenHouse, Showing, etc., with the active resource highlighted), the search results in the center as a list of summary cards, and the search controls along the top. Each summary card shows the most useful fields for that resource (`ListPrice`, `City`, `BedroomsTotal` for Property, `MemberFullName` and `MemberMlsId` for Member, etc.). The header bar carries the connected server name, the auth indicator, and a theme toggle.

The summary fields shown in each card come from a configurable list per resource. You can override which fields appear by editing the server's `ui-config.json`, or rely on the default which shows the most commonly useful fields per resource.

### Searching

Two search modes work side by side:

**Basic search** is a single text input that scopes against the most relevant fields for the active resource. Type, press enter, results update.

**Advanced search** opens a panel of field-level filters organized by RESO Data Dictionary group categories – Listing, Structure, Location, Pricing, and so on. Each filter knows the field's type and renders the right input (a numeric range slider for `ListPrice`, a date picker for `ListDate`, a multi-select for enum fields, a text input for free-form strings). The combined filter expression is rendered as a real OData `$filter` and pushed onto the URL so the search is shareable as a link.

> **[ Image placeholder: Advanced search panel ]**
>
> *Description for the eventual screenshot:* the advanced search panel expanded, showing field filters grouped by category headings (Listing, Structure, Location, Pricing). A handful of filters are populated to demonstrate the input types: a numeric range for ListPrice, a multi-select for StandardStatus, a date picker for ListDate, a text input for City. The composed `$filter` expression is shown as a small text strip above the result list so users can see the actual OData query the UI built.

Both search modes use server-side OData query options under the hood, so they work against any compliant server. The filter, sort, and pagination state lives in the URL, which makes every search result a shareable link – paste it to a colleague and they see exactly what you see.

### Infinite Scrolling

The result list pages automatically as you scroll. The client requests `$top=N&$skip=M` against the server, accumulates results, and dedupes by primary key so any server-side overlap does not surface as visible duplicates. There is no "next page" button – just keep scrolling until the server says there is nothing more.

---

## Reading a Record

Click any summary card to open the detail view for that record.

> **[ Image placeholder: Property detail view ]**
>
> *Description for the eventual screenshot:* the Property detail page for a real listing. The header shows the address, the price, and the status. The body is organized into collapsible sections by RESO field group (Listing, Structure, Pricing, Location, Tax, Schools, Public Remarks). Each section shows the populated fields with their values. A media carousel sits above the field sections showing listing photos. Action buttons (Edit, Delete) sit in the header for users with write permissions.

The detail view is generated from the metadata. Fields are organized into sections by RESO Data Dictionary group categories – every field with a `Listing` group annotation lands in the Listing section, every `Structure` field lands in the Structure section, and so on. Sections are collapsible so you can scope your reading to the part of the record you care about.

For Property records, the **Media carousel** shows the listing photos pulled in via `$expand=Media`. Click any photo to enlarge it; arrow keys advance through the carousel. Other expansions (open houses, room details, agents) are also available where the server exposes them.

---

## Creating, Updating, and Deleting Records

The web client is a full RESO Add/Edit (RCP-010) client. If the server you are connected to supports writes, the UI surfaces them through dynamically generated forms.

> **[ Image placeholder: Add/Edit form for Property ]**
>
> *Description for the eventual screenshot:* the create/edit form for a Property record. The form is grouped by RESO field categories the same way the detail view is. Required fields are marked. Type-aware inputs render based on field metadata: a date picker for `ListDate`, a numeric input with min/max for `ListPrice`, a multi-select dropdown for `StandardStatus`, an enum picker that shows the human-readable lookup display name (`Active Under Contract`) above the canonical value. A submit button at the bottom shows pending state during the round-trip; validation errors appear inline next to the fields they apply to.

Three things make these forms useful:

1. **They are generated entirely from metadata.** No per-resource form definitions, no hardcoded layouts. Every field the server declares becomes a form input of the right type, with the right constraints, in the right group.
2. **Client-side type validation runs before submit.** The form catches type errors and required-field omissions before any HTTP request goes out. This is the same **[reso-validation](../reso-validation/)** library the reference server uses on the write path, so what passes in the form is what passes on the server.
3. **Lookup-backed fields show the human-readable value** rather than the raw enum name. A `StandardStatus` field shows `Active Under Contract` to the user but submits the canonical value the server expects. The mapping is built from the server's Lookup Resource at load time.

Three operations are supported:

* **Add** – create a new record. The form starts empty and submits via POST.
* **Edit** – modify an existing record. The form pre-fills with the current values; only fields the user changes are sent in the PATCH.
* **Delete** – remove a record after a confirmation dialog. The dialog shows the record's primary identifier so you know exactly what is about to disappear.

All three operations show the server's response inline – success messages, validation errors, or any structured OData errors the server returns are displayed next to the field they apply to. There are no silent failures; whatever the server says is what the user sees.

---

## Browsing Metadata

Beyond the data, the client exposes the server's `$metadata` document through a **Metadata Explorer** view. This is the right entry point when you want to know what a server actually offers without writing any queries.

> **[ Image placeholder: Metadata explorer ]**
>
> *Description for the eventual screenshot:* the metadata explorer view showing the resource list on the left and the field list for the selected resource on the right. Each field row shows the field name, type (Edm.String, Edm.Decimal, Edm.DateTimeOffset, etc.), nullability, max length where applicable, and any RESO-specific annotations (LookupName for enum fields, StandardName for canonical RESO fields, Description for human-readable explanations).

The metadata explorer is the fastest way to answer questions like:

* "Does this server expose the OpenHouse resource?"
* "What fields are on Member?"
* "What enum values are valid for `StandardStatus` on this server?"
* "Does this server support `PropertyType` as a string or an enum type?"
* "How many local fields does this server have beyond the standard DD?"

It is also where you go when you are debugging a query that is not behaving the way you expect – you can confirm the field exists, confirm its type, and confirm whether it is nullable, all in seconds.

---

## Visual Touches That Matter

A few smaller capabilities that add up to a usable experience:

**Dark mode** – every screen has a dark theme that respects your system preference by default and overrides through a manual toggle. The choice is persisted in the URL so a shared link opens in the same theme the sender intended.

**Responsive layout** – the same UI works on a phone, a tablet, or a desktop browser. The navigation collapses to a hamburger menu on small screens, the search results reflow to a single column, and the detail and form views stack vertically without losing functionality.

**Shareable URLs** – every view stores its state in URL query parameters. The active filter, the sort order, the search mode, the theme, the open record – everything you can see is in the URL. Send the URL to a colleague and they see exactly what you saw.

**Built on the RESO Client SDK** – every request the web client makes goes through the **[RESO Client SDK](../reso-client/)**. This means the UI inherits the SDK's auth handling, its OData URL builder, its error parsing, and its metadata caching for free. It also means anything you can do in the UI you can also do programmatically – the same library powers your in-house tools, any front-end you want to build for reading or writing RESO data, or even your AI agents.

---

## Where to Next

* **A target server to connect to** – the **[RESO Reference Server](../reso-reference-server/)** is the natural target for development. Spin it up locally, connect the web client to it, and you have a fully populated browser experience in seconds. Both ship as part of the same repository.
* **A desktop application instead of a browser** – the **[RESO Desktop Client](../reso-desktop-client/)** is the same UI packaged as a native application, with offline support, OS-level installation, and an optional bundled reference server you can run without Docker.
* **Building your own UI on the same foundation** – the **[RESO Client SDK](../reso-client/)** is the library this client uses internally. If you want a custom UI, an internal admin tool, or anything that needs to read or write RESO data from JavaScript, that is the right entry point.
* **Filling a server with realistic test data first** – the **[RESO Data Generator](../reso-data-generator/)** produces the kind of seed data the web client browses against. The two pair naturally: generate, then browse.
* **Verifying a server's compliance** – the **[RESO Certification](../reso-certification/)** package runs the official cert tests against any server the web client can connect to.

## Reference

* **[Package README](../)** – installation paths, deployment modes, and configuration reference
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/reso-web-client)**
* **[Built on RESO Client SDK](../reso-client/)** – the OData library every request flows through
