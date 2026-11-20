/**
 * A signed-in person's session, held in memory for as long as it runs.
 *
 * `SignedInSession` is what a consumer such as the interactive shell asks for: a current `Authorization` value, what
 * the Cert API says about the person now, and a way to sign out. Signing in with an emailed code is one way to get
 * one (`openSignedInSession`); an app the person is already signed in to can supply its own, so the same consumer
 * runs inside it unchanged.
 *
 * The tokens never leave this closure. They are not written anywhere and never returned, except the access token
 * inside the `Authorization` value a request needs. The access token is renewed on demand, when a request finds it
 * within a minute of expiring, rather than on a timer: a session nobody is using makes no requests.
 */
import {
  type CertApiTransport,
  SIGN_IN_ENDED,
  type SessionAnswer,
  type SignInTokens,
  readSession,
  renewAccess,
  revoke,
  signInFailure,
  subjectOf
} from './sign-in.js';

export interface SignedInSession {
  /** The `Authorization` value for RESO's services, renewed first when the access token is close to expiring. */
  readonly authorization: () => Promise<string>;
  /** What the Cert API says about this person now: who they are, or why member services are refused. */
  readonly check: () => Promise<SessionAnswer>;
  /**
   * Signs out: the refresh token is revoked at the Cert API, and both tokens are forgotten. Resolves true when the
   * Cert API confirmed the revocation. Calling it again does nothing and resolves false.
   */
  readonly end: () => Promise<boolean>;
}

/** Renew this long before the access token expires, so a request never sets out with a token about to lapse. */
export const RENEW_BEFORE_MS = 60_000;

export interface OpenSessionInput extends CertApiTransport {
  readonly tokens: SignInTokens;
  /** The clock, in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Called with every token as it comes into existence, so a caller can mask it in anything printed. */
  readonly onSecret?: (value: string) => void;
}

/**
 * Holds a session opened with an emailed code.
 *
 * The state below is the one mutable thing here, and it is shared on purpose: every request in a session needs the
 * token the last renewal produced. It lives in this closure only. A renewal already under way is shared too, so two
 * requests that find the token stale at once renew it once.
 */
export const openSignedInSession = (input: OpenSessionInput): SignedInSession => {
  const now = input.now ?? Date.now;
  const transport: CertApiTransport = { apiOrigin: input.apiOrigin, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) };
  const sub = subjectOf(input.tokens.accessToken);
  const state: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt: number;
    renewing?: Promise<string>;
  } = {
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
    expiresAt: now() + input.tokens.expiresIn * 1000
  };
  input.onSecret?.(input.tokens.accessToken);
  input.onSecret?.(input.tokens.refreshToken);

  const renew = async (): Promise<string> => {
    const refreshToken = state.refreshToken;
    if (refreshToken === undefined || sub === undefined) throw signInFailure(401, SIGN_IN_ENDED);
    const renewed = await renewAccess({ ...transport, refreshToken, sub });
    input.onSecret?.(renewed.accessToken);
    // Signed out while the renewal was under way: the new token is not kept.
    if (state.refreshToken === undefined) throw signInFailure(401, SIGN_IN_ENDED);
    state.accessToken = renewed.accessToken;
    state.expiresAt = now() + renewed.expiresIn * 1000;
    return renewed.accessToken;
  };

  const currentToken = async (): Promise<string> => {
    const token = state.accessToken;
    if (token === undefined) throw signInFailure(401, SIGN_IN_ENDED);
    if (now() < state.expiresAt - RENEW_BEFORE_MS) return token;
    state.renewing ??= renew().finally(() => {
      state.renewing = undefined;
    });
    return state.renewing;
  };

  return {
    authorization: async () => `Bearer ${await currentToken()}`,
    check: async () => readSession({ ...transport, accessToken: await currentToken() }),
    end: async () => {
      const refreshToken = state.refreshToken;
      state.accessToken = undefined;
      state.refreshToken = undefined;
      if (refreshToken === undefined) return false;
      return revoke({ ...transport, refreshToken }).catch(() => false);
    }
  };
};
