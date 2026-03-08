# RESO Security Audit Log

Findings are prepended newest-first. Close the linked GitHub issue when each finding is resolved.

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
- Input validation via `@reso/validation`

### Finding 1: SSRF via Proxy Endpoint — Insufficient Private Network Protection

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

**Description:** `AUTH_REQUIRED` defaults to `false`. When disabled, all requests pass through. The OData CRUD routes (POST, PATCH, DELETE) have no auth middleware even when auth IS enabled — only admin routes use `requireAuth`.

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
