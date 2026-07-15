/**
 * Variations Service client.
 *
 * POSTs a metadata report to the cert-backend `/compute` endpoint and returns
 * the variations report. This replaces the local `findVariations` matcher: the
 * canonical + in-review blend and the machine matching now run server-side
 * (reso-services-v2). Both clients call this one function —
 *  - Desktop / web UI (members): pass the logged-in session bearer obtained
 *    from the cert endpoint at login;
 *  - CLI (non-members, the free path): omit the bearer and a provider token is
 *    minted from `.env` credentials, exactly as `findVariations` did.
 *
 * It throws rather than silently degrading. Auth failures carry a `code` so
 * callers can react — the UI catches an auth code to prompt re-login; the CLI
 * surfaces the `.env` setup instructions. The `fromCli` flag (threaded from the
 * Commander CLI helper, as the legacy did) tailors the not-configured message.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import { mintProviderToken, serviceError, isServiceAuthError } from '../sdk/common.js';
import type { ServiceErrorCode } from '../sdk/common.js';
import { MAX_COMPUTE_PAYLOAD_BYTES } from './constants.js';
import type { VariationSuggestionItem } from './csv.js';

export interface ComputeVariationsViaServiceInput {
  readonly metadataReportJson: unknown;
  readonly version: string;
  readonly fuzziness?: number;
  /** Logged-in session bearer (Desktop / UI). Omit to mint from `.env` (CLI). */
  readonly bearerToken?: string;
  /** True when invoked from the CLI — points the not-configured error at the
   *  `.env` credentials rather than passing a token programmatically. */
  readonly fromCli?: boolean;
}

export interface VariationsServiceReport {
  readonly description: string;
  readonly version: string;
  readonly fuzziness: number;
  readonly variations: Record<string, unknown>;
}

/** @deprecated Alias of `ServiceErrorCode` in `../sdk/common` — kept for back-compat. */
export type VariationsServiceErrorCode = ServiceErrorCode;

/** True for the two auth failures — the UI uses this to decide to prompt login. Alias of `isServiceAuthError`. */
export const isVariationsAuthError = isServiceAuthError;

export const computeVariationsViaService = async (
  input: ComputeVariationsViaServiceInput,
): Promise<VariationsServiceReport> => {
  const servicesUrl = process.env.RESO_SERVICES_URL;
  if (!servicesUrl) {
    throw serviceError('SERVICE_ERROR', 'Variations Service: RESO_SERVICES_URL is not set.');
  }

  const token = input.bearerToken ?? (await mintProviderToken());
  if (!token) {
    throw serviceError(
      'AUTH_REQUIRED',
      input.fromCli
        ? 'Variations check requires authentication. Set CERT_AUTH_API_BASE_URL, CERT_AUTH_API_USERNAME, and CERTIFICATION_API_KEY in your .env so the CLI can mint a provider token.'
        : 'Variations check requires authentication. Pass a provider token (bearerToken) — e.g. the session token from logging in.',
    );
  }

  const body = {
    metadataReportJson: input.metadataReportJson,
    version: input.version,
    ...(input.fuzziness !== undefined ? { fuzziness: input.fuzziness } : {}),
  };

  // text/plain + gzip+base64 mirrors the legacy /search call: large metadata
  // reports compress well, and the handler compresses its response in kind.
  const compressedBody = gzipSync(JSON.stringify(body)).toString('base64');

  // Guard the Lambda's 6 MB sync-invocation ceiling client-side so an oversized
  // report gets an actionable message, not a cryptic gateway failure. Reject at
  // `>=` the limit, not `>`: the 6 MB cap is on the whole event (body + request
  // envelope), so the compressed body must be *strictly under* 6 MB to fit. Even
  // Cotality-scale reports (~45 MB raw → ~3.2 MB compressed) clear this; the
  // durable fix for the giants is reso-tools #227.
  if (compressedBody.length >= MAX_COMPUTE_PAYLOAD_BYTES) {
    const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
    throw serviceError(
      'SERVICE_ERROR',
      `This metadata report is too large for the variations service: the compressed request is ${mb(compressedBody.length)} MB, over the ${mb(MAX_COMPUTE_PAYLOAD_BYTES)} MB limit. Please contact dev@reso.org.`,
    );
  }

  const response = await fetch(`${servicesUrl}/v2/certification/variations/compute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: compressedBody,
  });

  if (response.status === 401 || response.status === 403) {
    throw serviceError(
      'AUTH_REJECTED',
      input.fromCli
        ? 'Variations check: the provider token was rejected. Re-check your CERT_AUTH_API_* .env credentials.'
        : 'Variations check: your session token was rejected or has expired. Log in again to continue.',
    );
  }
  if (!response.ok) {
    throw serviceError('SERVICE_ERROR', `Variations Service /compute failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return JSON.parse(gunzipSync(Buffer.from(text, 'base64')).toString('utf-8')) as VariationsServiceReport;
};

/** Suggestions per POST. The store serializes admin writes on its ETag, so
 *  chunks go sequentially; this bounds each request body. Mirrors the v2
 *  re-importer (cert-backend utils/variations-import.mjs). */
const DEFAULT_CHUNK_SIZE = 1000;

export interface UpdateVariationsViaServiceInput {
  readonly items: ReadonlyArray<VariationSuggestionItem>;
  /** Logged-in session bearer (Desktop / UI). Omit to mint from `.env` (CLI). */
  readonly bearerToken?: string;
  /** The FT admin secret (`FT_ADMIN_SECRET`). Required to land Admin- and
   *  Fast-Track-flagged canonical entries; sent as `x-ft-admin-secret`. */
  readonly adminSecret?: string;
  /** Flag the whole submission as admin-review. Mutually exclusive with `fastTrack`. */
  readonly adminReview?: boolean;
  /** Flag the whole submission as fast-track. Mutually exclusive with `adminReview`. */
  readonly fastTrack?: boolean;
  /** Allow overwriting existing canonical entries. */
  readonly overwrite?: boolean;
  /** Suggestions per POST (default 1000). */
  readonly chunkSize?: number;
  /** True when invoked from the CLI — tailors the not-configured error. */
  readonly fromCli?: boolean;
}

export interface UpdateVariationsResult {
  readonly submitted: number;
  readonly chunks: number;
  /** Numeric stats returned by the service (e.g. `updatedFields`), summed across chunks. */
  readonly stats: Readonly<Record<string, number>>;
  /** Items the service refused on permission, rejected on validation, or corrected,
   *  summed across chunks. Surfaced so a run that submits N but lands fewer is visible
   *  rather than reading as clean. Mirrors the reference caller's rollup. */
  readonly permissionDenied: number;
  readonly validationFailed: number;
  readonly corrections: number;
}

const chunk = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

/** True for a permission-denied group carrying an `items` array. */
const hasItemsArray = (value: unknown): value is { readonly items: ReadonlyArray<unknown> } =>
  typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items);

/**
 * Submit human-reviewed variation suggestions to the v2 admin endpoint
 * (`POST /v2/certification/variations`). This is the admin-write counterpart to
 * `computeVariationsViaService`: it replaces the legacy `updateVariations`,
 * repointed to v2 with OAuth2 bearer auth and the `x-ft-admin-secret` admin gate.
 *
 * The submission's review flags are batch-level: `adminReview` XOR `fastTrack`
 * (mutually exclusive, as the service requires) and `overwrite` apply to every
 * item. Chunks POST sequentially. Throws with a coded error — auth failures
 * carry `AUTH_REQUIRED` / `AUTH_REJECTED` so the CLI and UI can react.
 */
export const updateVariationsViaService = async (
  input: UpdateVariationsViaServiceInput,
): Promise<UpdateVariationsResult> => {
  const servicesUrl = process.env.RESO_SERVICES_URL;
  if (!servicesUrl) {
    throw serviceError('SERVICE_ERROR', 'Variations Service: RESO_SERVICES_URL is not set.');
  }
  if (input.adminReview && input.fastTrack) {
    throw serviceError(
      'SERVICE_ERROR',
      'A submission cannot be both admin-review and fast-track; the two flags are mutually exclusive.',
    );
  }
  if (input.items.length === 0) {
    throw serviceError('SERVICE_ERROR', 'No variation suggestions to submit.');
  }

  const token = input.bearerToken ?? (await mintProviderToken());
  if (!token) {
    throw serviceError(
      'AUTH_REQUIRED',
      input.fromCli
        ? 'Updating variations requires authentication. Set TOKEN_URI, CLIENT_ID, and CLIENT_SECRET in your .env so the CLI can mint a provider token.'
        : 'Updating variations requires authentication. Pass a provider token (bearerToken).',
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (input.adminSecret) headers['x-ft-admin-secret'] = input.adminSecret;
  if (input.overwrite) headers.Overwrite = 'true';
  if (input.fastTrack) headers.isFastTrack = 'true';
  else if (input.adminReview) headers.isAdminReview = 'true';

  const size = input.chunkSize && input.chunkSize > 0 ? input.chunkSize : DEFAULT_CHUNK_SIZE;
  const chunks = chunk(input.items, size);
  const url = `${servicesUrl}/v2/certification/variations`;

  const stats: Record<string, number> = {};
  const rejected = { permissionDenied: 0, validationFailed: 0, corrections: 0 };

  // Sequential by design: concurrent admin writes race on the store's ETag.
  for (const [index, batch] of chunks.entries()) {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(batch) });
    // Name how much already landed so a mid-run failure is reconcilable.
    const committed = index > 0 ? ` — ${index} of ${chunks.length} chunk(s) already committed to the store` : '';

    if (response.status === 401 || response.status === 403) {
      throw serviceError(
        'AUTH_REJECTED',
        (input.fromCli
          ? 'Update variations: the provider token or admin secret was rejected. Re-check your .env credentials.'
          : 'Update variations: your session token was rejected or has expired. Log in again to continue.') + committed,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw serviceError(
        'SERVICE_ERROR',
        `Update variations chunk ${index + 1}/${chunks.length} failed: ${response.status} ${response.statusText}` +
          (detail ? ` — ${detail.slice(0, 500)}` : '') +
          committed,
      );
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'number') stats[key] = (stats[key] ?? 0) + value;
    }
    if (Array.isArray(body.permissionDenied)) {
      rejected.permissionDenied += body.permissionDenied.reduce<number>((n, group) => n + (hasItemsArray(group) ? group.items.length : 0), 0);
    }
    if (Array.isArray(body.validationFailed)) rejected.validationFailed += body.validationFailed.length;
    if (Array.isArray(body.corrections)) rejected.corrections += body.corrections.length;
  }

  return {
    submitted: input.items.length,
    chunks: chunks.length,
    stats,
    permissionDenied: rejected.permissionDenied,
    validationFailed: rejected.validationFailed,
    corrections: rejected.corrections,
  };
};
