/**
 * Credential names for the MCP server, declared in one place.
 *
 * The environment names are the ones reso-client already declares for the same purpose
 * (reso-client/src/env.ts:14-18) and the reso-cert CLI already reads as its lowest-priority auth
 * source (reso-certification/src/cli/auth.ts:141). One shell configuration therefore serves the CLI
 * and this server, a reader of either tool meets one convention, and the secret is held once.
 *
 * The RESO_ prefix is load-bearing. The unprefixed TOKEN_URI, CLIENT_ID and CLIENT_SECRET that
 * reso-certification reads (reso-certification/src/cli/auth.ts:60-63) are credentials for RESO's own
 * services, not for a data provider's API. The five names below are the provider credential only,
 * and no unprefixed variable is ever read.
 *
 * Both the reader in handlers.ts and the tool-schema descriptions in tools.ts import these names, so
 * a schema description cannot come to name a variable the reader does not read.
 */

/** Bearer token for the provider API. */
export const ENV_AUTH_TOKEN = 'RESO_AUTH_TOKEN';

/** OAuth2 client ID. Read only together with the client secret and the token URI. */
export const ENV_CLIENT_ID = 'RESO_CLIENT_ID';

/** OAuth2 client secret. Read only together with the client ID and the token URI. */
export const ENV_CLIENT_SECRET = 'RESO_CLIENT_SECRET';

/** OAuth2 token endpoint. Named URI rather than URL to match the declared convention. */
export const ENV_TOKEN_URI = 'RESO_TOKEN_URI';

/** Optional OAuth2 scope, applied to environment client credentials. */
export const ENV_SCOPE = 'RESO_SCOPE';

/**
 * The one data server the environment credential may be sent to. REQUIRED whenever an environment
 * credential is set, and the reason is the whole point of binding it.
 *
 * An environment credential is ambient: no caller chose it for the call being made. Without a bound
 * destination it is collected by whatever host a call's `url` happens to name, and that `url` is a
 * free-form argument the model fills in. So an unbound default turns a convenience into a way to
 * send a member's secret to an arbitrary host. Bound, it is only ever sent where the operator who
 * set it said it belongs.
 *
 * Declared by reso-client for the same purpose and already paired with the credential there
 * (reso-client/src/env.ts:21, and `configFromEnv` at :85-99 returns the base URL and the auth config
 * together rather than separately).
 */
export const ENV_BASE_URL = 'RESO_BASE_URL';

/** The three variables that form one client-credentials set. The order is the order messages name them in. */
export const ENV_CLIENT_CREDENTIAL_NAMES: ReadonlyArray<string> = [ENV_CLIENT_ID, ENV_CLIENT_SECRET, ENV_TOKEN_URI];

/**
 * The tool arguments that carry a credential. Any one of them present makes a call argument-sourced,
 * so both the resolver and its tests read this list rather than restating the four names.
 */
export const CREDENTIAL_ARG_NAMES: ReadonlyArray<string> = ['authToken', 'clientId', 'clientSecret', 'tokenUrl'];

/** The three tool arguments that form one client-credentials set. */
export const CLIENT_CREDENTIAL_ARG_NAMES: ReadonlyArray<string> = ['clientId', 'clientSecret', 'tokenUrl'];
