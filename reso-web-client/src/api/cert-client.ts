/**
 * RESO Certification API client.
 *
 * Talks to the Cert API at certqa.reso.org by routing every request through
 * the existing reso-web-api-proxy at `/api/proxy?url=...`. This is the same
 * proxy the OData client uses for external servers (see api/client.ts) and
 * the same proxy the desktop client embeds in production. One transport,
 * one set of CORS rules, works in dev (web client → reference server's
 * proxy middleware → certqa) and in the desktop client (renderer →
 * embedded reso-web-api-proxy → certqa).
 *
 * The Cert API uses two distinct auth schemes:
 *
 * 1. ApiKey — for /api/v1/* endpoints on the Cert API itself.
 *    Obtained from POST /api/v1/account/login.
 * 2. Bearer — for services.reso.org and downstream endpoints (variations,
 *    notifications, certification jobs status). Obtained from
 *    POST /api/v1/oauth2/token via OAuth2 client_credentials grant, where
 *    the client_id and client_secret are the same username/password the
 *    user typed at login.
 *
 * The provider token's lifetime is set by the server (currently ~24 hours).
 * The auth context handles refresh; this module is pure transport.
 */

/** Cert API root that gets URL-encoded and passed to the proxy. */
const CERT_API_ORIGIN = 'https://certqa.reso.org/api/v1';

/** Build a /api/proxy?url=... URL pointing at a Cert API path. */
const proxiedCertUrl = (path: string): string =>
  `/api/proxy?url=${encodeURIComponent(`${CERT_API_ORIGIN}${path}`)}`;

// ── Login ──────────────────────────────────────────────────────────────────

/** Successful login response from POST /api/v1/account/login. */
export interface LoginResponse {
  readonly success: true;
  readonly message: string;
  /** Cert API key — used as `Authorization: ApiKey <token>` against /api/v1/*. */
  readonly token: string;
  readonly isAdmin: boolean;
  readonly username: string;
  readonly fullName: string;
  readonly email: string;
  // TODO(non-admin-shape): grab a provider login response and extend this
  // type with whatever extra identity fields it carries (uoi, providerUoi,
  // recipientUoi, apiKeys, etc.). Currently typed against the admin response.
}

/** Error response envelope. */
export interface CertApiError {
  readonly success: false;
  readonly message: string;
}

export class CertApiAuthError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = 'CertApiAuthError';
    this.httpStatus = httpStatus;
  }
}

/** POST credentials to the Cert API login endpoint. */
export const login = async (
  username: string,
  password: string
): Promise<LoginResponse> => {
  const res = await fetch(proxiedCertUrl('/account/login'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username, password })
  });

  const body = (await res.json().catch(() => null)) as
    | LoginResponse
    | CertApiError
    | null;

  if (!res.ok || !body || body.success !== true) {
    const message =
      (body && 'message' in body && body.message) ||
      `Login failed (HTTP ${res.status})`;
    throw new CertApiAuthError(message, res.status);
  }

  return body;
};

// ── Provider OAuth2 token ──────────────────────────────────────────────────

/** Standard OAuth2 client_credentials response from /api/v1/oauth2/token. */
export interface ProviderTokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer' | string;
  /** Lifetime in seconds from issuance. */
  readonly expires_in: number;
}

/**
 * Resolved provider token with the absolute expiry timestamp computed
 * client-side (so refresh scheduling doesn't have to recompute).
 */
export interface ProviderToken {
  readonly accessToken: string;
  readonly tokenType: string;
  /** Absolute expiry as ISO-8601, computed at issuance. */
  readonly expiresAt: string;
}

/**
 * OAuth2 client_credentials grant against the Cert API's token endpoint.
 * Per the v0.8 auth notes (issue #85), client_id and client_secret are the
 * same username/password the user typed at login.
 */
export const requestProviderToken = async (
  username: string,
  password: string
): Promise<ProviderToken> => {
  const basicAuth = btoa(`${username}:${password}`);

  const res = await fetch(proxiedCertUrl('/oauth2/token'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CertApiAuthError(
      text || `OAuth2 token request failed (HTTP ${res.status})`,
      res.status
    );
  }

  const body = (await res.json()) as ProviderTokenResponse;
  const expiresAt = new Date(Date.now() + body.expires_in * 1000).toISOString();

  return {
    accessToken: body.access_token,
    tokenType: body.token_type,
    expiresAt
  };
};

// ── Endorsements (Cert reports) ────────────────────────────────────────────
//
// The endpoint exists in the existing cert app as
// POST /api/v1/certification_reports/filter with a {options} body. The exact
// shape of `options` and the report row schema haven't been confirmed yet —
// see TODO below.

/** Stub options shape — refine once we have a real response sample. */
export interface FetchEndorsementsOptions {
  readonly showMyResults?: boolean;
  readonly providerUoi?: string;
  // TODO(filter-shape): mirror the real options shape once captured live.
  readonly [key: string]: unknown;
}

/**
 * Fetch the endorsements list (a.k.a. cert reports filter).
 *
 * Requires the Cert API key as `Authorization: ApiKey <token>`. The auth
 * context wraps this in a higher-level call that injects the header.
 */
export const fetchEndorsements = async (
  apiKey: string,
  options: FetchEndorsementsOptions = {}
): Promise<unknown> => {
  const res = await fetch(proxiedCertUrl('/certification_reports/filter'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `ApiKey ${apiKey}`
    },
    body: JSON.stringify({ options })
  });

  if (!res.ok) {
    throw new CertApiAuthError(
      `Failed to fetch endorsements (HTTP ${res.status})`,
      res.status
    );
  }

  // TODO(report-shape): type the response once we have a sample. The
  // existing cert app uses a `report` shape with type, version, status,
  // recipientUoi, providerUoi, providerUsi, plus DD-specific counts.
  return res.json();
};
