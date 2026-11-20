/**
 * Signing a person in to RESO's certification services with the code emailed to them.
 *
 * The same flow certification.reso.org and the desktop app use, asked with `mode: "cli"` so the tokens come back in
 * the response body. Anyone who can sign in to certification.reso.org can sign in this way. What they may do once
 * signed in is decided where it is used: `GET /session` says whether member services are open to them (see
 * `member-access.ts`), and every service checks the token again on its own.
 *
 * Transport only. Nothing here keeps a token: `signed-in-session.ts` holds them, in memory, for as long as a session
 * runs.
 *
 *   requestCode   POST   /api/v1/session/login     a code is emailed, when the address can sign in
 *   verifyCode    POST   /api/v1/session/verify    the code is exchanged for tokens
 *   renewAccess   POST   /api/v1/session/refresh   a new access token, from the refresh token and the subject
 *   readSession   GET    /api/v1/session           who the token belongs to, or why member services are refused
 *   revoke        DELETE /api/v1/session           the refresh token is revoked, not merely forgotten
 */

/** The `mode` that asks for tokens in the body. The desktop app has its own mode; this one is the command line's. */
export const SIGN_IN_MODE = 'cli';

/** Where people sign in: the Cert API behind certification.reso.org. */
export const DEFAULT_CERT_API_ORIGIN = 'https://cert-api.reso.org';

export const SESSION_PATH = '/api/v1/session';

/**
 * Said for a refused code, and for any code typed after the server opened no sign-in. The server answers a request for
 * a code the same way whether or not the address can sign in, so a code typed for an address it does not know has to
 * fail the way a wrong code fails, or this tool would tell anyone which addresses hold an account.
 */
export const CODE_NOT_ACCEPTED = 'That code did not work. Check it and try again, or start again for a new code.';

/** Said when the refresh token no longer works, or the session was signed out. */
export const SIGN_IN_ENDED = 'Your sign-in has ended. Sign in again.';

/** The message celebrate gives a request of the wrong shape. It is about the request, never about the person's code. */
const VALIDATION_ENVELOPE = 'Validation failed';

/** An error from signing in: `status` is the Cert API's HTTP status, or 0 when it could not be reached. */
export interface SignInFailure extends Error {
  readonly status: number;
  /** The Cert API's own code for a refusal, when it sent one. */
  readonly code?: string;
}

export const signInFailure = (status: number, message: string, code?: string): SignInFailure =>
  Object.assign(new Error(message), { status, ...(code === undefined ? {} : { code }) });

export const isSignInFailure = (value: unknown): value is SignInFailure =>
  value instanceof Error && typeof (value as { status?: unknown }).status === 'number';

/** Where the Cert API is, and the `fetch` to reach it with. */
export interface CertApiTransport {
  /** An origin, such as `https://cert-api.reso.org`. */
  readonly apiOrigin: string;
  readonly fetch?: typeof fetch;
}

/** The tokens a verified code returns. Held in memory by the session; never written and never printed. */
export interface SignInTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds until the access token expires. */
  readonly expiresIn: number;
}

/** Who the Cert API says the token belongs to. A field it does not know is absent, not blank. */
export interface SignedInPerson {
  readonly email?: string;
  readonly fullName?: string;
  readonly isAdmin: boolean;
}

/** What `GET /session` answers: who the person is, or the Cert API's refusal of member services, with its reason. */
export type SessionAnswer =
  | { readonly kind: 'signed-in'; readonly person: SignedInPerson }
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly message: string };

type Body = Readonly<Record<string, unknown>> | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

const readBody = async (response: Response): Promise<Body> => {
  const parsed: unknown = await response.json().catch(() => undefined);
  return isRecord(parsed) ? parsed : undefined;
};

/** One request to the session routes. A network failure becomes a `SignInFailure` with status 0 and the address. */
const call = async (
  transport: CertApiTransport,
  path: string,
  init: RequestInit
): Promise<{ readonly status: number; readonly ok: boolean; readonly body: Body }> => {
  const response = await (transport.fetch ?? fetch)(`${transport.apiOrigin}${SESSION_PATH}${path}`, init).catch((error: unknown) => {
    const reason =
      error instanceof Error ? (nonEmpty((error as { cause?: { message?: unknown } }).cause?.message) ?? error.message) : String(error);
    throw signInFailure(0, `Could not reach the Cert API at ${transport.apiOrigin}: ${reason}`);
  });
  return { status: response.status, ok: response.ok, body: await readBody(response) };
};

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' } as const;

const post = (transport: CertApiTransport, path: string, body: Readonly<Record<string, unknown>>) =>
  call(transport, path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

/**
 * A sign-in the server opened, to carry into `verifyCode`. Absent when it opened none, which it answers in the same
 * words as when it did.
 */
export interface CodeRequest {
  readonly session?: string;
}

/** Asks for a code to be emailed. Resolves whether or not the address can sign in; a malformed address is refused. */
export const requestCode = async (input: CertApiTransport & { readonly email: string }): Promise<CodeRequest> => {
  const { status, ok, body } = await post(input, '/login', { email: input.email.trim(), mode: SIGN_IN_MODE });
  if (!ok) {
    throw signInFailure(status, nonEmpty(body?.message) ?? `Could not ask for a code (HTTP ${status}).`);
  }
  const session = nonEmpty(body?.session);
  return session === undefined ? {} : { session };
};

const tokensFrom = (body: Body): SignInTokens | undefined => {
  const accessToken = nonEmpty(body?.accessToken);
  const refreshToken = nonEmpty(body?.refreshToken);
  const expiresIn = body?.expiresIn;
  return accessToken === undefined || refreshToken === undefined || typeof expiresIn !== 'number'
    ? undefined
    : { accessToken, refreshToken, expiresIn };
};

/**
 * Exchanges the emailed code for tokens. A refused code throws with the server's own words; a code typed when no
 * sign-in was opened is refused here, without a request, in the words a wrong code gets.
 */
export const verifyCode = async (
  input: CertApiTransport & { readonly email: string; readonly code: string; readonly session?: string }
): Promise<SignInTokens> => {
  if (input.session === undefined) throw signInFailure(401, CODE_NOT_ACCEPTED);
  const { status, ok, body } = await post(input, '/verify', {
    email: input.email.trim(),
    code: input.code.trim(),
    session: input.session,
    mode: SIGN_IN_MODE
  });
  if (!ok) {
    const message = nonEmpty(body?.message);
    const said = message !== undefined && message !== VALIDATION_ENVELOPE ? message : undefined;
    throw signInFailure(status, status >= 500 ? `The Cert API could not check the code (HTTP ${status}).` : (said ?? CODE_NOT_ACCEPTED));
  }
  const tokens = tokensFrom(body);
  if (tokens === undefined) throw signInFailure(status, 'The Cert API accepted the code but did not return a complete sign-in.');
  return tokens;
};

/** A new access token. The subject goes beside the refresh token because the server's secret hash is computed over it. */
export const renewAccess = async (
  input: CertApiTransport & { readonly refreshToken: string; readonly sub: string }
): Promise<{ readonly accessToken: string; readonly expiresIn: number }> => {
  const { status, ok, body } = await post(input, '/refresh', { mode: SIGN_IN_MODE, refreshToken: input.refreshToken, sub: input.sub });
  if (status === 401) throw signInFailure(401, SIGN_IN_ENDED);
  const accessToken = nonEmpty(body?.accessToken);
  if (!ok || accessToken === undefined || typeof body?.expiresIn !== 'number') {
    throw signInFailure(status, `The sign-in could not be renewed (HTTP ${status}).`);
  }
  return { accessToken, expiresIn: body.expiresIn };
};

/** Who the access token belongs to, or the Cert API's refusal of member services with its code and reason. */
export const readSession = async (input: CertApiTransport & { readonly accessToken: string }): Promise<SessionAnswer> => {
  const { status, ok, body } = await call(input, '', {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` }
  });
  const code = nonEmpty(body?.code);
  const message = nonEmpty(body?.message);
  if (!ok && code !== undefined && message !== undefined) return { kind: 'refused', status, code, message };
  if (status === 401) throw signInFailure(401, SIGN_IN_ENDED);
  if (!ok || body?.authenticated !== true) throw signInFailure(status, `The Cert API did not say who is signed in (HTTP ${status}).`);
  const email = nonEmpty(body.email);
  const fullName = nonEmpty(body.fullName);
  return {
    kind: 'signed-in',
    person: {
      isAdmin: body.isAdmin === true,
      ...(email === undefined ? {} : { email }),
      ...(fullName === undefined ? {} : { fullName })
    }
  };
};

/** Revokes the refresh token at the Cert API. True when the Cert API confirmed it. */
export const revoke = async (input: CertApiTransport & { readonly refreshToken: string }): Promise<boolean> => {
  const { ok } = await call(input, '', {
    method: 'DELETE',
    headers: JSON_HEADERS,
    body: JSON.stringify({ refreshToken: input.refreshToken })
  });
  return ok;
};

/**
 * The `sub` claim of a JWT, read without verifying it. The Cert API verifies tokens; this only needs the subject the
 * renewal must carry. Undefined when the token carries none.
 */
export const subjectOf = (token: string): string | undefined => {
  const payload = token.split('.')[1];
  if (payload === undefined || payload === '') return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(claims) ? nonEmpty(claims.sub) : undefined;
  } catch {
    return undefined;
  }
};
