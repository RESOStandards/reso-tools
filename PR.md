## v0.1 — UI Polish, Developer Experience, and Compliance Fixes

First milestone release focusing on UI improvements, developer workflow enhancements, GitHub Pages documentation, and compliance test fixes.

### UI Improvements

- **Pin action buttons to bottom of Add/Edit pages (#20)** — Submit buttons now stay visible via `sticky bottom-0` as users scroll through long forms. Pinned header with back navigation and page title at the top.
- **Fix detail page layout** — Restored side-by-side summary + media carousel using flexbox (`lg:flex-row`). Field groups now render in two columns instead of one.
- **Zebra striping on Related Records** — Alternating row backgrounds in expanded navigation property panels for improved readability.

### Developer Experience

- **Docker hot-reload dev mode** — New `docker-compose.dev.yml` overlay runs the Vite dev server inside Docker with source volume mounts. Edits to `ui/src/` are reflected instantly without container rebuilds.
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
  ```
- **Smart Vite proxy routing** — Rewrote `vite.config.ts` to mirror the nginx routing logic: bare resource paths (e.g., `/Property`) serve the SPA on browser navigation but proxy to the API for `fetch()` requests (`Accept: application/json`). Fixes the JSON-on-refresh bug in dev mode.

### Documentation & Infrastructure

- **RESO-branded GitHub Pages site** — Jekyll site in `.github/pages/` with custom layout matching certification.reso.org design (navy header, card-based content, green/blue badges). GitHub Actions workflow auto-syncs package READMEs into the site on every push to main.

### Compliance Fixes

- **Fix DD 2.0 schema validation errors** — Navigation properties (`HistoryTransactional`, `SocialMedia`) were leaking as empty arrays in MongoDB Property responses. Excluded `isExpansion` fields from collection field coercion.
- **Fix SQLite readonly database** — Created `/data` directory with correct ownership in Dockerfile for non-root user.
- **Fix Add/Edit compliance entrypoint** — Added `add-edit` subcommand after certification package consolidation.
- **All three backends** (PostgreSQL, MongoDB, SQLite) pass DD 2.0 with 0 schema validation errors.

### Commits

| SHA | Description |
|-----|-------------|
| 38dfa81 | Pin action buttons to bottom of Add/Edit pages (#20) |
| 295fcd0 | Fix detail page layout: side-by-side summary + media, two-column field groups |
| 970359c | Add zebra striping to Related Records expanded panels |
| 9c31c5b | Add Docker hot-reload dev mode and fix Vite SPA proxy routing |
| 408d3d6 | Add RESO-branded GitHub Pages site with auto-synced package docs |
| 1904b71 | Fix DD 2.0 schema validation errors and SQLite readonly issue |

### Test Plan

- [x] Verify Add/Edit pages: submit button stays pinned at bottom when scrolling
- [ ] Verify detail page: media carousel appears beside summary on large screens
- [ ] Verify detail page: field groups render in two columns
- [ ] Verify Related Records: zebra stripes visible on expanded panels
- [ ] Verify hot reload: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` starts Vite dev server, source changes reflect immediately
- [ ] Verify SPA routing: refreshing `/Property` in browser serves the React app, not JSON
- [x] DD 2.0 compliance: PostgreSQL (0 errors, exit 0)
- [x] DD 2.0 compliance: MongoDB (0 errors, exit 0)
- [x] DD 2.0 compliance: SQLite (0 errors, exit 0)
- [x] Web API Core 2.0.0: PostgreSQL (42 passed, 3 skipped, 0 failed)
- [ ] Verify GitHub Pages deploys correctly after merge to main
