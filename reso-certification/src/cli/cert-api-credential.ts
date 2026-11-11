/**
 * How the Cert API commands (`restore`, `archive-report`) find the Cert API and authorize to it.
 *
 * One module for both, so the two can never drift apart on which credential wins or where a secret may go.
 *
 * The rule for `CLIENT_SECRET`: it is sent to exactly one place, the token endpoint of the Cert API the command
 * is about to call, as an OAuth2 client credentials exchange. Every other request carries the bearer token that
 * exchange returns. It is never sent as a credential itself, and never to any other host: a `TOKEN_URI` that
 * names a different origin than the API is refused before a request is made.
 */
import { ensureHttps, isLoopbackHost } from '../sdk/common.js';
import { exchangeClientCredentials } from './auth.js';
import { registerSecret } from './secrets.js';

/** A bearer token for the Cert API, given directly rather than minted. */
export const CERT_API_TOKEN_VARIABLE = 'CERT_API_TOKEN';

/** The token endpoint paths the downloaded credentials file can name. `/oauth2` is the legacy prefix. */
const TOKEN_PATHS: ReadonlySet<string> = new Set(['/api/v1/oauth/token', '/api/v1/oauth2/token']);

/**
 * A variable that is set but empty, or blank, is absent: it falls through to the next source, so an
 * exported-but-empty value neither shadows a set one nor reaches a request as a bare `Bearer`. Surrounding
 * whitespace is trimmed, since a credential never carries any and a trailing newline from a shell is common.
 */
const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

/**
 * True for a host the Cert API can be on: loopback, or a name with a dot in it.
 *
 * The credentials file the certification site produced from 2025-04-03 to 2026-10-20 carried
 * `TOKEN_URI=undefined/api/v1/oauth/token`, a lookup that missed. Prefixed with a scheme that is the
 * host `undefined`, and a request to it would carry the credential to a DNS lookup for that name.
 * A bare single-label name is never where the API is, so it is refused before any request.
 */
const isApiHost = (hostname: string): boolean => isLoopbackHost(hostname) || hostname.includes('.');

/**
 * The Cert API origin a `TOKEN_URI` names, or undefined.
 *
 * Only when the host can be an API host and the path is exactly the token endpoint. The file's own
 * comment records that older files were built from the site host, where `/api/v1` answers the
 * single-page app with a 200, so a value with any other path says nothing reliable about where the
 * API is.
 */
export const certApiOriginFromTokenUri = (tokenUri: string): string | undefined => {
  try {
    const parsed = new URL(tokenUri.trim());
    return isApiHost(parsed.hostname) && TOKEN_PATHS.has(parsed.pathname) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/** Why a parsed `TOKEN_URI` does not name the API, for the refusal. */
const tokenUriRefusal = (tokenUri: string): string => {
  const hostname = ((): string | undefined => {
    try {
      return new URL(tokenUri).hostname;
    } catch {
      return undefined;
    }
  })();
  return hostname !== undefined && !isApiHost(hostname)
    ? `TOKEN_URI names the host ${JSON.stringify(hostname)}, which cannot be the Cert API, so the API address cannot be taken from it. Pass --url.`
    : 'TOKEN_URI does not name the Cert API token endpoint (/api/v1/oauth/token), so the API address cannot be taken from it. Pass --url.';
};

/**
 * The Cert API origin: `--url` when given, else from `TOKEN_URI`, either way as https.
 *
 * A `--url` with a path is refused rather than trimmed: a `TOKEN_URI` pasted here would otherwise
 * silently become a different address. The API is expected at an origin's root.
 */
export const resolveCertApiOrigin = (input: { readonly url?: string; readonly env: NodeJS.ProcessEnv }): string => {
  if (input.url !== undefined) {
    const secured = ensureHttps(input.url, '--url');
    const parsed = new URL(secured);
    if (!isApiHost(parsed.hostname)) {
      throw new Error(`--url names the host ${JSON.stringify(parsed.hostname)}, which cannot be the Cert API.`);
    }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`--url must be the Cert API origin without a path, such as ${parsed.origin}.`);
    }
    return parsed.origin;
  }
  const tokenUri = input.env.TOKEN_URI;
  if (tokenUri === undefined) {
    throw new Error('No Cert API address. Pass --url, or run where the downloaded credentials file (TOKEN_URI) can be read.');
  }
  const secured = ensureHttps(tokenUri, 'TOKEN_URI');
  const origin = certApiOriginFromTokenUri(secured);
  if (origin === undefined) throw new Error(tokenUriRefusal(secured));
  return origin;
};

/**
 * Register every Cert API secret the environment carries for masking, before anything else runs, so a message
 * printed before the credential is resolved (a refused argument, a failed lookup) still cannot show one.
 */
export const registerCertApiSecrets = (env: NodeJS.ProcessEnv): void => {
  for (const name of [CERT_API_TOKEN_VARIABLE, 'CLIENT_SECRET', 'CERTIFICATION_API_KEY']) {
    const value = present(env[name]);
    if (value !== undefined) registerSecret(value);
  }
};

/** Said when no source of a credential is set. The same words from every command that needs one. */
export const MISSING_CERT_API_CREDENTIAL =
  'No credential. Run where the downloaded credentials file (TOKEN_URI, CLIENT_ID, CLIENT_SECRET) can be read, or set CERT_API_TOKEN to a bearer token.';

/** Exchanges client credentials for an access token, or undefined when the endpoint refuses. */
export type ClientCredentialsExchange = (input: {
  readonly tokenUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
}) => Promise<string | undefined>;

/**
 * The `Authorization` header value for a Cert API at `origin`, in this order:
 *
 *   1. a bearer token given directly in `CERT_API_TOKEN` (an environment variable or the `.env`, never a flag,
 *      so it stays out of shell history);
 *   2. a token minted from the downloaded credentials file (`TOKEN_URI`, `CLIENT_ID`, `CLIENT_SECRET`), only
 *      when `TOKEN_URI` is the token endpoint OF `origin`;
 *   3. `CERTIFICATION_API_KEY`, the key an environment set up for the older tools carries.
 *
 * `CLIENT_SECRET` without `TOKEN_URI` and `CLIENT_ID` is refused rather than used: the secret is only ever
 * exchanged, never presented.
 */
export const resolveCertApiAuthorization = async (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly origin: string;
  readonly exchange?: ClientCredentialsExchange;
}): Promise<string> => {
  const bearer = present(input.env[CERT_API_TOKEN_VARIABLE]);
  if (bearer !== undefined) {
    registerSecret(bearer);
    return `Bearer ${bearer}`;
  }

  const clientSecret = present(input.env.CLIENT_SECRET);
  if (clientSecret !== undefined) {
    registerSecret(clientSecret);
    const tokenUri = present(input.env.TOKEN_URI);
    const clientId = present(input.env.CLIENT_ID);
    if (tokenUri === undefined || clientId === undefined) {
      throw new Error(
        'CLIENT_SECRET is only ever exchanged for a token, and that needs TOKEN_URI and CLIENT_ID beside it. Nothing was sent.'
      );
    }
    const tokenOrigin = certApiOriginFromTokenUri(ensureHttps(tokenUri, 'TOKEN_URI'));
    if (tokenOrigin !== input.origin) {
      throw new Error(
        `TOKEN_URI is not the token endpoint of ${input.origin}, the Cert API this command calls. CLIENT_SECRET goes only there, so nothing was sent.`
      );
    }
    const exchange = input.exchange ?? exchangeClientCredentials;
    const token = await exchange({ tokenUri: ensureHttps(tokenUri, 'TOKEN_URI'), clientId, clientSecret });
    if (token === undefined) {
      throw new Error('The Cert API did not issue a token for these client credentials (the reason is above). Nothing else was sent.');
    }
    return `Bearer ${token}`;
  }

  const apiKey = present(input.env.CERTIFICATION_API_KEY);
  if (apiKey !== undefined) {
    registerSecret(apiKey);
    return `Bearer ${apiKey}`;
  }

  throw new Error(MISSING_CERT_API_CREDENTIAL);
};
