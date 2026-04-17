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
- **Pre-commit hooks**: Lefthook (runs lint, typecheck, tests)
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

## Timing and Delays

- NEVER use `setTimeout`, `setInterval`, or timing-based delays to fix race conditions or synchronization issues. These are hacks that mask the real problem.
- If events arrive out of order, fix the ordering mechanism or make the consumer tolerant of any order — don't add delays.

## Prohibitions

- DO NOT use classes or `this`.
- DO NOT use `any`. Use `unknown` and narrow with type guards.
- Use named constants for repeated string literals (endorsement types, status values, environment URLs, step names). Define them in a shared constants file rather than duplicating across components.
- Prefer interfaces over implementations — when multiple data sources produce similar shapes, define a normalized interface and map to it rather than handling each shape ad hoc.
- Always remove dead code when disabling a feature. If removal effort is high, ask first and open a ticket instead of leaving dead code with comments.

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
