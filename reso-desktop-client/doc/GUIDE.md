# RESO Desktop Client – User Guide

A capability tour of the RESO Desktop Client. This is the native desktop application for browsing any RESO-compliant OData server, with a built-in certified reference server, persistent secure connection storage, and a metadata-aware UI that shapes itself to whichever server you connect to.

If you have ever wanted a real RESO Web API on your laptop without Docker, this is the application that ends that pattern.

## Audience

Anyone who needs to interact with a RESO server from a real desktop application. Real examples:

* **MLS and vendor staff** who need a tool that opens with a double-click and works the same way every day, without spinning up containers
* **Brokers and agents** evaluating a RESO data source who do not have (or do not want) a development environment
* **Integration teams** who want to inspect a third-party server in a UI that runs offline against a local database
* **Test engineers** who need to verify a server's behavior in a tool that does not require Node.js, Docker, or any developer toolchain
* **Workshop and demo audiences** where the audience needs to see the data on screen without setup time
* **Anyone preparing for the RESO Spring conference** who wants to walk through the cert flow on stage from a single application

The desktop client is the same UI as the **[RESO Web Client](../reso-web-client/)**, packaged as a native Electron application, with three things the web client cannot do on its own: persistent secure connection storage, a built-in reference server you can run with no Docker, and a certification workspace for running and reviewing cert results.

## Install

The desktop client ships as native binaries for **macOS**, **Windows**, and **Linux**. Download the latest release from the **[GitHub releases page](https://github.com/RESOStandards/reso-tools/releases)** and run the installer for your platform.

> **[ Image placeholder: Installer / first launch ]**
>
> *Alt text:* "Screenshot of the RESO Desktop Client installer on macOS, showing the application icon being dragged into the Applications folder. Caption text below the image describes the equivalent flow on Windows (next-next-finish installer) and Linux (.deb or .AppImage)."

No Docker required, no Node.js required, no database to install. The client uses an embedded SQLite database for the bundled reference server, and stores its own configuration in the user data directory for the platform.

For developers who want to run from source, the package README has the full clone-and-build path.

---

## What the Desktop Client Does

The desktop client is a metadata-driven RESO Web API browser packaged as a native application. Everything in the **[RESO Web Client](../reso-web-client/)** guide applies here too – the resource browser, the search controls, the detail and form views, the metadata explorer. This guide focuses on the things the desktop client adds *on top of* the web client experience.

Five things make the desktop client distinctive:

1. **It runs as a real native application** with platform-correct menus, keyboard shortcuts, trackpad gestures, and OS-level installation. Open it from the dock, the Start menu or the application launcher; it behaves the way other applications on your platform behave.
2. **It manages multiple server connections** with secure encrypted storage. Save a connection once, reconnect with one click, switch between servers without re-typing credentials.
3. **It carries its own certified reference server** as a child process. No Docker, no separate database, no external dependencies. Launch the desktop client and you have a fully working RESO server running locally on a random port.
4. **It includes a certification workspace** for running cert flows against any connected server and reviewing the results in a UI shaped for the workflow.
5. **It works offline** against the bundled reference server, so demos and workshops do not require a network connection.

The next sections walk through each of these in turn.

---

## Connecting to Servers

The first thing the desktop client shows you is the connection screen. You can connect to an external RESO server, you can connect to the built-in reference server, or you can connect to multiple servers at once and switch between them.

> **[ Image placeholder: Server connection screen ]**
>
> *Alt text:* "Screenshot of the RESO Desktop Client server connection screen. The center of the window shows a list of saved connections, each as a card with the server name, the URL, the last-connected time, and a connect button. A 'New Connection' button at the top of the list opens the new-connection form. The header bar shows the application name on the left and a theme toggle plus the application menu on the right. A small footer indicator shows the bundled reference server is available with a one-click 'Connect to Bundled Server' shortcut."

### Authentication Modes

The desktop client supports the same auth shapes as the web client, with one important difference: credentials are stored persistently and securely on disk between sessions.

* **Bearer Token** – paste a token. The client uses it on every request as `Authorization: Bearer <token>`. The token is stored in the connection record so you do not have to re-paste it on relaunch.
* **OAuth2 Client Credentials** – provide a client ID, client secret and token URL. The client fetches a fresh access token on first use, caches it, refreshes proactively at 90% of its TTL, and retries once on a 401. All three credentials are stored in the connection record.

> **[ Image placeholder: New connection form ]**
>
> *Alt text:* "Screenshot of the new-connection form. The form has fields for connection name, server URL, an auth method picker (Bearer Token / OAuth2 Client Credentials), and the credential fields appropriate to the chosen method. A 'Test Connection' button verifies the credentials work before saving. A 'Save and Connect' button stores the connection and opens it. The form is validated client-side; required fields are marked, and an error message appears inline if the credentials fail."

### Secure Credential Storage

In a signed and packaged build, connection data (including tokens, secrets and OAuth2 credentials) is encrypted at rest using Electron's `safeStorage` API. On macOS this routes to the system Keychain. On Windows it uses DPAPI. On Linux it uses `libsecret`. The encryption key never leaves the operating system's secure store, and the encrypted blob lives in the user data directory:

```
~/Library/Application Support/RESO Desktop Client/secure-storage.json   (macOS)
%APPDATA%\RESO Desktop Client\secure-storage.json                         (Windows)
~/.config/RESO Desktop Client/secure-storage.json                         (Linux)
```

In a development build (`npm run dev`), `safeStorage` is unavailable because the application is not code-signed, and connections are stored as plain JSON. This is appropriate for development and gives a clear visible signal that you are not in a secure context. Production users always get the encrypted path.

### Switching Between Servers

Once you have multiple connections saved, the navigation includes a server switcher at the top. Select any connection and the client reshapes the UI for that server's metadata in seconds – the resources change, the field groupings change, the lookup values change, the form layouts change. The same window, two different servers, no re-launch.

> **[ Image placeholder: Server switcher ]**
>
> *Alt text:* "Screenshot of the server switcher dropdown open at the top of the application window, showing three saved connections (one is the bundled reference server, two are external production servers). The currently active connection is highlighted with a checkmark and shows a green connection indicator. Each entry includes the server name, the URL, and a small status badge (connected, disconnected, error). A 'Manage Connections' link at the bottom opens the full connection list for editing or deleting saved entries."

---

## The Bundled Reference Server

The most distinctive thing about the desktop client compared to the web client: it ships with the **[RESO Reference Server](../reso-reference-server/)** as a child process. When the application launches, the server starts in the background on a random available port, with an embedded SQLite database in the user data directory. No Docker, no Node.js installation, no separate process to manage – the server is just there, ready to use.

> **[ Image placeholder: Bundled server status indicator ]**
>
> *Alt text:* "Screenshot of the bottom status bar of the application window showing the bundled reference server status. The indicator shows a green circle with the text 'Reference server running on port 51247', followed by the database backend (SQLite) and the metadata version (DD 2.1). A small button next to the indicator lets the user view the server logs in a new window or restart the server without restarting the desktop client."

### What This Enables

A fully working RESO Web API on your laptop with no setup. You can:

* **Connect the desktop client to itself** – the server switcher includes the bundled server as a built-in connection. One click and you are browsing real RESO data immediately.
* **Connect external tools to the bundled server** – the bundled server exposes itself on `http://localhost:<port>` so you can point any other RESO client (curl, the **[RESO Client SDK](../reso-client/)**, an MCP-aware AI agent, the **[RESO Certification](../reso-certification/)** runners) at the same server.
* **Run cert flows against it without leaving the application** – the certification workspace inside the desktop client uses the bundled server as a default target.
* **Demo without a network** – the bundled server runs entirely offline. Useful for conference talks, workshops, training sessions, and any environment where Wi-Fi cannot be trusted.

### Falling Back

If the full reference server cannot start for any reason – a missing native module, a port collision, a metadata file problem – the desktop client falls back to a lightweight CORS proxy. The proxy does not host data, but it does let the UI connect to *external* servers without the browser-level CORS restrictions that block a normal browser tab. This means the desktop client always provides *some* server functionality, even when the embedded server fails.

---

## Browsing and Searching

Once connected to a server (bundled or external), the browsing experience is the same as the **[RESO Web Client](../reso-web-client/)** – metadata-driven navigation, basic and advanced search, infinite scroll, detail views with field grouping, the full Add/Edit form surface, the metadata explorer. Everything in the web client guide applies. The desktop client wrapper adds platform niceties:

> **[ Image placeholder: Main browsing window with results ]**
>
> *Alt text:* "Screenshot of the main browsing window with the resource navigation on the left, search results in the center (a list of Property summary cards each showing ListPrice, City, BedroomsTotal, and a thumbnail), and search controls along the top. The active resource is highlighted in the navigation. The window has native macOS chrome with the traffic-light buttons in the top-left corner. The application menu bar shows File, Edit, View, Navigate, Window and Help menus."

* **Native menus** – File, Edit, View, Navigate, Window and Help. Each menu has the platform-correct keyboard shortcuts (Cmd on macOS, Ctrl on Windows and Linux).
* **Keyboard navigation** – `Cmd/Ctrl + [` and `Cmd/Ctrl + ]` for back and forward through the navigation history. `Cmd/Ctrl + ←` and `Cmd/Ctrl + →` work the same way for users who prefer arrow keys.
* **Trackpad gestures** – two-finger scroll for vertical and horizontal scrolling, three-finger swipe left and right for back and forward navigation. Behaves the way other native applications on the platform behave.
* **Persistent window state** – the application remembers window position, size, and which connection was open last. Relaunching opens you back where you were.

---

## The Certification Workspace

The desktop client includes a **certification workspace** for running and reviewing cert flows against any connected server. This is the part of the desktop client that does not exist in the web client at all – it is a desktop-specific surface for the work that needs persistent storage, long-running jobs and a UI shaped for the cert workflow.

> **[ Image placeholder: Certification workspace overview ]**
>
> *Alt text:* "Screenshot of the certification workspace landing page. The left navigation shows three sections: Endorsements (a public list of all certified endorsements across organizations), Certification (the authenticated workspace for running cert and managing results), and Variations Review (for resolving DD variations). The center of the window shows the Certification dashboard with summary cards for active jobs, recent results, and quick-start actions. The header includes a sign-in pill for switching between public and authenticated modes."

### Public Endorsements Browsing

Without signing in, the desktop client exposes the public **Endorsements** list – the same list of certified endorsements that powers the public RESO certification site. Anyone can browse it, search for an organization, see which endorsements they hold, and drill into the per-org Summary report.

> **[ Image placeholder: Public Endorsements list ]**
>
> *Alt text:* "Screenshot of the public Endorsements list. The page shows a search bar at the top, a row of filter pills (date range, endorsement type, recipient type), and a paginated list of endorsement cards grouped by recipient organization. Each card shows the organization name, the endorsement type and version, the status (Certified, In Progress, Failed), the certification date, and a 'View Details' link. A small count badge on each filter pill shows how many results match."

### Per-Organization Summary

Click any organization in the Endorsements list to open its Summary view. This is the one-page synthesis of how the organization is doing across every endorsement they hold, with high-level stats and comparison to industry averages.

> **[ Image placeholder: Per-organization Summary view ]**
>
> *Alt text:* "Screenshot of the per-organization Summary page. The header shows the organization name, type badge, location, UOI (copyable), and website link. A provider switcher row shows pill-shaped buttons for each provider/system combination, with a 'View Details' link right-aligned. Below the switcher, the Coverage section shows five tiles: RESO Fields with Data, RESO Lookups with Data, Field Standardization, Lookup Standardization, and Local Fields – each with the provider's count or percentage and the industry average. An IDX Payload section shows coverage with per-resource bars (Property, Member, Office, Media, OpenHouse) comparing provider to industry. Below Coverage is a Performance section with a hero replication-speed metric (seconds per 1,000 records), a percentage-faster-than-industry callout, and three supporting metrics (Avg Payload, Avg Response, Throughput) each with industry comparisons and green/amber delta labels. If the provider has opted out of performance metrics, the section shows 'N/A' with industry averages still visible."

### Detail Report

Click "View Details" on any endorsement to open the full Detail Report. The detail page uses a consistent "RESO \<type\> \<version\> Report" title format (e.g., "RESO Data Dictionary 2.0 Report") and shows the recipient name, provider, status, and spec links.

For Data Dictionary endorsements, the detail page has three views accessible via a toggle:

**RESO Analytics** – the default view. Shows hero tiles (resources, fields, lookups, standardization rate, report date), filter toggles (All/RESO/IDX/Local) with count badges, and expandable per-resource cards. Each resource card shows field and lookup counts, a standardization bar, and available-field/lookup counts from the data availability report. Expanding a card reveals category breakdowns (RESO/IDX/Local segmented bars) and availability distribution (bucket bars at each threshold with industry average markers). Counts are clickable – clicking "382 RESO" switches to the Server Explorer pre-filtered to RESO fields.

> **[ Image placeholder: RESO Analytics view ]**
>
> *Alt text:* "Screenshot of the RESO Analytics view for a DD 2.0 report. Five hero tiles across the top: Resources (16), Fields (293), Lookups (1,682), Standardization (97%), Report Date (Sep 22, 2025). Below, a toggle row shows 'RESO Analytics' active with 'Server Explorer' and 'Performance' as alternatives. Filter pills (All/RESO/IDX/Local) sit above a grid of expandable resource cards. One resource card is expanded showing segmented RESO/IDX/Local bars for fields and lookups, and availability distribution bucket charts with dashed industry-average markers."

**Server Explorer** – a metadata browser powered entirely by the cert API. No live server connection required. The view toggle row includes availability threshold pills (preset stops at 0%, >0%, ≥25%, ≥50%, ≥75%, p90, p95, p99, 100% with tooltips, plus a pencil icon for custom values). Below that, a resource dropdown with data set filters (All/RESO/Local/IDX) on the same row, then a search bar that filters across both field names and lookup values with element type filters (All/Fields/Enums/Expansions). Sort pills (name, type, avail) toggle ascending/descending with an arrow indicator. The field list shows each field's normalized type name, RESO/local badge, and availability percentage. Expanding a field defaults to the Lookup Values tab (when values exist) showing All/RESO/Local pills with per-value availability bars, scrollable for long lists. Other tabs include Data Dictionary (type, payloads, lookup name, DD Wiki link for RESO fields only), OData Info (OData type, nullable, collection, underlying enum type), and Annotations. An empty state message guides the user when filters return no results.

> **[ Image placeholder: Server Explorer view – resource and filters ]**
>
> *Alt text:* "Screenshot of the Server Explorer view. The view toggle row shows 'Server Explorer' active with availability threshold pills to the right (>0% selected, p90/p95/p99 with dashed underline tooltips, pencil icon for custom entry). Below, Resource dropdown set to 'Property (753)' with data set pills (All, RESO, Local, IDX) right-aligned on the same row. A search bar with element type pills (All, Fields, Enums, Expansions) below that. Sort pills (name with up arrow, type, avail with dashed tooltip) above the field list."

> **[ Image placeholder: Server Explorer view – expanded field with lookup values ]**
>
> *Alt text:* "Screenshot of the Server Explorer with a field expanded. The StandardStatus field shows the Lookup Values tab active by default with All (21), RESO (21), Local (0) filter pills. Lookup values like Active (60%), Pending (31%), ActiveUnderContract (9%) each show an availability bar. The list is scrollable, capped at about 7-8 visible items. The field row shows 'StandardStatus' with normalized type 'StandardStatus', RESO badge, and 100% availability."

> **[ Image placeholder: Server Explorer view – empty state ]**
>
> *Alt text:* "Screenshot of the Server Explorer with no matching fields. A dashed-border card in the center reads 'No fields match the current filters' with a suggestion to adjust availability threshold, data set filter, or element type filter."

**Performance** – provider vs. industry comparison. Three horizontal comparison bars (Average Response Time, Throughput, Average Payload Size) each showing provider and industry values with green/amber 'Better/Below' delta badges. A Replication Throughput by Resource section shows per-resource bars (Field, Lookup, Property) with records-per-second, response time, and bandwidth, plus a dashed industry-average marker. Per-resource cards show detailed sampling stats. If the provider has opted out, an explanation banner appears and industry averages are shown alone.

> **[ Image placeholder: Performance view ]**
>
> *Alt text:* "Screenshot of the Performance view. A card titled 'Provider vs. Industry Performance' shows three comparison bars: Average Response Time (provider 183ms in green, industry 1.10s in gray, 'Better 83%'), Throughput (provider 523 KB/s in amber, industry 886 KB/s in gray, 'Below 41%'), Average Payload Size (provider 71.6 KB, industry 1,013.1 KB). Below, a 'Replication Throughput by Resource' chart shows bars for Field, Lookup, and Property with records-per-second labels and a dashed industry-average marker line. Per-resource cards at the bottom show avg/median response times, throughput, payload size, records fetched, unique records, page size, and date range."

For Web API Core endorsements, the detail page shows version, OData version, authentication method, report date, a test parameters table with wiki links, and remarks.

For all other endorsement types (DD 1.7, Common Format, Add/Edit, Webhooks), the detail page shows version, status, report date, and remarks.

### Running Cert From the Desktop

The desktop client runs certification tests directly against any server – the embedded reference server or any external OData endpoint. All four endorsement types are supported: Data Dictionary, Web API Core, Web API Add/Edit, and EntityEvent.

Click **New Test Run** on the Certification Jobs page to open the Config Builder:

> **[ Image placeholder: Config Builder with provider org picker and endorsement options ]**
>
> *Alt text:* "Screenshot of the Config Builder. A provider org picker at the top searches the RESO organization directory by name or UOI. Below, a recipient card with its own org picker, a provider system (USI) dropdown, server URL field, and auth section (Bearer Token or Client Credentials). Endorsement checkboxes (Data Dictionary, Web API Core, Web API Add/Edit, EntityEvent) toggle per-endorsement option panels. DD options include version, record limit, strict mode, batch $expand, and Originating System Name/ID fields. Core options include spec version, enum mode, and resources. A concurrency selector and Start button are at the bottom."

The Config Builder supports:

* **Provider org picker** – searches the RESO organization directory (public, no auth required) by name or UOI, auto-fills provider USI from the org's systems list
* **Multi-recipient configs** – add multiple recipients in one batch, each with its own server URL, auth, and endorsement selection
* **Per-endorsement options** – DD (version, strict mode, originating system), Core (version, enum mode, full coverage), Add/Edit (resource, payloads directory), EntityEvent (observe or full mode, poll timeout)
* **JSON import/export** – compatible with the legacy `dd-config.json` format for existing cert-utils users
* **Concurrency** – run jobs sequentially or concurrently (with memory warning at 3+ concurrent DD jobs)

For the **embedded reference server**, leave the Server URL blank – it auto-resolves to the local server. Auth token is `admin-token`. EntityEvent is enabled by default on the embedded server.

For **external servers**, enter the full OData service root URL (e.g., `https://api.example.com/odata`) and the appropriate auth credentials.

> **[ Image placeholder: Jobs running with live step progress ]**
>
> *Alt text:* "Screenshot of the Certification Jobs page with two jobs: Data Dictionary 2.0 running (showing step progress – Health check passed, Resolve authentication passed, Generate metadata report running with '14 resources, 1196 fields' detail) and Web API Core 2.1.0 scheduled below it. The header shows filter pills for Running (1), Scheduled (1), and a search bar."

### Certification Dashboard

The Certification Dashboard shows a live overview of all testing activity:

> **[ Image placeholder: Dashboard with summary tiles and recent jobs ]**
>
> *Alt text:* "Screenshot of the Certification Dashboard. Six summary tiles across the top: Total Runs, Recipients, Active, Queued, Passed (7d), Failed (7d). Below, Passing and Failing hero cards with recipient names. A Recent Jobs list and Results by Recipient section show test history. An Expiring Soon section lists endorsements certified over two years ago."

* **Summary tiles** – total runs, unique recipients, active/queued counts, pass/fail over the last 7 days
* **Status cards** – passing and failing counts with recipient names
* **Recent jobs** – most recent runs with status, endorsement, and relative timestamp
* **Results by recipient** – aggregated pass/fail counts per organization
* **Expiring endorsements** – certifications older than two years from the cert API
* **View Jobs** button links to the full Jobs page

### Error Reports and Compliance Reports

Every completed job has a **View Report** (passed) or **View Failure Report** (failed) button.

**Passed jobs** open a Compliance Report modal showing each pipeline step with its status, duration, and detail. Steps with scenario data (Run Core scenarios, Run Add/Edit scenarios, Run EntityEvent scenarios) are expandable – click to see individual scenario results with pass/fail icons and durations.

> **[ Image placeholder: Compliance Report modal – passed Add/Edit job ]**
>
> *Alt text:* "Screenshot of the Compliance Report modal for a passed Web API Add/Edit job. Seven steps listed vertically with green checkmarks: Health check, Resolve authentication, Fetch metadata (14 entity types), Sample records (2 Property records), Generate payloads (6 files), Run Add/Edit scenarios (8 passed, 0 failed), Write compliance reports (2 reports). The Run Add/Edit scenarios step has a down-chevron indicating it is expandable. A Download Report button is at the bottom left."

**Failed jobs** open a Failure Report modal that picks the right renderer based on the failure type:

* **DD schema validation errors** – grouped by error message (e.g., "MUST be equal to one of the allowed values"), each group expandable to show affected fields and their invalid lookup values in a scrollable pane with copy icons and a CSV key download
* **DD variations** – real data from the variations checker showing suggested field/lookup mappings with cross-field badges, multi-suggestion options, and Fast Track/Ignore actions
* **Core/Add/Edit/EntityEvent scenario failures** – per-scenario cards with humanized names, assertion-level details (expected vs. actual), expandable for deeper inspection
* **Generic step failures** (auth, health check, metadata) – error message with contextual guidance

> **[ Image placeholder: Failure Report – DD schema validation errors ]**
>
> *Alt text:* "Screenshot of the Failure Report modal for DD schema validation errors. Header shows '5 fields with errors, 2 error types' with a spec link to dd.reso.org. Two error groups: 'MUST be equal to one of the allowed values' (3 fields) and 'MUST be integer or null but found decimal' (2 fields). Each group is expandable. Inside the first group, field rows show Resource badge, field name, and values count. Expanding a field reveals lookup values in a scrollable pane with copy icons and occurrence counts. A 'Download keys' link downloads affected record keys as CSV."

All failure reports include a **Download Results** button for the raw JSON and a link to the relevant specification (dd.reso.org, transport.reso.org/proposals/web-api-core, etc.).

### Local Job Management

Cert runs are persisted on disk in the `.reso-cert/` directory, organized by endorsement, provider, and recipient. Previous runs are automatically archived when a new run starts for the same configuration.

> **[ Image placeholder: Jobs page with multiple results ]**
>
> *Alt text:* "Screenshot of the Certification Jobs page showing five completed jobs: two DD failures, one Core failure, one Add/Edit passed, one EntityEvent passed. Running and scheduled jobs float to the top, followed by most recent results. Each job card shows the endorsement name and version, a Local badge, the recipient and provider names, the status (PASSED/FAILED) with timestamp, and a chevron to expand step details. Expanded cards show pipeline steps with status icons, durations, and detail text. Action buttons include View Report, View Failure Report, Compare, Submit to RESO, Re-run, and a trash icon for deletion."

The job history persists across application launches – close the app and reopen to find all previous results intact. Jobs can be re-run, deleted individually (with confirmation), or cleared entirely via the Delete All popover. The **Submit to RESO** button on passed jobs opens an environment-aware submission dialog (QA, Staging, Production) for pushing results to the RESO Services API.

---

## Diagnostic Logging

The desktop client writes a diagnostic log to a known location for support and debugging:

```
~/Library/Application Support/RESO Desktop Client/reso-desktop.log   (macOS)
%APPDATA%\RESO Desktop Client\reso-desktop.log                        (Windows)
~/.config/RESO Desktop Client/reso-desktop.log                        (Linux)
```

The log captures the bundled server's startup, every connection attempt, every authentication round-trip, every cert run's high-level events, and any unhandled errors in the main process. It does not capture the contents of any HTTP responses, request bodies, or credentials – it is a *behavior* log, not a *content* log. Useful for troubleshooting connection issues, server startup failures, or cert runs that did not behave the way you expected.

The Help menu has a **Reveal Log File** action that opens the log in the platform's default text editor.

---

## Platform Notes

A few things worth knowing per platform:

**macOS** – the application is signed when downloaded from official RESO releases. If you are running a development or unsigned build, you may need to right-click → Open the first time to bypass Gatekeeper. The application uses the macOS Keychain for credential encryption.

**Windows** – the application uses Windows DPAPI for credential encryption. SmartScreen may prompt on first launch for unsigned development builds; production releases are signed.

**Linux** – the application is distributed as a `.deb` package or as an `.AppImage` for distributions without a package manager. Credential encryption uses `libsecret` (which routes to GNOME Keyring or KDE Wallet depending on the desktop environment).

All three platforms run the same Electron-based application code; the only differences are the secure storage routing and the installer format.

---

## Where to Next

* **Connecting to a different server** – the **[RESO Web Client](../reso-web-client/)** guide has the full walkthrough of the browsing UI; everything in it applies to the desktop client too. The desktop client wrapper adds the persistent connection storage and the bundled server.
* **Running cert programmatically** – the **[RESO Certification](../reso-certification/)** package provides the same cert flows as a CLI and SDK for users who want to run them outside the desktop client (in CI, in scripts, in their own tools).
* **Filling the bundled server with realistic data** – the **[RESO Data Generator](../reso-data-generator/)** is the package that produces the seed data the bundled server starts with. The desktop client exposes a 'Seed' action in the certification workspace that calls it directly.
* **Building your own UI** – the **[RESO Client SDK](../reso-client/)** is the library both the desktop client and the web client are built on. If you want to embed the same connection, browsing, and write capabilities in another application, that is the right entry point.
* **Connecting an AI agent to the same server** – the **[RESO MCP Server](../reso-mcp-server/)** exposes any RESO server through the Model Context Protocol. Point it at the desktop client's bundled reference server and you have an AI-driven workflow against the same data you are browsing visually.

## Reference

* **[Package README](../)** – architecture details, scripts, prerequisites, and connection storage notes
* **[Source on GitHub](https://github.com/RESOStandards/reso-tools/tree/main/reso-desktop-client)**
* **[Latest releases](https://github.com/RESOStandards/reso-tools/releases)** – signed installers for macOS, Windows, and Linux
* **[Built on RESO Client SDK](../reso-client/)** – the OData library every connection flows through
* **[Bundles RESO Reference Server](../reso-reference-server/)** – the certified server that runs as a child process
