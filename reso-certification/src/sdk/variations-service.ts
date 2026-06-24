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
 * It throws rather than silently degrading: a cert tool that can't reach the
 * service should fail loudly, not return a partial report.
 */

import { gzipSync, gunzipSync } from 'node:zlib';

export interface ComputeVariationsViaServiceInput {
  readonly metadataReportJson: unknown;
  readonly version: string;
  readonly fuzziness?: number;
  /** Logged-in session bearer (Desktop / UI). Omit to mint from `.env` (CLI). */
  readonly bearerToken?: string;
}

export interface VariationsServiceReport {
  readonly description: string;
  readonly version: string;
  readonly fuzziness: number;
  readonly variations: Record<string, unknown>;
}

/**
 * Mint a provider token from `.env` credentials — the CLI path. Mirrors the
 * legacy `fetchProviderToken` so CLI auth is unchanged. Returns undefined when
 * credentials are absent or the mint fails.
 */
const mintProviderToken = async (): Promise<string | undefined> => {
  const { CERT_AUTH_API_BASE_URL, CURRENT_PROVIDER_UOI, CERT_AUTH_API_USERNAME, CERTIFICATION_API_KEY } = process.env;
  if (!CERT_AUTH_API_BASE_URL || !CERT_AUTH_API_USERNAME || !CERTIFICATION_API_KEY) return undefined;
  const url = `${CERT_AUTH_API_BASE_URL}/${CURRENT_PROVIDER_UOI}?username=${CERT_AUTH_API_USERNAME}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `ApiKey ${CERTIFICATION_API_KEY}` } });
    if (!res.ok) return undefined;
    const { token } = (await res.json()) as { token?: string };
    return token;
  } catch {
    return undefined;
  }
};

export const computeVariationsViaService = async (
  input: ComputeVariationsViaServiceInput,
): Promise<VariationsServiceReport> => {
  const servicesUrl = process.env.RESO_SERVICES_URL;
  if (!servicesUrl) {
    throw new Error('Variations Service: RESO_SERVICES_URL is not set.');
  }

  const token = input.bearerToken ?? (await mintProviderToken());
  if (!token) {
    throw new Error(
      'Variations Service: no provider token. Pass a logged-in session bearer, or set CERT_AUTH_API_BASE_URL / CERT_AUTH_API_USERNAME / CERTIFICATION_API_KEY for the CLI.',
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
  if (!response.ok) {
    throw new Error(`Variations Service /compute failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return JSON.parse(gunzipSync(Buffer.from(text, 'base64')).toString('utf-8')) as VariationsServiceReport;
};
