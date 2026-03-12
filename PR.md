# v0.2 — RESO Desktop Client and Other Improvements

## Summary

- **Electron desktop app** for macOS, Windows, and Linux — runs the reference server and UI as a native application with no Docker or database setup required
- **Server switcher** with external OData server support, Bearer token and Client Credentials OAuth2 auth, server-aware proxy, and granular per-server permissions
- **Metadata Explorer** for browsing entity types, fields, navigation properties, and enumerations from any connected server's `$metadata`
- **Organizations page** with the full RESO member directory — filterable, sortable, with expandable detail rows, endorsements, and embedded maps
- **Data Dictionary site overhaul** — sticky column headers, collapsible group tree synced with content, cross-reference links on lookup values, terms and definitions glossary, search with version filtering, landing page with version tiles
- **UI polish** — landing page, mobile responsive layout, advanced search, human-friendly lookups, loading spinners, password masking, friendly error pages, dark mode flash fix, sidebar icons
- **Monorepo restructuring** — extracted `reso-web-client/` and `reso-desktop-client/` to top-level packages (previously nested under `reso-reference-server/`)
- **Four-for-four compliance** — DD 2.0, Web API Core 2.0, Add/Edit (RCP-010), and EntityEvent (RCP-027) all pass with zero failures against PostgreSQL
- **Security** — three audits, 27 findings total, 5 fixed in this release; remaining findings tracked in GitHub issues
- **Bug fixes** — detail page summary fields, expansion card layout, search lookups, MongoDB Add/Edit, OData `$skip` handling, `ListPrice >= ListPriceLow` rule removal

## Key files

- [ANNOUNCEMENTS.md](ANNOUNCEMENTS.md) — user-facing release announcement
- [RELEASES.md](RELEASES.md) — full technical release notes with commit table
- [SECURITY_AUDIT.md](SECURITY_AUDIT.md) — three security audits (2026-03-08, 2026-03-09, 2026-03-12)

## Stats

- 223 files changed, 26,634 insertions, 4,493 deletions
- 30 commits

## Test plan

- [ ] All 856 monorepo tests pass (`npm test` from root)
- [ ] DD 2.0 compliance: 1038 passed, 0 failed (150 Property records)
- [ ] DD 2.0 compliance: 10K Property records (in progress)
- [ ] Web API Core 2.0: 42/42 passed
- [ ] Add/Edit (RCP-010): all passed
- [ ] EntityEvent (RCP-027): all passed, 1000 events validated
- [ ] Desktop client launches and serves UI (`cd reso-desktop-client && npm run dev`)
- [ ] Server switcher connects to external OData server
- [ ] DD site: sticky headers, group tree, cross-refs, terms link all functional
- [ ] GitHub Pages workflow deploys from `main` branch (updated in this PR)

## Post-merge

- [ ] Close GitHub issues: #40 (Electron Desktop App), #41/#42 (Server Switcher), #66 (Extract UI/Desktop)
- [ ] Verify GitHub Pages deployment triggers on `main`
