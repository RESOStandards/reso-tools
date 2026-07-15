# CLAUDE.md – RESO Tools

## Project Overview

Open-source monorepo for building and testing RESO-compliant OData servers. Includes a reference server, desktop client, web UI, certification test runner and shared libraries.

## Packages

| Package | What it does |
|---------|-------------|
| `reso-client/` | OData 4.01 client SDK |
| `odata-expression-parser/` | `$filter` and `$expand` expression parser |
| `reso-validation/` | Field and business-rule validation for RESO Data Dictionary |
| `reso-data-generator/` | Test data generator with FK dependency resolution |
| `reso-reference-server/` | Metadata-driven OData reference server (PostgreSQL, MongoDB, SQLite) |
| `reso-web-client/` | React + Vite browser UI (`@reso/web-client`) |
| `reso-desktop-client/` | Electron desktop shell (`@reso/desktop-client`) |
| `reso-certification/` | RESO certification CLI + SDK (Add/Edit, EntityEvent, Web API Core, DD) |
| `reso-mcp-server/` | MCP server for AI agents (query, metadata, validate, compliance) |
| `.github/pages/` | GitHub Pages site including DD documentation generator |

## Common Commands

```bash
npm test                    # Run all tests (1,097 across 8 packages)
npm run test:server         # Run server tests only
npm run test:validation     # Run validation tests only
npm run lint                # Biome lint check
npm run lint:fix            # Biome lint autofix
npm run typecheck           # tsc --noEmit across all packages
npm run precommit           # Lint + typecheck + tests — REQUIRED before every commit

# Reference server with Docker
cd reso-reference-server && docker compose up -d
docker compose --profile seed up seed

# Desktop client (SQLite, no Docker)
cd reso-desktop-client && npm run dev

# DD documentation site (separate repo)
# See https://github.com/RESOStandards/reso-data-dictionary-documentation
```

## Tech Stack

- **Runtime**: Node.js >= 22, ESM throughout
- **Test framework**: Vitest (all packages)
- **Linter**: Biome
- **UI**: React + Vite + Tailwind CSS
- **Desktop**: Electron (CJS main process, ESM child process for server)
- **Server**: Express + OData 4.01, supports PostgreSQL, MongoDB, SQLite
- **DD docs site**: Migrated to separate repo (`reso-data-dictionary-documentation`)

## Coding Standards

- **Paradigm**: Functional and declarative. Use `map`, `filter`, `reduce`, `flatMap`.
- **Immutability**: Use `const` always. Avoid `let` and `var`. Do not mutate objects/arrays. Prefer `Readonly<T>` and `ReadonlyArray<T>`.
- **Functions**: Always use arrow functions. Compose small, pure functions. Avoid shared mutable state.
- **Naming**: camelCase for variables/functions, PascalCase for types/interfaces.
- **Async**: Use `async/await`. Use the native `fetch` API (Node 22+).

## TypeScript

- ESM (`import`/`export`), strict mode enabled throughout.
- Compose small, pure functions. Avoid shared mutable state.
- Use explicit return types on exported functions.
- Prefer `unknown` over `any`. Use type narrowing and type guards instead of type assertions.
- Use `.js` extensions in import paths (required for Node16 module resolution with ESM).
- **Optional chaining and nullish coalescing**: prefer `a?.b?.c` and `x ?? fallback` over `a && a.b && a.b.c` or `x || fallback`. `??` is correct for "missing" (null/undefined); `||` is only right when zero/empty-string/false should also fall back, which is usually a bug waiting to happen. Apply to property access, method calls (`fn?.()`), and array indexing (`arr?.[0]`).
- **State management (HIGH PRIORITY):**
  1. **Inside closures** (reduce, map, flatMap) — local mutable state is fine. It is scoped and dies with the closure. Never leak it out.
  2. **Function results** — bind to `const` on the RHS of an arrow function. No `let` unless absolutely necessary (justify it). No refs in the output.
  3. **Return an interface** when the result will be reused — documents the contract and makes it promotable to DI later without changing consumers. Cheapest abstraction, never premature.
  4. **DI service** — only when two or more callees need shared state with updates between them. Do not build the service until you actually have that need. Local to the package until reused across packages, then promote.

## New Dependencies

Before adding any new dependency, run a security audit:
- `npm audit` for known vulnerabilities
- Check license (MIT or GPL-2.0 preferred)
- Check weekly downloads and maintenance activity (last publish date)
- Check dependency count (prefer zero or minimal transitive deps)
- For native/WASM modules: verify cross-platform compatibility (macOS, Windows, Linux) and Electron ABI compatibility

## TanStack supply-chain watch (2026-05-11)

A self-spreading npm worm hit 42 `@tanstack/*` packages on
2026-05-11, publishing 84 malicious versions between 19:20-19:26 UTC
([postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem),
[GHSA-g7cv-rxg3-hmpx](https://github.com/advisories/GHSA-g7cv-rxg3-hmpx)).
Our only TanStack dep is `@tanstack/react-virtual@3.13.24` in
`reso-web-client`, which falls under the postmortem's
confirmed-clean `@tanstack/virtual*` family.

- The dependency is pinned (no caret) as defense-in-depth so a
  future compromise of the same package can't auto-resolve into our
  build via `npm install`.
- Before bumping the pinned version, **re-check the advisory and
  postmortem** for additional affected releases and confirm the
  target version is in a confirmed-clean family. If you're not
  certain, ask before bumping.
- If we add any new `@tanstack/*` dependency, same rule — verify the
  exact version against the latest advisory data and pin.

## Timing and Delays

- NEVER use `setTimeout`, `setInterval`, or timing-based delays to fix race conditions or synchronization issues. These are hacks that mask the real problem.
- If events arrive out of order, fix the ordering mechanism or make the consumer tolerant of any order — don't add delays.

## Prohibitions

- DO NOT use classes or `this`.
- DO NOT use `any`. Use `unknown` and narrow with type guards.
- Use named constants for repeated string literals (endorsement types, status values, environment URLs, step names). Define them in a shared constants file rather than duplicating across components.
- Prefer interfaces over implementations — when multiple data sources produce similar shapes, define a normalized interface and map to it rather than handling each shape ad hoc.
- Always remove dead code when disabling a feature. If removal effort is high, ask first and open a ticket instead of leaving dead code with comments.
- For new code, do not ignore compiler, linter, or bundler warnings. Fix them. If a build produces many warnings, summarize the classes at a high level and prompt before proceeding — don't silently accept them. Legacy code paths (e.g. `src/legacy/`) are the exception: flag them, leave them, and capture in a cleanup ticket if worth tracking.

## Style Conventions

- Chicago Manual of Style for prose, no serial comma
- Biome handles code formatting and linting
- Commit messages: imperative mood, concise first line, body for context
- No parenthetical terms in DD documentation (e.g., show "Property Resource" not "Property Resource (Res)")

## Architecture Notes

- Each package manages its own `package.json` and dependencies
- Root `package.json` has convenience scripts for cross-package lint and test
- `reso-web-client` is a standalone React app that talks to any OData server via proxy
- `reso-desktop-client` spawns the reference server as a child process on a random port
- DD documentation site lives in a separate repo (`RESOStandards/reso-data-dictionary-documentation`), not in this monorepo
- Compliance testing requires a running server (Docker or desktop) with seeded data

## Release Workflow

### Version Branches
- All work done in version branches named `vX.Y` (e.g., `v0.5`)
- GitHub milestones match the branch version
- **Release tags**: Use short-form tags (`v0.8`, `v0.9`) until real patch releases ship in production. Package.json versions use full SemVer (`0.8.0`), but Git tags and GitHub Releases use short form so `/releases/tag/v0.8` works.

### Merge Strategy

The GitHub repo merges PRs with **Rebase and merge** — the trunk stays linear, with no merge commits. Keep feature branches linear so they remain rebaseable:

- **To update a feature branch against its base, rebase it** (`git rebase origin/<base>`, e.g. `origin/v1.0.0-pre`) — do **not** merge the base into the branch. A merge commit on the branch makes the PR un-rebaseable, and GitHub reports "This branch cannot be rebased due to conflicts" even when an ordinary merge would be a clean fast-forward.
- Conflict resolution captured inside a merge commit is **not** reused by rebase: rebase replays each commit individually, so it re-hits the original conflicts. That is the failure mode, not a real conflict.
- If a branch already carries a merge commit, **linearize it** before opening/updating the PR — cherry-pick or rebase the real commits onto the base tip, drop the merge commit, resolve conflicts once, then force-push. (Force-push a feature branch only; never a release branch.)

### Release Checklist

1. **Run full test suite**: `npm test` from root – all packages must pass
2. **Security audit**: Review changes for injection, auth bypass, data leakage
3. **Bump versions**: Update `version` in all package.json files and MCP server config. Use strict SemVer.
4. **Update RELEASES.md**: Add all changes under the version heading. This is the canonical changelog – memory and READMEs reference it, not the other way around.
5. **Update READMEs**: Test counts, new features, CLI examples, package table in root README. Cross-check against RELEASES.md.
6. **Update test badge**: `![Tests](https://img.shields.io/badge/tests-XXXX%20passed-brightgreen)` in root README
6. **Desktop client**:
   - Update `version` in `reso-desktop-client/package.json` (the About dialog reads it via `app.getVersion()` automatically – do not hardcode)
   - Pick a release name and update the `RELEASE_NAME` constant in `reso-desktop-client/src/main.ts` (search for the comment block above `setAboutPanelOptions`)
   - Rebuild web client: `cd reso-web-client && npm run build`
7. **Create PR**: `gh pr create --base main --head vX.Y --title "vX.Y – Release Name"`
8. **Create draft release**: `gh release create vX.Y --draft --target vX.Y --title "vX.Y – Release Name"`
   - Include: highlights, what changed, download instructions, migration guide link
   - Desktop download instructions for unsigned binaries (macOS xattr, Windows SmartScreen, Linux chmod)
9. **Merge PR**: After review, merge to main
10. **Tag**: The release workflow triggers on tag push, builds desktop binaries, and attaches them
11. **Publish release**: Remove draft status after binaries are attached

### File Naming
- `schema-validation-settings.json` – committee-approved, NEVER modify
- `server-metadata.json` – generated from DD XLSX, do not hand-edit
- Reference metadata in `reso-certification/reference-metadata/dd-{version}.json`

## Important Patterns

- The reference server uses a metadata-driven architecture: CSDL metadata defines the schema, and routes/queries are generated dynamically
- The OData client handles URI building, CRUD, pagination, and metadata parsing – it is used by both the web UI and the certification runner
- Validation rules are isomorphic (shared between client and server)
- The DD docs site is in a separate repo — see `RESOStandards/reso-data-dictionary-documentation` for styling and generator code

## DD Reference-Metadata Regeneration

> **As of 2026-06-22, generation moved to transport; reso-tools now CONSUMES the JSON.** The DD reference tooling (XLSX → `dd-{ver}.json` generation, linting, fitness checks) lives in `RESOStandards/transport` at `references/dd/tools/` (all-Python/openpyxl); its `generate-dd-json` workflow regenerates `references/dd/json/dd-{ver}.json` on every sheet change. To refresh reso-tools' reference metadata from transport:
>
> ```bash
> npm run update:dd-reference   # fetch dd-{ver}.json from transport main, then run the cert tests
> ```
>
> That runs `reso-certification/utils/fetch-dd-reference.mjs`, which writes **`reso-common/reference-metadata/`** — the single source of truth. The cert pipeline (the `getReferenceMetadata`/`getMetadata` chokepoints in `src/etl`, feeding the DD gate, variations, ETL, schema and legacy) reads it via reso-common's `reference-metadata/*` subpath export (kept out of reso-common's browser-facing main index so the web client isn't bloated). The fetch also writes a synced copy at `reso-certification/reference-metadata/` still read by the desktop client (electron-builder `extraResources` + dev path) and two cert tests — retire that copy once they repoint to reso-common (the Phase A tail; see reso-tools #217 for the ref-server Phase B). NOTE: the ref server's `reso-reference-server/server-metadata.json` is a *separate* DD-2.0 served-schema artifact, not updated here. The historical reso-tools-side generation workflow below is retained for reference; the live tooling is in transport.

When DD sheets get a new revision, **transport** regenerates `dd-{ver}.json` (its `generate-dd-json` workflow) and reso-tools pulls the result via `npm run update:dd-reference` (above). Generation, linting, and fitness checks all run in transport now — the subsections below describe that workflow (which moved out of reso-tools) and how reso-tools consumes its output. This happens roughly once per DD update.

### Source of truth

- DD sheet PRs land in `RESOStandards/transport`, typically as an issue with the new XLSX attached (e.g. transport#198). Authoritative copies live at `transport/references/dd/RESODataDictionary-{ver}.xlsx` on `main`.
- The DD docs site (`reso-data-dictionary-documentation`) pulls those same files via `fetch-data.mjs` for HTML output. We pull them directly for JSON generation.

### Historical generation workflow — moved to transport

> The two scripted steps below (XLSX lint + JSON generation) used to run in reso-tools. They now live in transport's `references/dd/tools/` (all-Python/openpyxl) and run in its `generate-dd-json` workflow — **do not run them against reso-tools**; refresh via `npm run update:dd-reference` instead. They are kept here only as a description of what transport's workflow does. The one rule that outlives the move: DD XLSX write-back is **openpyxl only, never SheetJS**.

The DD update workflow has two scripted steps that run on every refresh, on any version:

1. **Lint the XLSX** — `reso-certification/utils/lint-dd-sheet.py` (Python + openpyxl) deterministically rewrites the dd.reso.org URLs on every row, on every refresh. The published XLSX sheets historically carried legacy `ddwiki.reso.org` Confluence URLs and inconsistent `dd.reso.org` shapes. The lint script forces all hyperlinks and `WikiPageUrl` cells to the canonical pattern in code rather than maintaining them by hand or by Excel formula (formulas were tried before and bloated the file too much).

   **Tooling: openpyxl, not SheetJS.** SheetJS write-back strips cell formatting, comments, and merged-cell layout and roughly doubles the XLSX size. openpyxl preserves all of those and usually shrinks the file slightly. Never use SheetJS to write a DD sheet back out.

   Six targets per row (cell value and/or hyperlink, both pointing to the same canonical URL):

   | Tab | Column | Update | Canonical URL |
   |---|---|---|---|
   | Fields | `ResourceName` | hyperlink only | `/DD{ver}/{ResourceName}/` |
   | Fields | `StandardName` | hyperlink only | `/DD{ver}/{ResourceName}/{StandardName}/` |
   | Fields | `WikiPageUrl` | value + hyperlink | `/DD{ver}/{ResourceName}/{StandardName}/` |
   | Lookups | `LookupName` | hyperlink only | `/DD{ver}/lookups/{LookupName}/` |
   | Lookups | `StandardLookupValue` | hyperlink only | `/DD{ver}/lookups/{LookupName}/{encodeURIComponent(StandardLookupValue)}/` |
   | Lookups | `WikiPageUrl` | value + hyperlink | same as above |

   Note: the lookup-value URL uses `StandardLookupValue` (URL-encoded display name), not `LegacyODataValue` — the live dd.reso.org routes match the display-name shape. `WikiPageTitle` and `LegacyODataValue` columns are left untouched.

   Setup once (venv kept out of git):
   ```bash
   cd reso-certification
   python3 -m venv .venv-dd-lint
   .venv-dd-lint/bin/pip install openpyxl
   ```

   Run per refresh:
   ```bash
   for v in 1.7 2.0 2.1; do
     reso-certification/.venv-dd-lint/bin/python reso-certification/utils/lint-dd-sheet.py path/to/RESODataDictionary-$v.xlsx $v
   done
   ```

   Expected output is ~0.81-0.84× the publisher's original (openpyxl trims unused metadata).

2. **Generate reference-metadata JSON** — `reso-certification/utils/generate-reference-metadata.js` reads the linted XLSX and writes the same JSON shape as the Commander's MetadataReport (`resources`, `models`, `fields`, `lookups`, `actions`, `functions`). It is the source for the validation refs consumed across the cert stack.

   ```bash
   node reso-certification/utils/generate-reference-metadata.js path/to/dd-{ver}.xlsx {ver} reso-certification/reference-metadata/dd-{ver}.json
   ```

   Repeat for each version. Also copy/regenerate into `reso-certification/src/etl/reference-metadata/` — both locations are read by different consumers.

After both steps, open a PR on `RESOStandards/transport` with the linted XLSX files committed to `references/dd/`. The dd-docs site picks them up via `repository_dispatch` from transport and rebuilds.

### Lint pass after generation

Always diff the new JSON against the previous one and reconcile against the issue's changelog. Counts shifting by more than the listed renames/additions is a smell.

```js
// Quick diff: resources, fields, lookups, plus rename detection.
const key = f => f.resourceName + '.' + f.fieldName;
const aF = new Set(a.fields.map(key)), bF = new Set(b.fields.map(key));
const added = [...bF].filter(x => !aF.has(x));
const removed = [...aF].filter(x => !bF.has(x));
```

Watch for:

- Renames listed in the PR show up cleanly (one add + one remove per rename, names match exactly).
- New `SourceResource` entries on expansion fields actually populate `sourceResource` on the generated record.
- Resource count: deltas should match the PR. A drop with no PR mention is usually a stray `https://ddwiki.reso.org/...` row being filtered out — that is cleanup, not regression.
- Silent field removals (not in the PR changelog) deserve a callout back to whoever updated the sheet.

### Where the JSON ends up consumed

| Consumer | Path | Note |
|---|---|---|
| **Single source** | `reso-common/reference-metadata/dd-{ver}.json` | Written by `fetch-dd-reference.mjs`; the cert pipeline reads it via reso-common's `reference-metadata/*` subpath export |
| reso-tools cert runner + ETL | *(via the reso-common subpath)* | `getReferenceMetadata`/`getMetadata` in `src/etl` resolve to reso-common; feed the DD gate, variations, ETL, schema, legacy |
| Desktop client + 2 cert tests | `reso-certification/reference-metadata/dd-{ver}.json` | Synced copy (electron-builder `extraResources` + dev path); retire after the Phase A tail (#217) |
| Ref server | `reso-reference-server/server-metadata.json` | *Separate* DD-2.0 served-schema artifact — NOT updated here (Phase B, #217) |
| Cert backend `validateBatch` | `reso-certification-backend/aws/lambda-layers/reso-dd-reference/data/dd-{ver}.json` | Independent; needs a separate layer publish to take effect on QA/prod |
| Legacy `getReferenceMetadata` lambda | `aws/lambda-functions/getReferenceMetadata/reference-metadata/dd-{ver}.json` | Independent; update if still in active use |

The backend layer copies are independent of this repo — bumping refs here does not affect server-side `validateBatch` until the `reso-dd-reference` layer is republished.

## Pre-publish review

Non-trivial PRs against the DD reference data path — `reso-certification/utils/generate-reference-metadata.js`, the `dd-{ver}.json` files in `reference-metadata/` and `src/etl/reference-metadata/`, the principles doc at `reso-certification/docs/dd-reference-fitness-principles.md`, or the fitness checker at `reso-certification/utils/check-dd-reference-fitness.js` — are reviewed against codified invariants before they reach the cert backend's publish gate. The review applies refute-by-default precision against a private library of review patterns. The patterns themselves are RESO review IP and live in a separate private location; this CLAUDE.md does not reproduce them.

PR authors don't need to invoke the review themselves; it runs on the maintainer side before merge. The **most useful upstream signal** the review benefits from is a clear PR body that:

- Links the upstream XLSX change (transport ticket or transport PR).
- Lists per-tab deltas matching the JSON diff magnitudes.
- Identifies any documented version-rename when cross-version FK targets diverge.
- States explicitly when the generator (`generate-reference-metadata.js`) is touched and why (refactor / new column projection / structural fix).

A PR body in that shape lets the review focus precisely. The fitness principles doc enumerates what the projection must satisfy; the review enforces those plus intent-drift signals the runtime tests cannot see.

## DD Docs URL Conventions

Documentation site: https://dd.reso.org/

### Four canonical element URLs

- **Resource** — `/DD{version}/{ResourceName}/`
- **Field** — `/DD{version}/{ResourceName}/{FieldName}/`
- **Lookup (enum)** — `/DD{version}/lookups/{LookupName}/`
- **Lookup Value** — `/DD{version}/lookups/{LookupName}/{LookupValue}/`

Rules:
- URL-encode path segments containing spaces or special characters (e.g. `Public Sewer` → `Public%20Sewer`).
- `{LookupName}` in lookup paths is the enum/lookup name (typically the field name, but not always — some lookups are shared across fields).
- `{version}` is the DD version short form, e.g. `2.0`, `2.1`.

### Other pages

- Version landing pages (`/DD{version}/`)
- Payload pages

For these or anything else, consult the current dd.reso.org structure directly rather than inventing a pattern.

### In code

The legacy URL builder is [`getDDWikiUrl`](reso-certification/src/legacy/lib/variations/index.js) (`src/legacy/lib/variations/index.js`). When generating DD URLs in new code, match the four canonical shapes above exactly — do not invent alternate layouts like `/{Resource}/{Field}/{LookupValue}/`.
