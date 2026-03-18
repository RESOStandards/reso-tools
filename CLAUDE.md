# CLAUDE.md — RESO Tools

## Project overview

Open-source monorepo for building and testing RESO-compliant OData servers. Includes a reference server, desktop client, web UI, certification test runner and shared libraries.

## Packages

| Package | What it does |
|---------|-------------|
| `odata-client/` | OData 4.01 client SDK |
| `odata-expression-parser/` | `$filter` and `$expand` expression parser |
| `validation/` | Field and business-rule validation for RESO Data Dictionary |
| `data-generator/` | Test data generator with FK dependency resolution |
| `reso-reference-server/` | Metadata-driven OData reference server (PostgreSQL, MongoDB, SQLite) |
| `reso-web-client/` | React + Vite browser UI (`@reso/web-client`) |
| `reso-desktop-client/` | Electron desktop shell (`@reso/desktop-client`) |
| `certification/` | RESO certification test runner (Add/Edit, Web API Core, DD) |
| `.github/pages/` | GitHub Pages site including DD documentation generator |

## Common commands

```bash
npm test                    # Run all tests (856 across 6 packages)
npm run test:server         # Run server tests only
npm run test:validation     # Run validation tests only
npm run lint                # Biome lint check
npm run lint:fix            # Biome lint autofix

# Reference server with Docker
cd reso-reference-server && docker compose up -d
docker compose --profile seed up seed

# Desktop client (SQLite, no Docker)
cd reso-desktop-client && npm run dev

# DD documentation site
cd .github/pages/dd-generator && node generate.mjs
```

## Tech stack

- **Runtime**: Node.js >= 22, ESM throughout
- **Test framework**: Vitest (all packages)
- **Linter**: Biome
- **Pre-commit hooks**: Lefthook (runs lint, typecheck, tests)
- **UI**: React + Vite + Tailwind CSS
- **Desktop**: Electron (CJS main process, ESM child process for server)
- **Server**: Express + OData 4.01, supports PostgreSQL, MongoDB, SQLite
- **DD docs site**: Static HTML generator (Node.js), Jekyll for GitHub Pages, Pagefind for search

## Coding standards

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

## Prohibitions

- DO NOT use classes or `this`.
- DO NOT use `any`. Use `unknown` and narrow with type guards.

## Style conventions

- Chicago Manual of Style for prose, no serial comma
- Biome handles code formatting and linting
- Commit messages: imperative mood, concise first line, body for context
- No parenthetical terms in DD documentation (e.g., show "Property Resource" not "Property Resource (Res)")

## Architecture notes

- Each package manages its own `package.json` and dependencies
- Root `package.json` has convenience scripts for cross-package lint and test
- `reso-web-client` is a standalone React app that talks to any OData server via proxy
- `reso-desktop-client` spawns the reference server as a child process on a random port
- DD documentation generator reads CSV data from `.github/pages/dd-data/` and outputs static HTML to `.github/pages/dd-output/` (symlinked from `.github/pages/dd/`)
- Compliance testing requires a running server (Docker or desktop) with seeded data

## Important patterns

- The reference server uses a metadata-driven architecture: CSDL metadata defines the schema, and routes/queries are generated dynamically
- The OData client handles URI building, CRUD, pagination, and metadata parsing — it's used by both the web UI and the certification runner
- Validation rules are isomorphic (shared between client and server)
- The DD docs generator embeds CSS and JS inside `getPageCSS()` and `getPageJS()` functions in `generate.mjs` — all styling changes happen there, not in separate files
