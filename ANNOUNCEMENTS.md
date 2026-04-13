# RESO Tools – Announcements

---

## v0.8 – 2026-04-12

### Eight Days a Week

**The cert UI ships.** The desktop client now includes a full certification analytics workspace with three detail views for every Data Dictionary endorsement:

- **RESO Analytics** – hero metrics, expandable resource cards with per-resource standardization rates, availability distribution with industry comparison and clickable counts that navigate to the Server Explorer
- **Server Explorer** – a metadata browser powered entirely by the cert API (no live server needed), with per-field availability, four-tab field detail (Lookup Values, Data Dictionary, OData Info, Annotations), search across fields and lookup values, data set filters (All/RESO/Local/IDX), element type filters (All/Fields/Enums/Expansions) and an availability threshold with preset stops at p90, p95 and p99
- **Performance** – provider vs. industry comparison bars for response time, throughput and payload size, per-resource replication throughput with industry average markers, and per-resource sampling cards with detailed stats

**The Org Summary page is live.** Coverage tiles, per-resource bars with industry comparison, performance headlines with delta callouts, provider switcher, "View Details" navigation and an "Expiring Soon" badge for endorsements older than two years.

**The data generator got realistic.** City-specific street names from 75 real U.S. locations, field-name-aware numeric bounds (~40 rules), geo-consistent addresses across Property, Member and Office, co-agents from the same office as the primary agent, 20 real MLS system names and a reset button with two-step confirmation.

**The MCP guide gained an Add/Edit section.** Section 4 is now a standalone walkthrough of create, update, delete and error handling – including the three error patterns every AI integration needs to handle (structured 400s, 404s and silent acceptance of bad data). Section 5 builds on it with EntityEvent change tracking.

**Shared metadata components keep things consistent.** Badge, FieldRow, FilterPill, SearchInput, ResourceButton and AvailabilityThresholdPills are extracted into a shared module so the live metadata browser and the cert Server Explorer stay visually in sync.

**1,185 tests passing across 8 packages** (up from 1,097 in v0.7).

**[Download the desktop client](https://github.com/RESOStandards/reso-tools/releases/latest)** for macOS, Windows and Linux from the GitHub releases page. New test coverage for the cert summary adapter, detail report renderer selection and performance metrics adapter.

---

## v0.7 – 2026-04-06

### Return of the MCP

**AI agents can now write RESO records, not just read them.** The MCP server picks up the three operations that real Add/Edit work needs – `create`, `update`, `delete` – wrapped with the standard MCP destructive-hint annotations so compliant clients (Claude Code, Claude Desktop, IDE extensions) prompt the user before invoking destructive operations. The reference server's full RESO Add/Edit certification surface is now reachable from any MCP-aware assistant.

**The MCP server has a real user guide.** [`reso-mcp-server/doc/GUIDE.md`](https://github.com/RESOStandards/reso-tools/blob/main/reso-mcp-server/doc/GUIDE.md) is a dialogue-format walkthrough – every section is a real question to an AI assistant, the actual MCP tool call, and the verbatim response from a seeded reference server. It covers authentication (bearer and Client Credentials), metadata exploration, OData querying and searching, and a full Add/Edit + EntityEvent narrative. The EntityEvent section walks through the polling-replication consumer pattern that every RESO sync client is, at heart, some variation on – including a dedicated section on how an assistant should walk a user through structured server errors.

**EntityEvent works end to end through MCP.** With the reference server's `ENTITY_EVENT=true` mode enabled, the MCP server's generic OData passthrough surfaces the `EntityEvent` resource automatically – no MCP-side changes needed. Section 5 of the user guide demonstrates the full pull-based replication loop with a live consumer that distinguishes creates, updates, and deletes using the canonical "404 on follow-up fetch means delete; otherwise compare or hash" rules.

**Search now works on tools.reso.org.** The Pagefind index is now built and deployed via the GitHub Pages workflow, matching what dd.reso.org and transport.reso.org already do. Both desktop and mobile.

**The desktop client About panel can never go stale again.** Version is read automatically from `package.json` via `app.getVersion()`, and the release name is a single named constant. The release checklist in `CLAUDE.md` calls out the pattern explicitly.

**1,097 tests passing across 8 packages.** The MCP server's test suite now asserts the destructive-hint annotations on the new write tools so the safety contract is enforced in CI.

**What is next.** v0.8 – "Eight Days a Week" – the cert UI in the desktop client with analytics, server explorer, and performance views.

---

## v0.6 – 2026-04-06

### The MCP Strikes Back

**All four RESO certification endorsements now run natively in TypeScript.** Add/Edit, EntityEvent, Web API Core, and Data Dictionary testing no longer requires Java, Gradle, or the Commander. Just `npm install` and `reso-cert <endorsement>`. Test parameters are auto-configured from live server data.

**Data Dictionary 2.1 support is here.** The new DD version brings 3 new resources (Building, Model, RelatedLookup), 425 new fields, and 566 new lookups. [DD 2.1 documentation](https://dd.reso.org/DD2.1/) is live on dd.reso.org. The desktop client lets you switch between DD 2.0 and 2.1 from the Server menu.

**AI agents can drive RESO end to end.** The new MCP server exposes OData query, metadata, validation, and compliance testing tools to any MCP-compatible client – Claude, Cursor, VS Code, Windsurf, and more. As of v0.6 the MCP server is built and smoke-tested in CI against the reference server, so the dependency chain is verified on every PR. See the [MCP server docs](https://tools.reso.org/packages/reso-mcp-server/).

**Strict mode compliance verified.** The DD compliance pipeline now runs in strict mode by default in Docker, enforcing zero variations and full JSON schema validation. All 8 pipeline steps pass cleanly against the reference server with seeded data.

**Metadata generation from DD sheets.** Give the tool a DD XLSX file and it produces the reference metadata report used by the server and certification tools. No more Commander codegen. DD sheets have moved from the Commander repo to [transport.reso.org](https://github.com/RESOStandards/transport).

**Migrating from reso-certification-utils?** See the [migration guide](https://tools.reso.org/packages/reso-certification/) for command mapping, config compatibility, and new features.

> v0.5 was published briefly but had a release-workflow issue we could not resolve without bumping the version. v0.6 is the same scope plus the workflow fix. Treat v0.5 as superseded.

---

## v0.4 – 2026-04-05

### Getting Ready for Certification

**Packages restructured for compliance testing.** The `validation`, `data-generator`, and `certification` packages have been renamed to `reso-validation`, `reso-data-generator`, and `reso-certification` for consistency. The RESO certification SDK (`reso-certification-utils@3.0.0`) has been integrated as a dependency, laying the groundwork for DD testing, replication, schema validation, and more.

**Desktop client polished.** The app now shows a RESO-branded splash screen while the server starts, remembers your dark/light mode preference across sessions, checks for updates on launch, and no longer flashes white on startup or crashes on shutdown. The Help menu links to release notes, announcements, and the security audit on tools.reso.org.

**Release workflow automated.** Push a version tag and the CI builds macOS, Windows, and Linux binaries and creates a GitHub release with them attached. No more manual uploads.

**Security hardened.** Menu navigation paths are now safely serialized. Release URLs are validated before opening in the browser. See the [security audit](https://tools.reso.org/security/) for details.

---

## v0.3 – 2026-04-03

### The "Cache Me If You Can" Release

**Connect to any RESO server with OAuth2.** The desktop client and web UI now support Client Credentials authentication alongside Bearer Token mode. Token management is automatic – tokens are fetched via the proxy, stored per server, and survive page reloads.

**Faster metadata loading.** CSDL schemas are cached in IndexedDB with gzip compression (24-hour TTL). Lookup values are fetched lazily per field or group instead of loading everything upfront. Batch `LookupName in (...)` queries with server-driven paging replace individual per-field requests.

**New standalone proxy package.** `@reso-standards/web-api-proxy` lets you deploy the web client without the reference server – just a lightweight CORS proxy for connecting to external OData servers from the browser.

**Better error handling.** HTTP errors are translated into human-readable explanations with the request URL, copy button, and navigation. Rate limiting (429) gets a clear message telling users to wait.

**928 tests.** Up from 856 in v0.2, with 72 new web client component tests and all 4 compliance suites passing.

**Desktop binaries available.** Pre-built installers for macOS, Windows, and Linux are attached to each [GitHub release](https://github.com/RESOStandards/reso-tools/releases). Binaries are currently unsigned – see the [release notes](https://tools.reso.org/releases/) for platform-specific instructions. The app now checks for updates automatically on launch.

---

## v0.2 – 2026-03-10

### The "There is an App for That" Release

**RESO has a desktop app.** The reference server now runs as a native application on macOS, Windows, and Linux – no terminal, no Docker, no database setup. Just launch it and start exploring RESO data. Native menus, keyboard shortcuts, trackpad gestures, and RESO-branded icons included.

**Connect to any OData server.** The new server switcher lets you point the UI at your own server (or anyone else's) and browse its data, metadata, and resources – all from the same interface. Great for vendors who want to see how their data looks through a standards-compliant lens.

**Explore your metadata.** A new Metadata Explorer lets you browse entity types, fields, navigation properties, and enumerations straight from `$metadata`. Searchable, filterable, and a lot easier than reading raw XML.

**Four-for-four on compliance.** Data Dictionary 2.0, Web API Core 2.0, Add/Edit (RCP-010), and EntityEvent (RCP-027) all pass with zero failures against PostgreSQL with human-friendly enumerations. See the [technical release notes](https://tools.reso.org/releases/) for the full scorecard.

**Browse RESO organizations.** A new Organizations page lets you browse and search the full RESO member directory – filterable by type, location, and certification status, with sortable columns, expandable detail rows showing endorsements, addresses, and certification summaries alongside an embedded map.

**The Data Dictionary site got smarter.** Sticky column headers that stay visible as you scroll through hundreds of fields. Collapsible group trees in the sidebar that sync with the content view. Click a group to jump straight to it, click again to collapse. Cross-reference links on lookup values so you can trace property type references across the dictionary. A terms and definitions glossary linked from every page. Copy-to-clipboard buttons on field and lookup details. A 404 page with real estate dad jokes. And the whole thing is mobile-optimized – sticky headers, compact sort dropdown, responsive tables, and a dark/light toggle right in the header.

**The UI got a lot more polished.** Landing page, mobile-responsive layout, advanced search, human-friendly lookup values, loading spinners, password masking, friendly error pages with helpful navigation, and a cleaner sidebar with icons – the kind of details that make the difference between a demo and a product.

---

## v0.1 – 2026-03-06

### The "Everything Under One Roof" Release

We consolidated RESO's testing and validation tools into a single open-source monorepo. One install, one place to look, one less thing to bookmark.

**The Data Dictionary has a new home.** We replaced the aging ddwiki with a searchable documentation site covering DD versions 1.7, 2.0, and 2.1 – all 27,000+ pages of fields, lookups, and definitions, complete with real-world usage stats. Check it out at [tools.reso.org/dd/](https://tools.reso.org/dd/DD2.0/).

**The reference server got a glow-up.** Sticky action buttons, better layouts, zebra-striped tables – small touches that make a big difference when you are clicking through hundreds of fields. Developers also get Docker hot-reload now, so no more rebuilding containers every time you change a line of CSS.

**EntityEvent compliance testing is live.** If your server implements RCP-027 change tracking, there is now a tool to verify it works correctly – two testing modes, eleven scenarios, and a detailed compliance report at the end. See [PR #25](https://github.com/RESOStandards/reso-tools/pull/25) for the full rundown.

**Three backends, zero schema errors.** PostgreSQL, MongoDB, and SQLite all pass DD 2.0 compliance cleanly. Details in the [technical release notes](https://tools.reso.org/releases/).
