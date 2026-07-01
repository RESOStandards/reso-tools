// Shared SDK primitives for backend-service calls: provider-token minting and
// the coded service-error / auth-error helpers. Any SDK service call — variations
// today, others to come — reuses these so token minting and auth-error semantics
// stay defined in one place rather than copied per service.

/** Auth/setup errors carry one of these on `error.code`. */
export type ServiceErrorCode = 'AUTH_REQUIRED' | 'AUTH_REJECTED' | 'SERVICE_ERROR';

/** Build an Error carrying a machine-readable `code` for a service-call failure. */
export const serviceError = (code: ServiceErrorCode, message: string): Error => {
  const error = new Error(message);
  (error as Error & { code: ServiceErrorCode }).code = code;
  return error;
};

/** True for the two auth failures — the UI uses this to decide to prompt login. */
export const isServiceAuthError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const { code } = error as Error & { code?: string };
  return code === 'AUTH_REQUIRED' || code === 'AUTH_REJECTED';
};

/**
 * Mint a provider token from `.env` credentials — the CLI path. Mirrors the
 * legacy `fetchProviderToken` so CLI auth is unchanged. Returns undefined when
 * credentials are absent or the mint fails. SDK callers that already hold a
 * session token pass it directly instead of calling this.
 */
export const mintProviderToken = async (): Promise<string | undefined> => {
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
