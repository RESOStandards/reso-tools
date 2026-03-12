# RESO Tools — Announcements

---

## v0.2 — 2026-03-10

### The "There's an App for That" Release

**RESO has a desktop app.** The reference server now runs as a native application on macOS, Windows, and Linux — no terminal, no Docker, no database setup. Just launch it and start exploring RESO data. Native menus, keyboard shortcuts, trackpad gestures, and RESO-branded icons included.

**Connect to any OData server.** The new server switcher lets you point the UI at your own server (or anyone else's) and browse its data, metadata, and resources — all from the same interface. Great for vendors who want to see how their data looks through a standards-compliant lens.

**Explore your metadata.** A new Metadata Explorer lets you browse entity types, fields, navigation properties, and enumerations straight from `$metadata`. Searchable, filterable, and a lot easier than reading raw XML.

**Four-for-four on compliance.** Data Dictionary 2.0, Web API Core 2.0, Add/Edit (RCP-010), and EntityEvent (RCP-027) all pass with zero failures against PostgreSQL with human-friendly enumerations. See the [technical release notes](RELEASES.md) for the full scorecard.

**Browse RESO organizations.** A new Organizations page lets you browse and search the full RESO member directory — filterable by type, location, and certification status, with sortable columns, expandable detail rows showing endorsements, addresses, and certification summaries alongside an embedded map.

**The Data Dictionary site got smarter.** Sticky column headers that stay visible as you scroll through hundreds of fields. Collapsible group trees in the sidebar that sync with the content view. Click a group to jump straight to it, click again to collapse. Cross-reference links on lookup values so you can trace property type references across the dictionary. A terms and definitions glossary linked from every page. And it all works on mobile.

**The UI got a lot more polished.** Landing page, mobile-responsive layout, advanced search, human-friendly lookup values, loading spinners, password masking, friendly error pages with helpful navigation, and a cleaner sidebar with icons — the kind of details that make the difference between a demo and a product.

---

## v0.1 — 2026-03-06

### The "Everything Under One Roof" Release

We consolidated RESO's testing and validation tools into a single open-source monorepo. One install, one place to look, one less thing to bookmark.

**The Data Dictionary has a new home.** We replaced the aging ddwiki with a searchable documentation site covering DD versions 1.7, 2.0, and 2.1 — all 27,000+ pages of fields, lookups, and definitions, complete with real-world usage stats. Check it out at [tools.reso.org/dd/](https://tools.reso.org/dd/DD2.0/).

**The reference server got a glow-up.** Sticky action buttons, better layouts, zebra-striped tables — small touches that make a big difference when you're clicking through hundreds of fields. Developers also get Docker hot-reload now, so no more rebuilding containers every time you change a line of CSS.

**EntityEvent compliance testing is live.** If your server implements RCP-027 change tracking, there's now a tool to verify it works correctly — two testing modes, eleven scenarios, and a detailed compliance report at the end. See [PR #25](https://github.com/RESOStandards/reso-tools/pull/25) for the full rundown.

**Three backends, zero schema errors.** PostgreSQL, MongoDB, and SQLite all pass DD 2.0 compliance cleanly. Details in the [technical release notes](RELEASES.md).
