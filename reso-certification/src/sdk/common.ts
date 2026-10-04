// Shared SDK primitives for backend-service calls: provider-token minting and
// the coded service-error / auth-error helpers. Any SDK service call — variations
// today, others to come — reuses these so token minting and auth-error semantics
// stay defined in one place rather than copied per service.

/** Auth/setup errors carry one of these on `error.code`.
 *
 *  `LOCKED` is deliberately NOT folded into `SERVICE_ERROR`. A lock refusal is not an auth failure
 *  and not a service fault -- it means somebody else is legitimately working on the thing. Collapsing
 *  it would make "retry when they are done" indistinguishable from "something is broken", and a
 *  caller cannot render the right message from a code that does not distinguish them. */
export type ServiceErrorCode = 'AUTH_REQUIRED' | 'AUTH_REJECTED' | 'SERVICE_ERROR' | 'LOCKED' | 'REVIEW_IN_PLACE';

/** Build an Error carrying a machine-readable `code` for a service-call failure. */
export const serviceError = (code: ServiceErrorCode, message: string): Error => {
  const error = new Error(message);
  (error as Error & { code: ServiceErrorCode }).code = code;
  return error;
};

/** Who holds a lock, as the service reports it on a refusal.
 *
 *  Carried on the error so both the CLI and the desktop can say "Anna has this open until 14:30,
 *  contact her" rather than printing a status code. `heldByProviderUoi` is the HOLDER's organization,
 *  which lets a caller tell a colleague from a RESO administrator by comparing it with its own. */
export interface LockHolderInfo {
  readonly displayName: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly heldByProviderUoi?: string;
}

/** Build a LOCKED error carrying the holder, so the caller can act rather than just fail. */
export const lockedError = (message: string, lock?: LockHolderInfo): Error => {
  const error = serviceError('LOCKED', message);
  if (lock) (error as Error & { lock?: LockHolderInfo }).lock = lock;
  return error;
};

/** The holder carried on a LOCKED error, when the service named one. */
export const lockHolderOf = (error: unknown): LockHolderInfo | undefined =>
  error instanceof Error ? (error as Error & { lock?: LockHolderInfo }).lock : undefined;

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
