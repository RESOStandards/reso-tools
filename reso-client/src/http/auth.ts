/**
 * Authentication helpers — OAuth2 Client Credentials grant with proactive
 * token refresh, concurrent deduplication, and bearer token passthrough.
 */

import type { AuthConfig, ClientCredentialsAuth, TokenProvider, TokenResponse, TokenState } from '../types.js';

const DEFAULT_EXPIRES_IN = 3600;
const REFRESH_THRESHOLD = 0.9;

const TRANSPORT_BODY = 'body' as const;
const TRANSPORT_HEADER = 'header' as const;
const TRANSPORT_QUERY = 'query' as const;
const AUTH_MODE_TOKEN = 'token' as const;

/**
 * Perform an OAuth2 Client Credentials grant to obtain an access token.
 * Supports three credential transport modes: body (default), header (Basic), query.
 */
export const fetchAccessToken = async (auth: ClientCredentialsAuth): Promise<TokenResponse> => {
  const transport = auth.credentialTransport ?? TRANSPORT_BODY;
  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  if (auth.scope) params.set('scope', auth.scope);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  let url = auth.tokenUrl;

  if (transport === TRANSPORT_BODY) {
    params.set('client_id', auth.clientId);
    params.set('client_secret', auth.clientSecret);
  } else if (transport === TRANSPORT_HEADER) {
    const encoded = btoa(`${auth.clientId}:${auth.clientSecret}`);
    headers.Authorization = `Basic ${encoded}`;
  } else if (transport === TRANSPORT_QUERY) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}client_id=${encodeURIComponent(auth.clientId)}&client_secret=${encodeURIComponent(auth.clientSecret)}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`OAuth2 token request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  const accessToken = json.access_token;

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('OAuth2 token response missing or empty access_token field');
  }

  return {
    access_token: accessToken,
    token_type: typeof json.token_type === 'string' ? json.token_type : 'bearer',
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
};

/**
 * Create a token provider for Client Credentials auth.
 * Caches tokens, refreshes proactively at 90% of TTL, and deduplicates
 * concurrent refresh requests.
 */
const createClientCredentialsProvider = (auth: ClientCredentialsAuth): TokenProvider => {
  const ref: { current: TokenState | null; pending: Promise<TokenState> | null } = {
    current: null,
    pending: null,
  };

  const expiresIn = auth.defaultExpiresIn ?? DEFAULT_EXPIRES_IN;

  const refresh = (): Promise<TokenState> => {
    if (ref.pending) return ref.pending;
    ref.pending = fetchAccessToken(auth).then(tokenResponse => {
      const ttl = tokenResponse.expires_in ?? expiresIn;
      const state: TokenState = {
        accessToken: tokenResponse.access_token,
        expiresAt: Date.now() + ttl * 1000,
      };
      ref.current = state;
      ref.pending = null;
      return state;
    }).catch(err => {
      ref.pending = null;
      throw err;
    });
    return ref.pending;
  };

  return async (forceRefresh = false): Promise<string> => {
    if (forceRefresh || !ref.current) {
      const state = await refresh();
      return state.accessToken;
    }

    const ttlMs = expiresIn * 1000;
    const issuedAt = ref.current.expiresAt - ttlMs;
    const refreshAt = issuedAt + ttlMs * REFRESH_THRESHOLD;
    if (Date.now() >= refreshAt) {
      const state = await refresh();
      return state.accessToken;
    }

    return ref.current.accessToken;
  };
};

/**
 * Quote-like characters we strip from the ends of a pasted bearer token.
 * macOS auto-substitutes ASCII quotes with curly quotes in many text fields,
 * and copy-paste from email/docs frequently introduces them. fetch's Headers
 * API rejects any value containing characters > 0x7F (the ByteString rule),
 * so a smart quote at either end of the token throws before the request goes
 * out. Sanitize at provider construction so every fetch site benefits.
 */
const TOKEN_TRIM_QUOTES = new Set([
  '"',      // U+0022 straight double quote
  "'",      // U+0027 straight single quote / apostrophe
  '‘', // left single quotation mark
  '’', // right single quotation mark
  '“', // left double quotation mark
  '”', // right double quotation mark
]);

/** Strip surrounding whitespace and quote-like wrappers from a pasted bearer token. */
export const sanitizeBearerToken = (raw: string): string => {
  let token = raw.trim();
  while (
    token.length >= 2 &&
    TOKEN_TRIM_QUOTES.has(token[0]) &&
    TOKEN_TRIM_QUOTES.has(token[token.length - 1])
  ) {
    token = token.slice(1, -1).trim();
  }
  return token;
};

/**
 * Create a token provider for any auth configuration.
 * For bearer tokens, returns the static token.
 * For client credentials, returns a managed provider with refresh.
 */
export const createTokenProvider = (auth: AuthConfig): TokenProvider => {
  if (auth.mode === AUTH_MODE_TOKEN) {
    const sanitized = sanitizeBearerToken(auth.authToken);
    return async () => sanitized;
  }
  return createClientCredentialsProvider(auth);
};

/**
 * Resolve an AuthConfig to a bearer token string (one-shot).
 * Kept for backward compatibility. For long-lived clients, use createTokenProvider.
 */
export const resolveToken = async (auth: AuthConfig): Promise<string> => {
  const provider = createTokenProvider(auth);
  return provider();
};
