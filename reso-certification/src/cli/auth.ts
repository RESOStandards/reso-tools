/**
 * CLI auth resolution chain: flags > config entry > .env file > env vars.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { authConfigFromEnv } from '@reso-standards/reso-client';
import type { AuthConfig } from '../test-runner/types.js';

/** CLI option flags related to authentication. */
export interface CliAuthFlags {
  readonly authToken?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
}

/**
 * Load a .env file from the first directory in `searchPaths` that contains
 * one, merging its values into process.env. Existing env vars take precedence.
 *
 * If no `searchPaths` argument is given, falls back to `[process.cwd()]` —
 * preserves the old single-cwd behavior.
 *
 * No-op if no .env file is found in any of the search paths.
 */
export const loadDotEnv = (searchPaths?: ReadonlyArray<string>): void => {
  const paths = searchPaths && searchPaths.length > 0 ? searchPaths : [process.cwd()];
  for (const dir of paths) {
    const envPath = resolve(dir, '.env');
    try {
      const content = readFileSync(envPath, 'utf-8');
      const parsed = parseEnv(content);
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
      return;
    } catch {
      // try next path
    }
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
  const tokenUri = process.env.TOKEN_URI;
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  if (!tokenUri || !clientId || !clientSecret) return undefined;

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      console.error(`OAuth2 token mint failed: HTTP ${res.status} ${res.statusText}`);
      return undefined;
    }
    const parsed = (await res.json()) as { access_token?: unknown };
    if (typeof parsed.access_token !== 'string') {
      console.error('OAuth2 token mint succeeded but response had no access_token.');
      return undefined;
    }
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
    throw new Error('OAuth2 Client Credentials requires all three: --client-id, --client-secret, and --token-url.');
  }

  return {
    mode: 'client_credentials',
    clientId: flags.clientId,
    clientSecret: flags.clientSecret,
    tokenUrl: flags.tokenUrl,
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
export const resolveCliAuth = (flags: CliAuthFlags, configAuth?: AuthConfig): AuthConfig => {
  // Level 1: CLI flags
  const fromFlags = buildAuthFromFlags(flags);
  if (fromFlags) return fromFlags;

  // Level 2: Config entry auth
  if (configAuth) return configAuth;

  // Level 3: Env vars (includes .env if loadDotEnv was called)
  try {
    return authConfigFromEnv() as AuthConfig;
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
