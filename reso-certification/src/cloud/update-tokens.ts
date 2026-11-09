/**
 * Token providers for live cloud-run updates: one for each kind of caller the engine already serves. Each is asked
 * again on every connect, so a token that expired while the connection was open is refreshed by the reconnect.
 *
 * None of them holds new token logic. The session provider reads what the caller's own session holds, the CLI
 * provider runs the same mint chain as `cloud status` and `--start-cloud-run`, and the bearer provider hands back
 * what it was given.
 */

import { mintOAuth2ClientCredentialsToken } from '../cli/auth.js';
import { registerSecret } from '../cli/secrets.js';
import { mintProviderToken } from '../sdk/common.js';
import type { CloudTokenProvider } from './updates.js';

const nonEmpty = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * A signed-in session: the desktop's session today, and the CLI's emailed-code sign-in once it exists. `getAccessToken`
 * returns the session's current access token, refreshing it however the session does, and is called on every connect.
 */
export const sessionTokenProvider =
  (getAccessToken: () => Promise<string | undefined> | string | undefined): CloudTokenProvider =>
  async () => {
    const current = await getAccessToken();
    return nonEmpty(current) ? current : undefined;
  };

/**
 * A bearer the caller already holds, such as the desktop's session token passed in once. It is the same on every
 * connect, so once it expires a reconnect is refused; a caller whose token refreshes should use `sessionTokenProvider`.
 */
export const bearerTokenProvider =
  (bearer: string): CloudTokenProvider =>
  async () =>
    nonEmpty(bearer) ? bearer : undefined;

/**
 * The CLI's credentials, from the credentials file or the environment: an OAuth2 client-credentials token from
 * `TOKEN_URI`, `CLIENT_ID` and `CLIENT_SECRET`, falling back to the `CERT_AUTH_API_*` provider-token mint. The same
 * chain as `cloud status`, minted fresh on every connect.
 */
export const cliCredentialsTokenProvider = (): CloudTokenProvider => async () => {
  const minted = (await mintOAuth2ClientCredentialsToken()) ?? (await mintProviderToken());
  if (!nonEmpty(minted)) return undefined;
  registerSecret(minted);
  return minted;
};
