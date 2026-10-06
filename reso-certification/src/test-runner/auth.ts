/**
 * Authentication helpers — delegates to @reso-standards/reso-client.
 */

import { fetchAccessToken as clientFetchAccessToken, resolveToken } from '@reso-standards/reso-client';
import { registerSecret } from '../cli/secrets.js';
import type { AuthConfig } from './types.js';

/**
 * Resolves an AuthConfig to a bearer token string.
 * For "token" mode, returns the token directly.
 * For "client_credentials" mode, performs the OAuth2 token exchange.
 */
export const resolveAuthToken = async (auth: AuthConfig): Promise<string> => {
  // The returned value is written into the pipeline context, which is what `--output json`
  // serializes, so this is the single most important value to have registered.
  const register = async (p: Promise<string>): Promise<string> => {
    const token = await p;
    registerSecret(token);
    return token;
  };
  if (auth.mode === 'token') {
    return register(resolveToken({ mode: 'token', authToken: auth.authToken }));
  }
  return register(
    resolveToken({
      mode: 'client_credentials',
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      tokenUrl: auth.tokenUrl,
      scope: auth.scope
    })
  );
};

/**
 * Performs an OAuth2 Client Credentials grant to obtain an access token.
 */
export const fetchAccessToken = clientFetchAccessToken;
