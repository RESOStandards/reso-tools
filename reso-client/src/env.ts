/**
 * Build an AuthConfig from environment variables.
 *
 * Supports two modes:
 * - Bearer token: RESO_AUTH_TOKEN
 * - Client Credentials: RESO_CLIENT_ID, RESO_CLIENT_SECRET, RESO_TOKEN_URI
 *
 * Client Credentials takes precedence when all three vars are set.
 * Optional: RESO_SCOPE, RESO_EXPIRES_IN (default TTL in seconds).
 */

import type { AuthConfig } from './types.js';

const ENV_AUTH_TOKEN = 'RESO_AUTH_TOKEN';
const ENV_CLIENT_ID = 'RESO_CLIENT_ID';
const ENV_CLIENT_SECRET = 'RESO_CLIENT_SECRET';
const ENV_TOKEN_URI = 'RESO_TOKEN_URI';
const ENV_SCOPE = 'RESO_SCOPE';
const ENV_EXPIRES_IN = 'RESO_EXPIRES_IN';
const ENV_BASE_URL = 'RESO_BASE_URL';

const AUTH_MODE_TOKEN = 'token' as const;
const AUTH_MODE_CLIENT_CREDENTIALS = 'client_credentials' as const;

export interface EnvConfig {
  readonly baseUrl: string;
  readonly auth: AuthConfig;
}

/**
 * Read an AuthConfig from process.env.
 * Throws if no valid auth configuration is found.
 *
 * @example
 * ```bash
 * # Bearer token
 * RESO_AUTH_TOKEN=my-token node script.js
 *
 * # Client Credentials
 * RESO_CLIENT_ID=id RESO_CLIENT_SECRET=secret RESO_TOKEN_URI=https://auth.example.com/token node script.js
 *
 * # Using .env file (Node 22+)
 * node --env-file=.env script.js
 * ```
 */
export const authConfigFromEnv = (env: Record<string, string | undefined> = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}): AuthConfig => {
  const clientId = env[ENV_CLIENT_ID];
  const clientSecret = env[ENV_CLIENT_SECRET];
  const tokenUri = env[ENV_TOKEN_URI];

  if (clientId && clientSecret && tokenUri) {
    const scope = env[ENV_SCOPE];
    const expiresInRaw = env[ENV_EXPIRES_IN];
    const defaultExpiresIn = expiresInRaw ? Number.parseInt(expiresInRaw, 10) : undefined;

    return {
      mode: AUTH_MODE_CLIENT_CREDENTIALS,
      clientId,
      clientSecret,
      tokenUrl: tokenUri,
      ...(scope ? { scope } : {}),
      ...(defaultExpiresIn ? { defaultExpiresIn } : {}),
    };
  }

  const authToken = env[ENV_AUTH_TOKEN];
  if (authToken) {
    return { mode: AUTH_MODE_TOKEN, authToken };
  }

  throw new Error(
    `No auth configuration found. Set either ${ENV_AUTH_TOKEN} (bearer token) or ${ENV_CLIENT_ID}, ${ENV_CLIENT_SECRET}, and ${ENV_TOKEN_URI} (client credentials).`
  );
};

/**
 * Read a full EnvConfig (base URL + auth) from process.env.
 * Throws if RESO_BASE_URL or auth vars are missing.
 */
export const configFromEnv = (env: Record<string, string | undefined> = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}): EnvConfig => {
  const baseUrl = env[ENV_BASE_URL];
  if (!baseUrl) {
    throw new Error(`${ENV_BASE_URL} environment variable is required.`);
  }

  return {
    baseUrl,
    auth: authConfigFromEnv(env),
  };
};
