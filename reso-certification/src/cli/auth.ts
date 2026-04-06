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
 * Load a .env file from the given directory (defaults to cwd) and merge
 * its values into process.env. Existing env vars take precedence.
 *
 * No-op if the .env file does not exist.
 */
export const loadDotEnv = (cwd?: string): void => {
  const envPath = resolve(cwd ?? process.cwd(), '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    const parsed = parseEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file not found or unreadable — that's fine
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
