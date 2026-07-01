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
  const response = await fetch(`${servicesUrl}/v2/certification/variations/compute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: gzipSync(JSON.stringify(body)).toString('base64'),
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
