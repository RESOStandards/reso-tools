# Project Core Principles
- **Style:** Functional & Declarative.
- **TypeScript:** ESM (`import`/`export`), strict mode enabled.
- **Goal:** Expressive, testable, immutable code.

# Coding Standards
- **Paradigm:** Use functional programming patterns (`map`, `filter`, `reduce`, `flatMap`).
- **No Classes:** Prefer functions, pure functions, and data objects. Use `interface` and `type` for data shapes.
- **Immutability:** Use `const` always; avoid `let` and `var`. Do not mutate objects/arrays. Use `Object.freeze()` when appropriate – note that it is shallow, so deep-clone nested objects before mutation. Prefer `Readonly<T>` and `ReadonlyArray<T>` in type signatures where practical.
- **Naming:** camelCase for variables/functions, PascalCase for types/interfaces, snake_case for directories.
- **Async:** Use `async/await`.
- **HTTP:** Use the native `fetch` API (Node 22+). Check `response.ok` before reading the body.
- **Linting and Formatting:** Biome, configured in `biome.json` at the repository root. Run `npm run lint` and `npm run lint:fix` from there.
- **Style**: Always use arrow functions.

# TypeScript
- Compose small, pure functions. Avoid shared mutable state.
- Use explicit return types on exported functions.
- Prefer `unknown` over `any`. Use type narrowing and type guards instead of type assertions.
- Use `.js` extensions in import paths (required for Node16 module resolution with ESM).

# Directory Structure
- `/src/test-runner` – Shared infrastructure: types, validators, HTTP client, auth, metadata, reporter, helpers.
- `/src/add-edit` – RCP-010 Add/Edit spec: scenario runner, compliance report, mock server.
- `/src/entity-event` – RCP-027 EntityEvent spec: scenario runner, compliance report, data validator, mock server.
- `/src/web-api-core` – Web API Core 2.1.0.
- `/src/data-dictionary` – Data Dictionary 2.1.
- `/src/sdk` – Public SDK surface: per-endorsement entry points, pipeline and step types, config, DD and Core version constants.
- `/src/metadata` – Metadata report generation: EDMX to `metadata-report.json`, with the optional Lookup Resource merge.
- `/src/etl` – CommonJS ETL: metadata, data-availability and Lookup Resource processing, plus the `getReferenceMetadata` chokepoint.
- `/src/variations` – DD variation detection over a metadata report, as a thin client over the backend service.
- `/src/variations-v2` – The `/compute` read path, reimplemented as a single descent.
- `/src/rcf` – RESO Common Format schema inference: a DD metadata report inferred from sampled records.
- `/src/replication` – Generic OData replication iterator: the paging loop and nothing else.
- `/src/xsd` – XSD validation of CSDL XML against the OASIS OData schemas.
- `/src/legacy` – Legacy CommonJS cert-utils: schema, DD tests, UPI, variations, replication, metadata conversion.
- `/src/cli` – Unified CLI entry point using commander.
- `/src/index.ts` – Public SDK exports.
- `/tests` – Vitest tests.
- `/sample-payloads` – Example JSON payload files for Add/Edit testing.

# Commands
- Build: `npm run build`
- Test: `npm test`
- Dev: `npm run dev`
- Typecheck: `npm run lint` (`tsc --noEmit`)
- Biome lint: `npm run lint` at the repository root

# Prohibitions
- DO NOT use classes or `this`.
- Prefer `map`, `filter`, `reduce`; `for...of` / `for await...of` is allowed when sequential async processing requires it.
- Avoid `console.log` in library code (`src/test-runner`, `src/add-edit`) – only use it in `src/cli` and mock servers.
- DO NOT use `any`. Use `unknown` and narrow with type guards.
