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

// ── Endorsements (cert reports filter) ─────────────────────────────────────
//
// POST /api/v1/certification_reports/filter takes a JSON body shaped like
// `{ options: FetchReportsOptions }` and returns a `FetchReportsResponse`
// envelope. The response is keyed by recipient UOI — each value is an
// array of report objects for that org. Pagination is server-side via
// `from` (the next call passes the previous response's `lastUoiIndex`).
//
// Field shapes here mirror the existing reso-certification web app's
// usage on branch 2532-variations-uix-improvements (apis/reports/index.js
// + components/Reports/index.js). Anything still uncertain is marked
// TODO and tightened as we see real data come back.

export interface FetchReportsOptions {
  readonly from?: number;
  readonly endorsementFilter?: ReadonlyArray<string>;
  readonly statusFilter?: ReadonlyArray<string>;
  readonly showMyResults?: boolean;
  readonly providerUoi?: string | null;
  readonly searchKey?: string;
  /** Sort direction: "asc" or "desc". Not a field name. */
  readonly sortBy?: 'asc' | 'desc';
  /** When true, sort by timestamp; when false, sort by name. */
  readonly sortByTimestamp?: boolean;
  readonly fromProvider?: number;
  // TODO(range): the existing app passes a getCalenderDateRange() result
  // here; shape unconfirmed. Leaving as unknown until we capture one.
  readonly range?: unknown;
}

/** A single report row from the Cert API. */
export interface CertReport {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly status: string;
  readonly recipientUoi: string;
  readonly providerUoi: string;
  readonly providerUsi?: string;
  readonly description?: string;
  /** True for jobs run from a local CLI runner; false for cloud. */
  readonly local?: boolean;
  /** Step that failed, if status is failed/in_review. */
  readonly failedStep?: string;
  /** ISO timestamp; the existing app reads several timestamp fields and
   *  picks the most relevant one for display — we capture the common ones. */
  readonly statusTimestamp?: string;
  readonly modificationTimestamp?: string;
  // DD-specific aggregates
  readonly standardResourcesCount?: number;
  readonly localResourcesCount?: number;
  readonly standardFieldsCount?: number;
  readonly localFieldsCount?: number;
  readonly standardLookupsCount?: number;
  readonly localLookupsCount?: number;
  readonly iDXFieldsCount?: number;
  readonly totalStandardIdxFieldsCount?: number;
  // TODO(report-shape): there are more fields on the wire; this is the
  // subset the Endorsement UI cares about today. Extend as we surface
  // more screens (Summary, Detail).
  readonly [key: string]: unknown;
}

export interface FetchReportsResponse {
  readonly reportsByOrgs: Record<string, ReadonlyArray<CertReport>>;
  readonly lastUoiIndex?: number;
  readonly fromProvider?: number;
}

/**
 * Fetch the endorsements list.
 *
 * The Cert API key is optional — pass null/undefined to attempt an
 * anonymous call (which may succeed for public-readable endpoints or
 * fail with 401 for auth-required ones; the caller decides what to do
 * with the failure).
 */
export const fetchEndorsements = async (
  apiKey: string | null,
  options: FetchReportsOptions = {}
): Promise<FetchReportsResponse> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  if (apiKey) headers.Authorization = `ApiKey ${apiKey}`;

  // The Cert API requires `options.sortBy` (direction) and
  // `options.sortByTimestamp` (boolean toggle). Default to most-recent-first.
  const optionsWithDefaults: FetchReportsOptions = {
    sortBy: 'desc',
    sortByTimestamp: true,
    ...options
  };

  const res = await fetch(proxiedCertUrl('/certification_reports/filter'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ options: optionsWithDefaults })
  });

  if (!res.ok) {
    throw new CertApiAuthError(
      `Failed to fetch endorsements (HTTP ${res.status})`,
      res.status
    );
  }

  return (await res.json()) as FetchReportsResponse;
};

// ── Certification counts ───────────────────────────────────────────────────
//
// GET /api/v1/certification_reports/certification-count returns a flat
// dictionary keyed by either an endorsement slug (`{type}_{version}`),
// a status name, `all`, or `legacy`. The response shape is open-ended —
// new types/statuses can appear without a schema bump — so we model it
// as a `Record<string, number>` and read by lookup.

export type CertificationCounts = Readonly<Record<string, number>>;

export const fetchCertificationCounts = async (
  apiKey: string | null
): Promise<CertificationCounts> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `ApiKey ${apiKey}`;

  // The endpoint takes `showMyResults` and `endorsements` as query params.
  // For the public list we want global counts (showMyResults=false) with
  // no endorsement narrowing.
  const path = '/certification_reports/certification-count?showMyResults=false&endorsements=';

  const res = await fetch(proxiedCertUrl(path), { headers });

  if (!res.ok) {
    throw new CertApiAuthError(
      `Failed to fetch certification counts (HTTP ${res.status})`,
      res.status
    );
  }

  return (await res.json()) as CertificationCounts;
};
