# RESO Security Audit Log

Findings are prepended newest-first. Close the linked GitHub issue when each finding is resolved.

---

## Certification 0.12.3 Security Notes – 2026-11-12

Pre-publish review of `@reso-standards/reso-certification` 0.12.3, covering every change since 0.12.2: the
`apply-variation-decisions` command, which applies a sheet of RESO's actions and comments to a variations review
already open, its check of the review pool, Web API Core's choice of resources and its type coverage rule, and
`fast-xml-parser` 5.12.0.

### Findings Addressed

- **`fast-xml-parser` 5.11.2** carried [GHSA-474x-hrwr-fgx4](https://github.com/advisories/GHSA-474x-hrwr-fgx4)
  (low): quadratic CPU use while scanning unterminated stop-node tags. 5.12.0 fixes it. The lockfile change moves
  `fast-xml-parser` and `fast-xml-builder` only, and adds or removes no package.

### Checked and Clean

- **Where the token goes:** the command mints its token with the existing client credentials exchange and sends it
  only to `RESO_SERVICES_URL`, which accepts HTTPS, or plain HTTP on a loopback address only.
- **What it reads and writes:** it reads the review (`GET` on the report) and the review pool (`GET` on the review
  items), and writes with one `POST`: a merge that names only the items on the sheet and never asks to replace the
  review. Every row must match an item on the review or nothing is sent. `--dry-run` sends nothing.
- **A locked review is left alone:** when someone holds the review, the command says who and stops. Nothing is
  retried.
- **Output:** the command prints the names of the variables it read from `.env`, never their values.
- **Which resources Core requests:** with none named, the names come from the server's own metadata and only those the
  Data Dictionary defines are requested, so a name the server makes up never reaches a request URL. A named resource
  goes into the URL as before. The run makes more requests to the provider's server than before, one sample per
  resource it tests, within the existing run deadline.
- **Package contents:** `npm pack --dry-run` lists 570 files under the `files` allowlist, twelve more than 0.12.2 (the
  compiled `apply` modules, and `web-api-core/provided-types`): no tests, fixtures, environment files or credentials.
- **Supply chain:** `npm audit --omit=dev` across the repository still reports `zod`
  ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high) and `@hono/node-server`
  ([GHSA-qv5m-9pm6-hqp3](https://github.com/advisories/GHSA-qv5m-9pm6-hqp3),
  [GHSA-jpvv-r467-5p4w](https://github.com/advisories/GHSA-jpvv-r467-5p4w), moderate). Both reach the repository only
  through the MCP server's `@modelcontextprotocol/sdk`; neither is a dependency of this package or of the desktop
  app. They are fixed with the MCP server's update, where `zod` moves to a new major version.

### Method

Review of every change since 0.12.2 against the built package: `npm audit`, `npm pack --dry-run` with a scan of the
listed files, the full test suite (3,511 tests across 8 packages, 2,378 in this package), and the command run end to
end against a local instance of the certification services: a dry run, a save, a re-run that changed nothing, and a
review-pool row put right after a comment-only save had cleared it.

---

## Certification 0.12.2 Security Notes – 2026-11-11

Pre-publish review of `@reso-standards/reso-certification` 0.12.2, covering every change since 0.12.1: a Data Dictionary sample limit of 100,000 or more now certifies, and a cloud run started from such a run carries the limit; `restore` publishes a run's stored results; `restore` and `archive-report` exchange `CLIENT_SECRET` for a token instead of presenting it; and the token exchange and `restore` no longer follow an HTTP redirect.

### Findings Addressed

- **`CLIENT_SECRET` was presented as a credential.** In 0.12.1, `restore` and `archive-report` sent it to the Cert API as the credential on their requests. They now exchange it at the token endpoint of the Cert API they call and present the token that returns, so the secret goes on one request only.
- **A redirect from the token endpoint was followed, secret included.** In 0.12.1 the client credentials exchange, which every command that mints a token uses, followed an HTTP redirect. A 307 or 308 keeps the method and the body, so a redirect would have carried `CLIENT_ID` and `CLIENT_SECRET` to whatever host it named. The exchange and `restore`'s posts now refuse a redirect and report it, as `archive-report` already did. Neither token path a credentials file names (`/api/v1/oauth/token`, and `/api/v1/oauth2/token` in older files) redirects, so no working exchange depended on following one.

### Checked and Clean

- **The limit rule fails closed:** one function decides it (`isDDLimitBelowDefault`), and the verdict, the `--limit` refusal and the cloud run refusal all call it. Anything other than a whole number of 100,000 or more counts as below the default: zero, negatives, fractions, NaN and Infinity, and a `--limit` that is not a number.
- **The cloud entry:** the limit travels as `ddOptions.limit`, a number the configuration already held. No credential, path or host is added.
- **Supply chain:** no dependency changed since 0.12.1. `npm audit` reports one low-severity advisory published on 2026-11-10, GHSA-474x-hrwr-fgx4 in `fast-xml-parser` 5.11.2 (fixed in 5.12.0). By its own description it "needs the non-default stopNodes option", and neither XML parser in this package or in `reso-metadata-utils` sets `stopNodes`, so it does not reach either. The update to 5.12.0 follows separately.
- **Where `CLIENT_SECRET` goes:** one function sends it (`exchangeClientCredentials`), over HTTPS only, and the Cert API commands call it only when `TOKEN_URI` is the token endpoint of the Cert API the command calls. A `TOKEN_URI` on another host, or on a host that cannot be the API (a single-label name such as `undefined`, which older credentials files carried), is refused before any request, and `CLIENT_SECRET` without `TOKEN_URI` and `CLIENT_ID` is refused rather than sent. Every Cert API secret in the environment is registered for masking before the command does anything else.
- **What `restore` publishes:** only a Data Dictionary run that passed and is certifiable, so a failed result cannot replace a provider's standing passed report. The provider and recipient come from the stored directory layout, never from a flag.
- **Package contents:** `npm pack --dry-run` lists 558 files under the `files` allowlist (`dist`, the license, the README, the sample metadata and the schemas): no tests, fixtures, environment files or run output. The eight added since 0.12.1 are the build output of the new `dd-sample-limit` and `restore-runs` modules.

### Method

Review of every change since 0.12.1 against the built package: `npm audit`, `npm pack --dry-run` with a scan of the listed files, the full test suite (3,458 tests across 8 packages, 2,339 in this package), lint and typecheck.

---

## Certification 0.12.1 Security Notes – 2026-11-09

Pre-publish review of `@reso-standards/reso-certification` 0.12.1, covering every change since 0.12.0: following cloud runs live (`reso-cert cloud watch` and `subscribeToCloudUpdates`), refusing certification for a run that tested no records, the `softwareVersion` stamp on reports, and documentation.

### Findings Addressed

- None. The review found nothing to fix.

### Checked and Clean

- **Live updates address:** `RESO_CLOUD_UPDATES_URL` is made `wss` before anything is sent, loopback excepted. A connection with no usable `wss` address is not attempted.
- **Live updates token:** the token travels as the second WebSocket subprotocol value, never in the address, and is asked for again on every connect. A token with characters a subprotocol cannot carry is refused rather than sent. Messages about giving up never carry it.
- **Live updates messages:** the client closes a connection whose service does not echo the subprotocol. Every message is checked against the v1 update contract (`parseCloudUpdate`, `isCloudUpdateEvent`), and anything else, or an event for another environment, is dropped and counted, never thrown or acted on.
- **Reports:** `softwareVersion` is the package's own version string. No credential, path or host is added.
- **Supply chain:** no dependency changed since 0.12.0. `npm audit` for the package reports no vulnerabilities.
- **Package contents:** `npm pack --dry-run` lists 550 files under the `files` allowlist (`dist`, the license, the README, the sample metadata and the schemas): no tests, fixtures, environment files or run output.

### Method

Review of every change since 0.12.0 against the built package: `npm audit`, `npm pack --dry-run` with a scan of the listed files, the full test suite (3,415 tests across 8 packages, 2,307 in this package), lint and typecheck.

---

## Certification 0.12.0 Security Notes – 2026-11-04

Pre-publish review of `@reso-standards/reso-certification` 0.12.0, covering every change since 0.11.5: cloud runs from `rcf` and Core, the Add/Edit actions and formats a provider chooses, the streaming RCF reader and its fingerprint, and the Core report fields. No high or medium finding. The five low findings are fixed in #420, and the three informational items are fixed on the branch that adds cloud runs for every endorsement.

### Findings Addressed

- **Temporary folder left on a failed pack** (Informational → Fixed, 551869d "Offer a cloud run at the end of every endorsement's run"): the folder packing for `--start-cloud-run` writes in is removed however the start ends, the pack refused, the upload failed or the start refused.
- **Provider token address not checked for https** (Informational → Fixed, 96e75c0 "Close two informational items of the 0.12.0 audit"): `mintProviderToken` now passes `CERT_AUTH_API_BASE_URL` through `ensureHttps`, as every other service address is, so the API key goes only over https.
- **One error path unmasked** (Informational → Fixed, 96e75c0): the line that reports an entry that stopped before producing a result is printed through `maskSecrets`, like every other line the CLI prints.
- **RCF fingerprint and a newline in a file name** (Low → Fixed, #420): the fingerprint's manifest gives each file one `<sha256>  <path>` line, so one file whose name held a newline and a second manifest line fingerprinted the same as two different files. Reproduced as a folder, a zip and a zip packed for a cloud run. A path holding a control character is now refused. The manifest's format is unchanged, so every other delivery keeps its fingerprint.
- **Add/Edit run checks threw on a malformed selection** (Low → Fixed, #420): `addEditRunProblems`, exported for services that start runs for others, threw a `TypeError` on actions or formats of the wrong shape. It now answers with reasons.
- **Cloud upload address** (Low → Fixed, #420): the upload went to whatever address the upload slot named and followed redirects, so a 307 or 308 posted the files again to the redirect target. It now goes only over https, or to a loopback address, and a redirect is refused.
- **One large RCF record held whole** (Low → Fixed, #420): the reader streams the `value` array but holds each record and each other top-level member whole. A 40 MB record raised the heap by about 83 MB. One item over 64 MiB is now refused. The record count stays unbounded.
- **Add/Edit cleanup skipped on an early stop** (Low → Fixed, #420): a key header with a malformed escape threw a `URIError` that stopped the run before its cleanup, leaving the records its earlier creates had made. Any other throw did the same. Such a header now names no record, and a run that stops early cleans up before it reports why.

### Noted Risks (Pending / Accepted)

- **Folder input follows symbolic links** (Informational → Accepted): a linked `.json` outside the folder is read and uploaded. The folder is the operator's own, and a link loop fails rather than hangs.
- **Zip entry names without the UTF-8 flag** (Informational → Accepted): such names are decoded as CP437, so a zip from a tool that does not set the flag can fingerprint differently from the same files in a folder when a name is not ASCII. No security effect.

### Checked and Clean

- **Credentials:** the upload carries no RESO credential, nothing echoes a token or secret, and the Core report names the authentication method only.
- **Paths:** the reader never writes zip entries, and absolute, `..` and backslash names are refused on read and on write.
- **Injection:** no shell, `eval` or dynamic import of input. OData literals are quoted, and path segments and queries are encoded.
- **Supply chain:** the new dependencies `yazl` 3.3.1 and `@streamparser/json` 0.0.26 are pinned exactly, MIT licensed and free of install scripts. `npm audit` reports no vulnerabilities.
- **Package contents:** `npm pack --dry-run` lists only the `files` allowlist: no tests, fixtures, environment files or run output.

### Method

Review of every change since 0.11.5: `npm audit`, `npm pack --dry-run` with a scan of the packed files, the test suite and a reproduction of each finding against the built package.

---

## v1.0.0 Security Notes – 2026-07-15

Pre-publish adversarial review of the six public npm packages ahead of the npm publish and public/private split (#220). All six are clean on the security-critical axes – zero known vulnerabilities, no secrets in shipped code, no dangerous runtime patterns. The findings below are publish hygiene and packaging mechanics.

### Findings Addressed

- **Consumer-side install hook** (High → Fixed, #230): reso-client and reso-certification shipped a `preinstall` hook (`node ../scripts/bootstrap-deps.mjs`) that ran on every consumer install and pointed at a path outside the package. Removed; clean-clone development uses the root bootstrap. The remaining hooks are removed in the workspaces migration.
- **reso-certification package leak** (High → Fixed, #220): with no `files` allowlist, `npm publish` would have shipped 661 files / 31 MB – all of `src/`, `tests/`, `coverage/`, `.reso-cert/` local run artifacts and `__pycache__/`. Added `files: ["dist"]`; the tarball is now 306 files / 3.8 MB.
- **Publish metadata** (Medium → Fixed, #220): added `license` (RESO EULA), `publishConfig.access: public`, `repository` and `prepublishOnly` to the packages that lacked them.
- **reso-common version conflict** (High → Fixed, #220): 0.1.2 was already published with different content; bumped to 0.2.0, a backward-compatible export addition.
- **`reso-certification-etl` supply chain** (High → Fixed, #220): the dependency resolved to a mutable GitHub `main` tarball with no version pin or integrity check. Rather than pin or publish it, it was **removed** – the two symbols reso-certification used (`getReferenceMetadata`, `processLookupResourceMetadataFiles`) already exist in the in-package v2 ETL (`src/etl`), so the five `src/legacy` requires repoint there and the tarball dependency is dropped. The old package stays recoverable from the `reso-certification-utils` repo.
- **`file:` dependencies** (High → Fixed, #230): reso-client and reso-certification carried `file:../` deps that cannot resolve for consumers; the workspaces migration converted them to `^` version ranges resolved from the registry.

### Noted Risks (Accepted / Pending)

- **LICENSE as EULA pointer** (Accepted): the `LICENSE` file references the RESO EULA at reso.org/eula rather than inlining full text, matching the already-published reso-common.
- **Broken sourcemaps** (Low → Pending): shipped `.js.map` files reference `../src` paths not in the tarball; to be resolved with `inlineSources` or by dropping map emission for the published build.
- **Missing or stale READMEs** (Low → Pending): reso-metadata-utils has none; reso-validation's is stale.
- **Electron advisories** (High → Pending, desktop): reso-desktop-client's Electron carries multiple advisories; the fix is a major bump (electron 43), deferred because it needs desktop ABI and build verification and ties to the desktop signing work. Surfaced by the workspaces install unifying the audit view (#230); not introduced by it. **Now tracked in `reso-tools-private`** – reso-desktop-client moved there for the v1.0.0 split, so this item and its fix belong to the private repo's audit going forward; it does not affect any published public package.
- **esbuild dev-server file read** (Low → Pending): a transitive esbuild advisory (arbitrary file read via the development server on Windows only); the fix is bundled with the same breaking bump. Development-only, low risk.

### Method

Automated adversarial per-package review, one agent per package: `npm audit`, `npm pack --dry-run`, and secret, supply-chain and dangerous-code scans over shipped output, followed by manual verification of the resolved items.

---

## v0.5 Security Notes – 2026-04-06

### Findings

- **Docker base image vulnerability** (High → Open, #98): `node:22-alpine` has 1 high, 4 medium, and 1 low vulnerability. Used in `reso-certification/Dockerfile` and `reso-reference-server/Dockerfile`. Important for deployments behind corporate firewalls. Pin to specific patched version and add image scanning to CI.
- **Legacy cert-utils local copy**: The `legacy-cert-utils/` directory contains a full copy of `reso-certification-utils@3.0.0` (CJS). This is temporary for the DD pipeline until the rewrite. The code is from a known source (RESOStandards org) but has its own transitive dependencies (`ajv`, `fast-xml-parser`, `fs-extra`, etc.) that increase the attack surface.

### Noted Risks (Accepted)

- **MCP server auth**: The MCP server accepts bearer tokens and Client Credentials via tool parameters. Tokens are passed through stdio (not network). In hosted deployments, the server should be behind an auth proxy.
- **`schema-validation-settings.json` copied to cwd**: The DD pipeline copies this file from the legacy-cert-utils package to the working directory at runtime. The file is committee-approved and read-only but the copy location is user-writable.
- **`@odata.nextLink` rebase**: The replication iterator rewrites `@odata.nextLink` hostnames to match the client's initial request URL. This is safe (only hostname/port are changed, not path/query) but could theoretically redirect to an unintended host if `initialRequestUri` is compromised.
- **DD XLSX processing**: The `xlsx` library parses untrusted XLSX files. The library is widely used but XLSX files can contain macros and embedded content. Our generator only reads cell values, not macros.

---

## v0.4 Security Notes – 2026-04-05

### Findings Addressed

- **`navigateTo` script injection** (Critical → Fixed): The `navigateTo()` function in the Electron main process constructed JavaScript strings with unescaped path parameters via template literals. Paths are now JSON-serialized before interpolation, preventing script injection through the path argument.
- **Release URL validation** (Critical → Fixed): The update checker fetches release info from the GitHub API. The `html_url` field is now validated to match `https://github.com/RESOStandards/reso-tools/releases/` before being passed to `shell.openExternal()`, preventing SSRF or malicious URL injection if the API response is compromised.

### Noted Risks (Accepted)

- **`reso-certification-utils@3.0.0` supply chain**: Installed from GitHub (not npm). Git tags are not cryptographically signed. Transitive dependency on `@reso/reso-certification-etl` also from GitHub. Risk accepted because both repos are under RESOStandards org control. _Update: the `@reso/reso-certification-etl` dependency was later removed entirely – its symbols moved to the in-package v2 ETL; see the v1.0.0 notes above._
- **IPC storage API**: The `storage:get`/`storage:set` handlers accept any key/value string from the renderer. Currently only the renderer (same-origin, sandboxed) can access these. No rate limiting. Acceptable for a desktop app with trusted renderer content.
- **EPIPE exception handler**: `process.on('uncaughtException')` suppresses EPIPE errors (broken stdout pipe on shutdown). Non-EPIPE errors are re-thrown. Could theoretically mask an error with a `code` property of `'EPIPE'` from a different source, but this is unlikely in practice.
- **Stub packages**: `pg` and `mongodb` are replaced with empty stubs in the desktop server bundle (SQLite-only mode). If the server code ever conditionally requires these at runtime, the stubs would silently return empty objects instead of throwing.
- **Unsigned binaries** (Accepted → Fixed in v1.0.0): macOS, Windows, and Linux binaries are not code-signed. macOS Tahoe requires `xattr -cr` to run. Windows shows SmartScreen warnings. Signing planned for a future release. _Update: closed in v1.0.0. Windows installers are Authenticode signed through Azure Trusted Signing, and CI fails the release unless every shipped executable carries a valid signature with the expected publisher and a timestamp. macOS builds are Developer ID signed, notarized and stapled. Linux builds remain unsigned._

### Architecture Notes

- **Electron preload API surface**: `contextBridge` exposes three APIs – `electronStorage` (get/set/remove), `electronUpdates` (onUpdateAvailable listener). All are read-only or write-only with no ability to execute arbitrary code. `contextIsolation: true` and `nodeIntegration: false` are set.
- **Dark mode preference**: Stored in Electron secure storage (encrypted via OS keychain when available, plain JSON fallback). Non-sensitive data.
- **Splash screen**: Generated as a `data:` URI with inline CSS. No external resources loaded. Images use `file:` protocol for the local logo.

---

## v0.3 Security Notes – 2026-04-03

- **OAuth2 token storage**: Per-server tokens stored in Electron secure storage (OS keychain encryption) or browser sessionStorage (cleared on tab close). Tokens are never written to localStorage.
- **CORS proxy SSRF protection**: `/api/proxy` validates that target URLs use `http:` or `https:` protocols only.
- **IndexedDB caches**: Schema and lookup caches use gzip compression. No sensitive data (tokens, credentials) is stored in IndexedDB.
- **New package**: `@reso-standards/web-api-proxy` – standalone CORS proxy with same SSRF protections as the reference server.

A full `npm audit` should be run before the v0.3 release.

---

## Audit: 2026-03-17 – v0.2 Pre-Release npm Audit

**Scope:** `npm audit` across all 9 packages
**Auditor:** Claude Opus 4.6

### Summary

| Package | Vulnerabilities | Severity |
|---------|:-:|----------|
| Root | 0 | Clean |
| reso-reference-server | 6 | 5 moderate, 1 high |
| reso-web-client | 0 | Clean |
| reso-desktop-client | 0 | Clean |
| reso-client | 1 | 1 high |
| odata-expression-parser | 0 | Clean |
| validation | 0 | Clean |
| data-generator | 0 | Clean |
| certification | 5 | 5 moderate |

### HIGH: fast-xml-parser (CVE-2026-26278) – FIXED

- **Affected packages**: reso-reference-server, reso-client
- **Versions**: 4.0.0-beta.3 – 5.5.5
- **Advisory**: [GHSA-8gc5-j5rx-235r](https://github.com/advisories/GHSA-8gc5-j5rx-235r)
- **Description**: Numeric entity expansion bypasses all entity expansion limits
- **Fix**: Updated via `npm audit fix` in both packages (2026-03-17)
- **Risk**: Used for CSDL metadata parsing. Limited exposure – metadata is from trusted sources.

### MODERATE: esbuild (dev dependency only)

- **Affected packages**: reso-reference-server, certification
- **Versions**: <= 0.24.2
- **Advisory**: [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
- **Description**: esbuild dev server allows any website to send requests and read responses
- **Fix**: Requires vitest major version upgrade (breaking change)
- **Risk**: Dev-only dependency, not present in production. No user-facing risk.

### Recommended Actions

1. Run `npm audit fix` in `reso-reference-server/` and `reso-client/` to patch fast-xml-parser
2. esbuild/vite/vitest findings are dev-only – track for next major dependency update

---

## Audit: 2026-03-12 – v0.2 Full Codebase

**Scope:** Full monorepo – all packages, Docker configs, Electron, web client, server
**Auditor:** Claude Opus 4.6

This audit covers the complete codebase as of the v0.2 release candidate. Findings from prior audits (2026-03-08, 2026-03-09) are confirmed and cross-referenced below.

### New Observations

| Area | Status |
|------|--------|
| SQL injection (all backends) | **Pass** – Parameterized queries throughout, field names validated against metadata whitelists |
| Command injection | **Pass** – No shell execution with user input; `child_process.fork()` uses fixed module paths |
| XSS | **Pass** – No `dangerouslySetInnerHTML`, `innerHTML`, `eval()`, or `new Function()` in web client |
| Committed secrets | **Pass** – No credentials in source; `.gitignore` covers `.env`, `*.env`, `*.db` |
| Electron sandbox | **Pass** – `nodeIntegration: false`, `contextIsolation: true`, external links open in system browser |
| Security headers | **Pass** – `x-powered-by` disabled, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` |
| Auth (core) | **Pass** – Timing-safe token comparison, 1-hour TTL with periodic cleanup, `crypto.randomUUID()` |

### Confirmed Prior Findings

All findings from the 2026-03-08 and 2026-03-09 audits remain valid. The five previously fixed findings (#5, #9, #12, #14, #15) are confirmed fixed in the current codebase:

- **#5** Key value interpolation – quotes escaped before filter string interpolation
- **#9** Token map memory leak – TTL and periodic sweep implemented
- **#12** Missing security headers – `nosniff`, `DENY`, `x-powered-by` disabled
- **#14** Non-constant-time token comparison – uses `crypto.timingSafeEqual`
- **#15** LIKE wildcard injection – `escapeLikeWildcards` helper with `ESCAPE '\'`

### Compliance Dockerfiles (Reiterated)

Compliance Dockerfiles (`Dockerfile.core`, `Dockerfile.dd`) still run as root. The main server and certification Dockerfiles correctly use non-root users. These containers are ephemeral test runners, not deployed services, so the practical risk is low.

---

## Audit: 2026-03-09 – v0.2 New Code

**Scope:** `reso-reference-server/desktop/`, `reso-reference-server/ui/src/` (server switcher, context, metadata adapter), server proxy changes
**Auditor:** Claude Opus 4.6

| # | Finding | Severity | Status | Area |
|---|---------|----------|--------|------|
| 17 | Bearer Tokens Stored in localStorage in Plaintext | High | Open | UI |
| 18 | No Authentication on Proxy Endpoint | High | Open | Server |
| 19 | Authorization Header Forwarded Through Proxy to Arbitrary Targets | High | Open | Server |
| 20 | No URL Scheme Validation in Server Connection Modal | Medium | Open | UI |
| 21 | Proxy Response Body Passed Through Without Sanitization | Medium | Open | Server |
| 22 | DNS Rebinding Risk on Localhost Bypass | Medium | Open | UI |
| 23 | Full process.env Passed to Child Process | Medium | Open | Desktop |
| 24 | Default Auth Tokens Not Warned at Startup | Medium | Open | Server |
| 25 | executeJavaScript with Inline Code Strings | Low | Open | Desktop |
| 26 | localStorage Config Not Validated on Parse | Low | Open | UI |
| 27 | DevTools Accessible in Production Build | Low | Open | Desktop |

### Positive Findings (v0.2)

- Electron `nodeIntegration: false` and `contextIsolation: true` correctly set
- External links open in system browser via `shell.openExternal`
- New window creation denied (`action: 'deny'`)
- External servers default to read-only permissions (`canAdd/canEdit/canDelete: false`)
- AbortController used for metadata fetch cleanup on server switch
- Query parameters properly `encodeURIComponent`-encoded in OData client
- Timing-safe token comparison retained from v0.1 fixes

### Finding 17: Bearer Tokens Stored in localStorage in Plaintext

**Severity: High**
**File:** `reso-reference-server/ui/src/context/server-context.tsx`, lines 30, 56-58

**Description:** The `ServerConfig` object (including bearer tokens) is serialized to `localStorage` under the key `reso-server-configs`. Any XSS vulnerability allows an attacker to exfiltrate all stored tokens via `JSON.parse(localStorage.getItem('reso-server-configs'))`.

**Recommended Fix:** For the Electron desktop app, use Electron's `safeStorage` API to encrypt tokens at rest. For the web version, consider storing tokens only in memory (session-lived). At minimum, document the risk.

---

### Finding 18: No Authentication on Proxy Endpoint

**Severity: High**
**File:** `reso-reference-server/server/src/index.ts`, lines 299-357

**Description:** The `/api/proxy` endpoint has no authentication check. Any unauthenticated client can use it as an open proxy, regardless of `AUTH_REQUIRED` setting. This amplifies the existing SSRF finding (#1/issue #50).

**Recommended Fix:** Apply auth middleware to the proxy endpoint. At minimum require a valid bearer token.

---

### Finding 19: Authorization Header Forwarded Through Proxy to Arbitrary Targets

**Severity: High**
**File:** `reso-reference-server/server/src/index.ts`, lines 327-329

**Description:** The proxy blindly forwards the `Authorization` header to the upstream target. If a user is authenticated and the proxy URL points to an attacker-controlled server, the user's auth token is forwarded to the attacker.

**Recommended Fix:** Only forward Authorization if the target URL matches the configured external server's baseUrl. Strip it otherwise.

---

### Finding 20: No URL Scheme Validation in Server Connection Modal

**Severity: Medium**
**File:** `reso-reference-server/ui/src/components/server-connection-modal.tsx`, lines 51-54

**Description:** URL validation uses `new URL()` which accepts `javascript:`, `file:///`, `data:`, and `ftp:` schemes. The localhost bypass in `server-context.tsx` connects directly without the proxy for matching hosts.

**Recommended Fix:** After `new URL()` parse, explicitly check that `parsed.protocol` is `'http:'` or `'https:'`.

---

### Finding 21: Proxy Response Body Passed Through Without Sanitization

**Severity: Medium**
**File:** `reso-reference-server/server/src/index.ts`, lines 346-352

**Description:** The proxy forwards upstream `Content-Type` and body verbatim. If upstream returns `text/html` with malicious JavaScript, this is a reflected XSS vector via `/api/proxy?url=https://evil.com/xss.html`. The global `X-Content-Type-Options: nosniff` header mitigates but does not fully prevent this when Content-Type is `text/html`.

**Recommended Fix:** Force `Content-Type: application/json` on proxy responses, or strip HTML content types.

---

### Finding 22: DNS Rebinding Risk on Localhost Bypass

**Severity: Medium**
**File:** `reso-reference-server/ui/src/api/client.ts`, lines 44-51

**Description:** Localhost detection checks hostname strings (`localhost`, `127.0.0.1`, `::1`) but does not account for DNS rebinding (attacker domain resolving to 127.0.0.1) or alternate representations like `0.0.0.0`.

**Recommended Fix:** Accept that the proxy path is the safe default for non-obvious localhost addresses.

---

### Finding 23: Full process.env Passed to Child Process

**Severity: Medium**
**File:** `reso-reference-server/desktop/src/main.ts`, line 193

**Description:** `env: { ...process.env }` passes the entire shell environment to the forked server child process, including any sensitive variables (AWS keys, etc.) not needed by the child.

**Recommended Fix:** Explicitly pass only the environment variables the child needs.

---

### Finding 24: Default Auth Tokens Not Warned at Startup

**Severity: Medium**
**File:** `reso-reference-server/server/src/auth/config.ts`, lines 68-73

**Description:** Default tokens (`admin-token`, `write-token`, `read-token`) with `AUTH_REQUIRED=false` are used without warning. Related to existing finding #4 (issue #53) but the proxy endpoint makes this more urgent.

---

### Finding 25: executeJavaScript with Inline Code Strings

**Severity: Low**
**File:** `reso-reference-server/desktop/src/main.ts`, lines 260-263, 269-272, 279-304

**Description:** Uses `win.webContents.executeJavaScript()` with hardcoded strings for navigation gestures. Bypasses the `contextIsolation` boundary. Risk is low since `nodeIntegration: false` and content is always from the local server.

**Recommended Fix:** Use a preload script with `contextBridge.exposeInMainWorld` and IPC instead.

---

### Finding 26: localStorage Config Not Validated on Parse

**Severity: Low**
**File:** `reso-reference-server/ui/src/context/server-context.tsx`, lines 34-44

**Description:** `loadSavedConfigs` parses JSON from localStorage and casts to `ReadonlyArray<ServerConfig>` without shape validation. Tampered localStorage could cause runtime errors.

**Recommended Fix:** Add runtime validation of parsed shape before returning.

---

### Finding 27: DevTools Accessible in Production Build

**Severity: Low**
**File:** `reso-reference-server/desktop/src/main.ts`, line 101

**Description:** The Electron menu includes `toggleDevTools` unconditionally. In packaged builds, this lets users inspect localStorage tokens and execute arbitrary JavaScript.

**Recommended Fix:** Conditionally include only when `!app.isPackaged`.

---

## Audit: 2026-03-08

**Scope:** `reso-reference-server/server/src/`
**Auditor:** Claude Opus 4.6
**Parent Issue:** [#49](https://github.com/RESOStandards/reso-tools/issues/49)

| # | Finding | Severity | Status | Issue |
|---|---------|----------|--------|-------|
| 1 | SSRF via Proxy Endpoint | Critical | Open | [#50](https://github.com/RESOStandards/reso-tools/issues/50) |
| 2 | Mock OAuth Accepts Any Credentials | Critical | Open | [#51](https://github.com/RESOStandards/reso-tools/issues/51) |
| 3 | Auth Disabled by Default; No Auth on Write Routes | High | Open | [#52](https://github.com/RESOStandards/reso-tools/issues/52) |
| 4 | Hardcoded Default Auth Tokens | High | Open | [#53](https://github.com/RESOStandards/reso-tools/issues/53) |
| 5 | Key Value Interpolated into $filter String | High | **Fixed** | [#54](https://github.com/RESOStandards/reso-tools/issues/54) |
| 6 | ReDoS via matchesPattern in SQLite | Medium | Open | [#55](https://github.com/RESOStandards/reso-tools/issues/55) |
| 7 | Regex Injection in MongoDB matchesPattern | Medium | Open | [#56](https://github.com/RESOStandards/reso-tools/issues/56) |
| 8 | No Rate Limiting on Any Endpoint | Medium | Open | [#57](https://github.com/RESOStandards/reso-tools/issues/57) |
| 9 | Dynamic Token Map Never Expires | Medium | **Fixed** | [#58](https://github.com/RESOStandards/reso-tools/issues/58) |
| 10 | Wide-Open CORS Policy | Medium | Open | [#59](https://github.com/RESOStandards/reso-tools/issues/59) |
| 11 | Information Disclosure in Error Messages | Low | Open | [#60](https://github.com/RESOStandards/reso-tools/issues/60) |
| 12 | Missing Security Headers | Low | **Fixed** | [#61](https://github.com/RESOStandards/reso-tools/issues/61) |
| 13 | Static File Serving Path Not Strictly Bounded | Low | Open | [#62](https://github.com/RESOStandards/reso-tools/issues/62) |
| 14 | Non-Constant-Time Token Comparison | Low | **Fixed** | [#63](https://github.com/RESOStandards/reso-tools/issues/63) |
| 15 | LIKE Wildcard Characters Not Escaped | Low | **Fixed** | [#64](https://github.com/RESOStandards/reso-tools/issues/64) |
| 16 | Decorative ETags (Not Content-Based) | Info | Open | [#65](https://github.com/RESOStandards/reso-tools/issues/65) |

### Positive Findings

- Parameterized SQL queries throughout
- Field name validation in filters
- MongoDB regex escaping for contains/startswith/endswith
- JSON body size limit (`10mb`), page size cap (2000), expand depth limit (3)
- Non-root Docker container
- Database credentials masked in logs
- Input validation via `@reso-standards/validation`

### Finding 1: SSRF via Proxy Endpoint – Insufficient Private Network Protection

**Severity: Critical**
**File:** `reso-reference-server/server/src/index.ts`, lines 296-354

**Description:** The `/api/proxy` endpoint validates that the URL protocol is `http:` or `https:`, but performs no validation of the target hostname or IP address. An attacker can use this endpoint to reach internal services, cloud metadata APIs, and private network resources.

**Proof of Concept:**
```
# Access AWS metadata service
GET /api/proxy?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/

# Access internal services
GET /api/proxy?url=http://localhost:5432/
GET /api/proxy?url=http://127.0.0.1:8080/admin/data-generator/status

# DNS rebinding
GET /api/proxy?url=http://attacker-rebind.example.com/

# IPv6 loopback
GET /api/proxy?url=http://[::1]:8080/health

# Redirect following
# An external URL that 302-redirects to http://169.254.169.254/ bypasses hostname checks
```

**Recommended Fix:** Resolve the hostname to IP addresses before making the request. Block RFC 1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), link-local (169.254.0.0/16), loopback (127.0.0.0/8, ::1), and cloud metadata IPs. Set `redirect: 'manual'` on the fetch call to prevent redirect-based bypass.

---

### Finding 2: Mock OAuth Accepts Any Credentials and Issues Arbitrary Roles

**Severity: Critical (if deployed with AUTH_REQUIRED=true)**
**File:** `reso-reference-server/server/src/auth/mock-oauth.ts`, lines 20-31

**Description:** The `/oauth/token` endpoint accepts any `client_id` and `client_secret` and issues a valid token. The role is controlled by a query parameter `?role=admin`, allowing any caller to self-issue an admin token.

**Proof of Concept:**
```bash
curl -X POST http://localhost:8080/oauth/token?role=admin \
  -d "grant_type=client_credentials&client_id=anything&client_secret=anything"
```

**Recommended Fix:** Document clearly that this must never be used in production. Consider disabling when `AUTH_REQUIRED=true`. Remove the `?role=` parameter override.

---

### Finding 3: Authentication Disabled by Default; No Auth on OData Write Routes

**Severity: High**
**File:** `reso-reference-server/server/src/auth/config.ts`, line 44; `middleware.ts`, lines 14-18

**Description:** `AUTH_REQUIRED` defaults to `false`. When disabled, all requests pass through. The OData CRUD routes (POST, PATCH, DELETE) have no auth middleware even when auth IS enabled – only admin routes use `requireAuth`.

**Proof of Concept:**
```bash
curl -X DELETE http://localhost:8080/Property('any-key')
curl -X POST http://localhost:8080/Property -H "Content-Type: application/json" -d '{}'
```

**Recommended Fix:** Apply `requireAuth('write', authConfig)` middleware to POST/PATCH/DELETE OData routes, and `requireAuth('read', authConfig)` to GET routes.

---

### Finding 4: Hardcoded Default Auth Tokens

**Severity: High**
**File:** `reso-reference-server/server/src/auth/config.ts`, lines 41-43

**Description:** Default tokens are `admin-token`, `write-token`, and `read-token`. If `AUTH_REQUIRED=true` is set without overriding these, the server runs with trivially guessable credentials.

**Recommended Fix:** When `AUTH_REQUIRED=true`, require that token environment variables are explicitly set. Throw an error at startup if they retain defaults.

---

### Finding 5: Key Value Interpolated into $filter String (readByKey + $expand)

**Severity: High** | **Status: Fixed** (a9e8620)
**File:** `reso-reference-server/server/src/db/postgres-dal.ts`; `sqlite-dal.ts`

**Description:** When `readByKey` is called with `$expand`, it constructs a `$filter` string by interpolating the user-supplied key value directly.

**Fix Applied:** Single quotes in key values are now escaped via `.replace(/'/g, "''")` before interpolation into the filter string.

---

### Finding 6: ReDoS via matchesPattern in SQLite

**Severity: Medium**
**File:** `reso-reference-server/server/src/db/sqlite-pool.ts`, lines 18-21

**Description:** The SQLite REGEXP function constructs a JavaScript `RegExp` from user-supplied patterns via OData `matchesPattern()`. Catastrophic backtracking patterns are not restricted.

**Proof of Concept:**
```
GET /Property?$filter=matchesPattern(City, '(a+)+$')
```

**Recommended Fix:** Use RE2 (linear-time regex engine) or limit regex pattern length/complexity.

---

### Finding 7: Regex Injection in MongoDB matchesPattern

**Severity: Medium**
**File:** `reso-reference-server/server/src/db/filter-to-mongo.ts`, lines 311-314

**Description:** `matchesPattern` passes raw regex to MongoDB's `$regex` operator without complexity validation. Same ReDoS risk as Finding 6 but on the MongoDB side.

**Recommended Fix:** Validate regex complexity or length. Reject patterns with nested quantifiers.

---

### Finding 8: No Rate Limiting on Any Endpoint

**Severity: Medium**
**File:** `reso-reference-server/server/src/index.ts`

**Description:** No rate limiting anywhere. `/api/proxy` can be used as an amplification proxy. `/oauth/token` can be spammed. Data generator can create unlimited records.

**Recommended Fix:** Add `express-rate-limit` middleware. Implement per-endpoint limits.

---

### Finding 9: Dynamic Token Map Never Expires Entries (Memory Leak)

**Severity: Medium** | **Status: Fixed** (a9e8620)
**File:** `reso-reference-server/server/src/auth/config.ts`

**Description:** The `dynamicTokens` Map grew without bound. Every `/oauth/token` call added a token that was never removed.

**Fix Applied:** Dynamic tokens now store `{ role, expiresAt }` with 1-hour TTL. Expired tokens are cleaned up lazily on lookup and via a periodic sweep every 60 seconds (`.unref()` timer).

---

### Finding 10: Wide-Open CORS Policy

**Severity: Medium**
**File:** `reso-reference-server/server/src/index.ts`, lines 190-193

**Description:** `Access-Control-Allow-Origin: *` allows any website to make requests. Likely intentional for a reference server, but negates auth protection if exposed with real data.

**Recommended Fix:** Make CORS origin configurable via environment variable.

---

### Finding 11: Information Disclosure in Error Messages

**Severity: Low**
**File:** `reso-reference-server/server/src/odata/handlers.ts`; `index.ts`, line 351

**Description:** Internal error messages (database errors, connection failures) forwarded directly to clients via `err.message`.

**Recommended Fix:** Return generic error messages to clients. Only show details when `NODE_ENV !== 'production'`.

---

### Finding 12: Missing Security Headers

**Severity: Low** | **Status: Fixed** (a9e8620)
**File:** `reso-reference-server/server/src/index.ts`

**Description:** Missing security headers and Express `X-Powered-By` not removed.

**Fix Applied:** Added `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` headers. Disabled `x-powered-by` via `app.disable('x-powered-by')`.

---

### Finding 13: Static File Serving Path Not Strictly Bounded

**Severity: Low**
**File:** `reso-reference-server/server/src/index.ts`, lines 238-239, 363-368

**Description:** Static file paths resolved relative to `serverRoot`. Express handles path traversal, but build structure changes could serve unintended files.

**Assessment:** Low risk due to Express's built-in protections.

---

### Finding 14: Non-Constant-Time Token Comparison

**Severity: Low** | **Status: Fixed** (a9e8620)
**File:** `reso-reference-server/server/src/auth/config.ts`

**Description:** Token comparison used `===` (not constant-time), theoretically allowing timing attacks.

**Fix Applied:** Added `safeTokenEquals` helper using `crypto.timingSafeEqual()` with Buffer conversion and length check.

---

### Finding 15: LIKE Wildcard Characters Not Escaped in contains/startswith/endswith

**Severity: Low** | **Status: Fixed** (a9e8620)
**File:** `reso-reference-server/server/src/db/filter-to-sql.ts`; `filter-to-sqlite.ts`

**Description:** `%` and `_` wildcard characters in user search values were not escaped before embedding in LIKE patterns.

**Fix Applied:** Added `escapeLikeWildcards` helper that escapes `%`, `_`, and `\` with backslash prefix. All LIKE/ILIKE clauses now include `ESCAPE '\'`.

---

### Finding 16: Decorative ETags (Not Content-Based)

**Severity: Info**
**File:** `reso-reference-server/server/src/odata/annotations.ts`, lines 1-2

**Description:** ETags generated from `new Date().toISOString()` base64-encoded. Not content-based, not used for concurrency control.
