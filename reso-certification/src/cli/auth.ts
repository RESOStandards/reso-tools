import { ensureHttps } from '../sdk/common.js';
/**
 * CLI auth resolution chain: flags > config entry > .env file > env vars.
 */

import { resolve } from 'node:path';
import { authConfigFromEnv } from '@reso-standards/reso-client';
import type { AuthConfig } from '../test-runner/types.js';
import { type EnvFileLoad, firstExisting, loadEnvFile } from './env-file.js';
import { maskSecrets, registerSecret } from './secrets.js';

/** CLI option flags related to authentication. */
export interface CliAuthFlags {
  readonly authToken?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
}

/**
 * Load a .env file from the first directory in `searchPaths` that contains
 * one, merging its values into process.env. Existing env vars take precedence,
 * and credentials are registered for masking (`loadEnvFile`).
 *
 * If no `searchPaths` argument is given, falls back to `[process.cwd()]` —
 * preserves the old single-cwd behavior.
 *
 * No-op if no .env file is found in any of the search paths. The CLI itself
 * reads its file through `env-bootstrap.ts`, which also looks for
 * `credentials.env` and honors `--env-file`.
 */
export const loadDotEnv = (searchPaths?: ReadonlyArray<string>): EnvFileLoad | undefined => {
  const paths = searchPaths && searchPaths.length > 0 ? searchPaths : [process.cwd()];
  const found = firstExisting(paths.map(dir => resolve(dir, '.env')));
  return found === undefined ? undefined : loadEnvFile(found);
};

/** The two fields an OAuth2 error response carries (RFC 6749, section 5.2). */
export interface OAuth2ErrorFields {
  readonly error: string;
  readonly description?: string;
}

/** Long enough for any real reason, short enough that a body that is not one cannot flood the terminal. */
const MAX_REASON_LENGTH = 200;

/** The OAuth2 errors that mean "these credentials were refused", as opposed to a malformed request or a server fault. */
const CREDENTIAL_REFUSALS: ReadonlySet<string> = new Set(['invalid_client', 'access_denied', 'unauthorized_client']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Read the error fields from a failed token response, or undefined when the body carries none.
 *
 * Only the two named string fields are kept. The rest of the body is never printed: a gateway or a
 * misconfigured host can answer with HTML or with anything else, and none of it is a reason.
 */
export const readOAuth2ErrorFields = (body: unknown): OAuth2ErrorFields | undefined => {
  if (!isRecord(body) || typeof body.error !== 'string' || !body.error) return undefined;
  const description = typeof body.error_description === 'string' && body.error_description ? body.error_description : undefined;
  return {
    error: body.error.slice(0, MAX_REASON_LENGTH),
    ...(description ? { description: description.slice(0, MAX_REASON_LENGTH) } : {})
  };
};

/**
 * What to print when the token endpoint refuses, one line per entry.
 *
 * The status alone cannot tell a wrong secret from a server fault, and the server's own reason is
 * the only thing that can, so it is printed when there is one. The endpoint's origin is printed too,
 * because a file naming the wrong host fails the same way as a wrong secret.
 */
export const describeMintRefusal = (
  status: number,
  statusText: string,
  origin: string,
  fields: OAuth2ErrorFields | undefined
): ReadonlyArray<string> => {
  const reason = fields ? ` (${fields.error}${fields.description ? `: ${fields.description}` : ''})` : '';
  const headline = `OAuth2 token mint failed: HTTP ${status}${statusText ? ` ${statusText}` : ''} from ${origin}${reason}.`;
  if (!fields || !CREDENTIAL_REFUSALS.has(fields.error)) return [headline];
  return [
    headline,
    '  The token endpoint refused CLIENT_ID and CLIENT_SECRET. Download a fresh Certification Environment File from your account on the certification site and try again.',
    '  CLIENT_ID, CLIENT_SECRET or TOKEN_URI set in your shell take precedence over the .env file, so check those if a new file changes nothing.'
  ];
};

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return 'the token endpoint';
  }
};

/**
 * Mint a fresh OAuth2 bearer token via the client_credentials grant when
 * the env carries `TOKEN_URI`, `CLIENT_ID`, and `CLIENT_SECRET`. Returns the
 * token string on success, or `undefined` when the env vars are missing or
 * the mint fails. The caller decides whether to fall through to another
 * auth path or surface the error.
 *
 * Generic enough to use for any CLI subcommand that needs a fresh provider
 * token (variations service, future provider-services endpoints, etc.).
 */
export const mintOAuth2ClientCredentialsToken = async (): Promise<string | undefined> => {
  // Credentials travel on this one, so it is never allowed to be plain HTTP.
  const tokenUriRaw = process.env.TOKEN_URI;
  const tokenUri = tokenUriRaw ? ensureHttps(tokenUriRaw, 'TOKEN_URI') : undefined;
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  if (!tokenUri || !clientId || !clientSecret) return undefined;
  // Registered where it is used: this path reads the secret from the environment, so the chokepoint
  // in resolveCliAuth never sees it.
  registerSecret(clientSecret);

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => undefined);
      const lines = describeMintRefusal(res.status, res.statusText, originOf(tokenUri), readOAuth2ErrorFields(body));
      for (const line of lines) console.error(maskSecrets(line));
      return undefined;
    }
    const parsed = (await res.json()) as { access_token?: unknown };
    if (typeof parsed.access_token !== 'string') {
      console.error('OAuth2 token mint succeeded but response had no access_token.');
      return undefined;
    }
    // Registered where it comes into existence. This value was never typed by anyone, so
    // registering the flags alone would miss it.
    registerSecret(parsed.access_token);
    return parsed.access_token;
  } catch (err) {
    console.error('OAuth2 token mint threw:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
};

/**
 * Build an AuthConfig from CLI flags.
 * Validates mutual exclusivity of --auth-token and --client-id/--client-secret/--token-url.
 */
const buildAuthFromFlags = (flags: CliAuthFlags): AuthConfig | null => {
  const hasToken = Boolean(flags.authToken);
  const hasClientCreds = Boolean(flags.clientId) || Boolean(flags.clientSecret) || Boolean(flags.tokenUrl);

  if (!hasToken && !hasClientCreds) return null;

  if (hasToken && hasClientCreds) {
    throw new Error('Cannot use --auth-token together with --client-id/--client-secret/--token-url. Choose one authentication method.');
  }

  if (hasToken) {
    return { mode: 'token', authToken: flags.authToken! };
  }

  if (!flags.clientId || !flags.clientSecret || !flags.tokenUrl) {
    throw new Error('OAuth2 Client Credentials requires all three: --client-id, --client-secret and --token-url.');
  }

  return {
    mode: 'client_credentials',
    clientId: flags.clientId,
    clientSecret: flags.clientSecret,
    tokenUrl: flags.tokenUrl
  };
};

/**
 * Resolve auth configuration from the CLI's priority chain:
 *   1. CLI flags (--auth-token or --client-id/--client-secret/--token-url)
 *   2. Config entry auth (from --config file's per-entry token/clientCredentials)
 *   3. Environment variables (RESO_AUTH_TOKEN or RESO_CLIENT_ID/RESO_CLIENT_SECRET/RESO_TOKEN_URI)
 *
 * Call loadDotEnv() before this to merge .env values into process.env.
 */
/**
 * Register whatever secrets a resolved AuthConfig carries, so they are masked wherever they later
 * surface in output.
 *
 * Done here rather than at each source because this function IS the chokepoint for all three — the
 * flags, the config entry and the environment. A registration per source would have to be kept in
 * step with the chain; this one cannot drift from it.
 */
const registerAuthSecrets = (auth: AuthConfig): AuthConfig => {
  if (auth.mode === 'token') registerSecret(auth.authToken);
  else registerSecret(auth.clientSecret);
  return auth;
};

export const resolveCliAuth = (flags: CliAuthFlags, configAuth?: AuthConfig): AuthConfig => {
  // Level 1: CLI flags
  const fromFlags = buildAuthFromFlags(flags);
  if (fromFlags) return registerAuthSecrets(fromFlags);

  // Level 2: Config entry auth
  if (configAuth) return registerAuthSecrets(configAuth);

  // Level 3: Env vars (includes .env if loadDotEnv was called)
  try {
    return registerAuthSecrets(authConfigFromEnv() as AuthConfig);
  } catch {
    throw new Error(
      'No authentication configured. Provide one of:\n' +
        '  --auth-token <token>\n' +
        '  --client-id <id> --client-secret <secret> --token-url <url>\n' +
        '  RESO_AUTH_TOKEN or RESO_CLIENT_ID/RESO_CLIENT_SECRET/RESO_TOKEN_URI env vars\n' +
        '  A config file with auth via --config <path>'
    );
  }
};
