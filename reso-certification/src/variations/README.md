# Variations

DD variation detection for a metadata report. Given a provider's
`metadata-report.json`, this finds where their fields, resources, lookups and
expansions *vary* from the Data Dictionary — near-misses a human reviewer would
recognize as "they meant the standard field, they just spelled it differently."

## Thin client over a backend service

The matching itself no longer runs here. The canonical + in-review blend and the
fuzzy machine matching moved server-side (reso-services-v2); this module is the
client. `computeVariationsViaService` POSTs the report to the cert-backend
`/compute` endpoint and returns the variations report. The frozen v3.0.0 local
matcher that used to live in `src/legacy/lib/variations` is being retired in
favor of this path.

Why the move: the matcher's inputs (the canonical value store and the pool of
in-review suggestions from other providers) are server-side state. Shipping them
to every client was neither current nor safe. One service, one blend, both
clients call it.

## Two entry points

- **`computeVariationsViaService(input)`** — the raw service call. Takes an
  in-memory `metadataReportJson`, returns the report. Throws on auth/service
  failure with a coded `error.code` (`AUTH_REQUIRED`, `AUTH_REJECTED`,
  `SERVICE_ERROR`); `isVariationsAuthError` narrows the two auth cases so a UI
  can prompt re-login.
- **`findVariations(input)`** — file-in/file-out glue over the service, matching
  the legacy `findVariations` signature so existing call sites swap over
  unchanged. Reads `pathToMetadataReportJson`, calls the service, and writes
  `data-dictionary-variations.json` into `outputPath` when variations are found.

## Auth

Two callers, two token sources — resolved by whether a `bearerToken` is passed:

- **Desktop / web UI (members)** pass the logged-in session bearer obtained from
  the cert endpoint at login.
- **CLI (the free path)** omits the bearer; a provider token is minted from
  `.env` credentials (`CERT_AUTH_API_BASE_URL`, `CERT_AUTH_API_USERNAME`,
  `CERTIFICATION_API_KEY`, `CURRENT_PROVIDER_UOI`) via
  [`mintProviderToken`](../sdk/common.ts). Set `fromCli: true` so a
  not-configured error points at the `.env` setup rather than a programmatic
  token.

## Files

| File | What |
|---|---|
| `service.ts` | `computeVariationsViaService` + the coded-error surface |
| `find-variations.ts` | `findVariations` file-in/file-out wrapper |
| `constants.ts` | `DEFAULT_FUZZINESS`, `DEFAULT_DD_VERSION`, output filename |
| `index.ts` | public exports |
