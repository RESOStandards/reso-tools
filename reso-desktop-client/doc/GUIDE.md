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

**Server Explorer** – a metadata browser powered entirely by the cert API. No live server connection required. Shows a resource dropdown, an availability threshold slider (default: 'Above 0%'), a search bar that filters across both field names and lookup values, and category pills (All/RESO/Local/Payload). The field list shows each field's name, friendly DD type, RESO/local badge, and availability percentage. Expanding a field reveals four tabs mirroring the old cert app: Lookup Values (with All/RESO/Local pills and per-value availability bars), Data Dictionary (type, payloads, lookup name, DD Wiki link), OData Info (OData type, nullable, collection, underlying enum type), and Annotations.

> **[ Image placeholder: Server Explorer view ]**
>
> *Alt text:* "Screenshot of the Server Explorer view. The top row has a Resource dropdown set to 'Property (691)' and an availability slider at 'Above 0%'. Below, a search bar and category pills (All, RESO active, Local, Payload). The field list shows fields like 'Appliances' with type 'String List, Multi', a green RESO badge, and '62%' availability. One field is expanded showing the Data Dictionary tab with Type, Payloads (IDX), LookupName, and a DD Wiki link."

**Performance** – provider vs. industry comparison. Three horizontal comparison bars (Average Response Time, Throughput, Average Payload Size) each showing provider and industry values with green/amber 'Better/Below' delta badges. A Replication Throughput by Resource section shows per-resource bars (Field, Lookup, Property) with records-per-second, response time, and bandwidth, plus a dashed industry-average marker. Per-resource cards show detailed sampling stats. If the provider has opted out, an explanation banner appears and industry averages are shown alone.

> **[ Image placeholder: Performance view ]**
>
> *Alt text:* "Screenshot of the Performance view. A card titled 'Provider vs. Industry Performance' shows three comparison bars: Average Response Time (provider 183ms in green, industry 1.10s in gray, 'Better 83%'), Throughput (provider 523 KB/s in amber, industry 886 KB/s in gray, 'Below 41%'), Average Payload Size (provider 71.6 KB, industry 1,013.1 KB). Below, a 'Replication Throughput by Resource' chart shows bars for Field, Lookup, and Property with records-per-second labels and a dashed industry-average marker line. Per-resource cards at the bottom show avg/median response times, throughput, payload size, records fetched, unique records, page size, and date range."

For Web API Core endorsements, the detail page shows version, OData version, authentication method, report date, a test parameters table with wiki links, and remarks.

For all other endorsement types (DD 1.7, Common Format, Add/Edit, Webhooks), the detail page shows version, status, report date, and remarks.

### Running Cert From the Desktop

For provider users (signed-in users with write access to their org's certification jobs), the workspace will include a **Run Cert** flow that calls the **[RESO Certification](../reso-certification/)** runners directly against any connected server. This feature is on the roadmap.

> **[ Image placeholder: Run Cert dialog ]**
>
> *Alt text:* "Screenshot of the Run Cert dialog. The dialog has fields for selecting the target server (defaults to the active connection), the endorsement to test (Web API Core, Data Dictionary, Add/Edit, EntityEvent), the cert version, and any per-flow options. A 'Start' button kicks off the run; a real-time log panel below the form shows the cert progress streaming as it runs. Upon completion, the dialog shows a per-scenario pass/fail summary and a 'View Full Report' button."

### Local Job Management

Cert runs are persisted as **jobs** in the desktop client's local store. Every run gets a job record with its status (queued, running, completed, failed), its target server, its endorsement, its start and end times, and a link to the full report.

> **[ Image placeholder: Local job manager ]**
>
> *Alt text:* "Screenshot of the local job manager. A list of jobs shows the most recent runs at the top, each with a row showing the endorsement (icon + name), the target server, the status (with a colored badge), the duration, and a 'View Report' action. Filters at the top let users scope by status, endorsement, or date range. A 'Run New' button at the top opens the Run Cert dialog. Failed jobs have an 'Open Logs' link that opens the diagnostic log file in the platform's default text editor."

The job history persists across application launches, so you can come back to a run you started yesterday and review its full output without re-running it. This is the surface most provider users will spend the most time in – it is where the actual work of cert preparation happens.

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
