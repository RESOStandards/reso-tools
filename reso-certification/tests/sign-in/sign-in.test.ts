/**
 * Signing in with an emailed code, against a stubbed Cert API.
 *
 * The contract is the requests made (the routes, `mode: "cli"`, the bearer only where a token is due), what each
 * answer becomes, and what is refused before anything is sent. Tokens here are synthetic.
 */
import { describe, expect, it, vi } from 'vitest';
import { mayAsk } from '../../src/sign-in/member-access.js';
import {
  CODE_NOT_ACCEPTED,
  SIGN_IN_ENDED,
  SIGN_IN_MODE,
  readSession,
  renewAccess,
  requestCode,
  revoke,
  subjectOf,
  verifyCode
} from '../../src/sign-in/sign-in.js';
import { RENEW_BEFORE_MS, openSignedInSession } from '../../src/sign-in/signed-in-session.js';

const API = 'https://cert-api.example.org';
const SUB = 'subject-0001';

/** A token shaped like a JWT, carrying `sub`. Not signed: nothing here verifies it. */
const jwtFor = (claims: Readonly<Record<string, unknown>>, tag = 'a'): string =>
  ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify(claims)).toString('base64url'), `sig-${tag}`].join('.');

const ACCESS = jwtFor({ sub: SUB }, 'first');
const RENEWED = jwtFor({ sub: SUB }, 'renewed');
const REFRESH = 'SENTINEL-refresh-token-for-tests';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A `fetch` that records each call and answers with `answer`. */
const recording = (answer: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    return answer(call);
  });
  return { fetch, calls };
};

describe('asking for a code', () => {
  it('posts the address with mode "cli" to /api/v1/session/login and keeps the sign-in the server opened', async () => {
    const { fetch, calls } = recording(() => json(200, { session: 'cognito-session', codeSent: true }));
    const opened = await requestCode({ apiOrigin: API, fetch, email: ' person@example.org ' });
    expect(opened).toEqual({ session: 'cognito-session' });
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: `${API}/api/v1/session/login`,
        body: { email: 'person@example.org', mode: SIGN_IN_MODE }
      })
    ]);
    expect(SIGN_IN_MODE).toBe('cli');
    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
  });

  it('reads a null session as no sign-in opened, the answer the server gives an address it does not know', async () => {
    const { fetch } = recording(() => json(200, { session: null, codeSent: true }));
    expect(await requestCode({ apiOrigin: API, fetch, email: 'nobody@example.org' })).toEqual({});
  });

  it("refuses a malformed address in the server's own words", async () => {
    const { fetch } = recording(() => json(400, { message: '"email" must be a valid email' }));
    await expect(requestCode({ apiOrigin: API, fetch, email: 'not-an-address' })).rejects.toMatchObject({
      status: 400,
      message: '"email" must be a valid email'
    });
  });

  it('says which address could not be reached when the request fails outright', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND cert-api.example.org') });
    });
    await expect(requestCode({ apiOrigin: API, fetch, email: 'person@example.org' })).rejects.toMatchObject({
      status: 0,
      message: `Could not reach the Cert API at ${API}: getaddrinfo ENOTFOUND cert-api.example.org`
    });
  });
});

describe('answering with the code', () => {
  it('posts the address, code, sign-in and mode "cli" to /verify and returns the tokens', async () => {
    const { fetch, calls } = recording(() => json(200, { accessToken: ACCESS, idToken: 'id', refreshToken: REFRESH, expiresIn: 3600 }));
    const tokens = await verifyCode({ apiOrigin: API, fetch, email: 'person@example.org', code: ' 123456 ', session: 'cognito-session' });
    expect(tokens).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600 });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/api/v1/session/verify`,
      body: { email: 'person@example.org', code: '123456', session: 'cognito-session', mode: 'cli' }
    });
  });

  it('refuses a code typed when no sign-in was opened, without a request, in the words a wrong code gets', async () => {
    const { fetch } = recording(() => json(200, {}));
    await expect(verifyCode({ apiOrigin: API, fetch, email: 'nobody@example.org', code: '123456' })).rejects.toMatchObject({
      status: 401,
      message: CODE_NOT_ACCEPTED
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives a refused code the server's words, and a request-shape refusal the plain ones", async () => {
    const refused = recording(() => json(401, { message: 'Incorrect code.' }));
    await expect(
      verifyCode({ apiOrigin: API, fetch: refused.fetch, email: 'p@example.org', code: '1', session: 's' })
    ).rejects.toMatchObject({ status: 401, message: 'Incorrect code.' });

    const shape = recording(() => json(400, { message: 'Validation failed' }));
    await expect(verifyCode({ apiOrigin: API, fetch: shape.fetch, email: 'p@example.org', code: '1', session: 's' })).rejects.toMatchObject(
      { status: 400, message: CODE_NOT_ACCEPTED }
    );
  });

  it('does not blame the code when the Cert API failed to check it', async () => {
    const { fetch } = recording(() => json(502, { message: 'Bad gateway' }));
    await expect(verifyCode({ apiOrigin: API, fetch, email: 'p@example.org', code: '1', session: 's' })).rejects.toMatchObject({
      status: 502,
      message: 'The Cert API could not check the code (HTTP 502).'
    });
  });

  it('refuses an accepted code whose answer carries no complete sign-in', async () => {
    const { fetch } = recording(() => json(200, { accessToken: ACCESS }));
    await expect(verifyCode({ apiOrigin: API, fetch, email: 'p@example.org', code: '1', session: 's' })).rejects.toMatchObject({
      message: 'The Cert API accepted the code but did not return a complete sign-in.'
    });
  });
});

describe('renewing, reading and revoking', () => {
  it('renews with mode "cli", the refresh token and the subject', async () => {
    const { fetch, calls } = recording(() => json(200, { accessToken: RENEWED, expiresIn: 3600 }));
    expect(await renewAccess({ apiOrigin: API, fetch, refreshToken: REFRESH, sub: SUB })).toEqual({
      accessToken: RENEWED,
      expiresIn: 3600
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/api/v1/session/refresh`,
      body: { mode: 'cli', refreshToken: REFRESH, sub: SUB }
    });
  });

  it('says the sign-in has ended when the refresh token is refused', async () => {
    const { fetch } = recording(() => json(401, { authenticated: false }));
    await expect(renewAccess({ apiOrigin: API, fetch, refreshToken: REFRESH, sub: SUB })).rejects.toMatchObject({
      status: 401,
      message: SIGN_IN_ENDED
    });
  });

  it('reads who is signed in with the bearer, keeping only the fields the Cert API knows', async () => {
    const { fetch, calls } = recording(() => json(200, { authenticated: true, isAdmin: false, email: 'person@example.org', groups: [] }));
    expect(await readSession({ apiOrigin: API, fetch, accessToken: ACCESS })).toEqual({
      kind: 'signed-in',
      person: { isAdmin: false, email: 'person@example.org' }
    });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/api/v1/session`, headers: { Authorization: `Bearer ${ACCESS}` } });
  });

  it("reads a member services refusal as an answer with the Cert API's code and reason, not as an error", async () => {
    const notMember = recording(() =>
      json(403, { authenticated: false, code: 'desktop_not_available', message: 'The desktop app is for RESO members.' })
    );
    expect(await readSession({ apiOrigin: API, fetch: notMember.fetch, accessToken: ACCESS })).toEqual({
      kind: 'refused',
      status: 403,
      code: 'desktop_not_available',
      message: 'The desktop app is for RESO members.'
    });

    const unknown = recording(() => json(503, { code: 'member_access_unavailable', message: 'Membership could not be checked.' }));
    expect(await readSession({ apiOrigin: API, fetch: unknown.fetch, accessToken: ACCESS })).toMatchObject({
      kind: 'refused',
      code: 'member_access_unavailable'
    });
  });

  it('says the sign-in has ended when the token is refused outright', async () => {
    const { fetch } = recording(() => json(401, { authenticated: false }));
    await expect(readSession({ apiOrigin: API, fetch, accessToken: ACCESS })).rejects.toMatchObject({
      status: 401,
      message: SIGN_IN_ENDED
    });
  });

  it('revokes with DELETE and the refresh token in the body, and no bearer', async () => {
    const { fetch, calls } = recording(() => json(200, { success: true }));
    expect(await revoke({ apiOrigin: API, fetch, refreshToken: REFRESH })).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `${API}/api/v1/session`, body: { refreshToken: REFRESH } });
    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
  });

  it('reads the subject from a token without verifying it, and nothing from a token that is not a JWT', () => {
    expect(subjectOf(ACCESS)).toBe(SUB);
    expect(subjectOf('not-a-jwt')).toBeUndefined();
    expect(subjectOf('a.%%%.c')).toBeUndefined();
    expect(subjectOf(jwtFor({ name: 'no subject' }))).toBeUndefined();
  });
});

describe('the session', () => {
  const opened = (fetch: typeof globalThis.fetch, clock: { now: number }, onSecret?: (value: string) => void) =>
    openSignedInSession({
      apiOrigin: API,
      fetch,
      tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600 },
      now: () => clock.now,
      ...(onSecret === undefined ? {} : { onSecret })
    });

  it('uses the access token as it is while it is fresh, with no request', async () => {
    const { fetch } = recording(() => json(500, {}));
    const session = opened(fetch, { now: 0 });
    expect(await session.authorization()).toBe(`Bearer ${ACCESS}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renews once when a request finds the token within a minute of expiring, then uses the new one', async () => {
    const { fetch, calls } = recording(() => json(200, { accessToken: RENEWED, expiresIn: 3600 }));
    const clock = { now: 0 };
    const session = opened(fetch, clock);
    clock.now = 3600 * 1000 - RENEW_BEFORE_MS - 1;
    expect(await session.authorization()).toBe(`Bearer ${ACCESS}`);
    clock.now += 1;
    expect(await session.authorization()).toBe(`Bearer ${RENEWED}`);
    expect(await session.authorization()).toBe(`Bearer ${RENEWED}`);
    expect(calls.map(call => call.url)).toEqual([`${API}/api/v1/session/refresh`]);
  });

  it('renews once for two requests that find the token stale together', async () => {
    const { fetch, calls } = recording(() => json(200, { accessToken: RENEWED, expiresIn: 3600 }));
    const clock = { now: 0 };
    const session = opened(fetch, clock);
    clock.now = 3600 * 1000;
    const both = await Promise.all([session.authorization(), session.authorization()]);
    expect(both).toEqual([`Bearer ${RENEWED}`, `Bearer ${RENEWED}`]);
    expect(calls).toHaveLength(1);
  });

  it('hands every token to onSecret as it comes into existence', async () => {
    const { fetch } = recording(() => json(200, { accessToken: RENEWED, expiresIn: 3600 }));
    const seen: string[] = [];
    const clock = { now: 0 };
    const session = opened(fetch, clock, value => seen.push(value));
    expect(seen).toEqual([ACCESS, REFRESH]);
    clock.now = 3600 * 1000;
    await session.authorization();
    expect(seen).toEqual([ACCESS, REFRESH, RENEWED]);
  });

  it('signs out once: revokes, forgets both tokens, and refuses to be used after', async () => {
    const { fetch, calls } = recording(() => json(200, {}));
    const session = opened(fetch, { now: 0 });
    expect(await session.end()).toBe(true);
    expect(await session.end()).toBe(false);
    await expect(session.authorization()).rejects.toMatchObject({ status: 401, message: SIGN_IN_ENDED });
    await expect(session.check()).rejects.toMatchObject({ status: 401, message: SIGN_IN_ENDED });
    expect(calls.map(call => call.method)).toEqual(['DELETE']);
  });

  it('reports a sign-out the Cert API did not confirm, and still forgets the tokens', async () => {
    const { fetch } = recording(() => {
      throw new TypeError('fetch failed');
    });
    const session = opened(fetch, { now: 0 });
    expect(await session.end()).toBe(false);
    await expect(session.authorization()).rejects.toMatchObject({ message: SIGN_IN_ENDED });
  });

  it('does not keep a token renewed while the session was being signed out', async () => {
    const release: { go?: () => void } = {};
    const { fetch } = recording(call =>
      call.method === 'DELETE'
        ? json(200, {})
        : new Promise<Response>(resolve => {
            release.go = () => resolve(json(200, { accessToken: RENEWED, expiresIn: 3600 }));
          })
    );
    const clock = { now: 0 };
    const session = opened(fetch, clock);
    clock.now = 3600 * 1000;
    const pending = session.authorization();
    await vi.waitFor(() => expect(release.go).toBeDefined());
    await session.end();
    release.go?.();
    await expect(pending).rejects.toMatchObject({ message: SIGN_IN_ENDED });
  });

  it('cannot renew a token that names no subject, and says the sign-in has ended without a request', async () => {
    const { fetch } = recording(() => json(200, {}));
    const session = openSignedInSession({
      apiOrigin: API,
      fetch,
      tokens: { accessToken: 'SENTINEL-opaque-token-for-tests', refreshToken: REFRESH, expiresIn: 0 },
      now: () => 0
    });
    await expect(session.authorization()).rejects.toMatchObject({ message: SIGN_IN_ENDED });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('who may ask', () => {
  it('allows a person the Cert API says who they are', () => {
    expect(mayAsk({ kind: 'signed-in', person: { isAdmin: false } })).toEqual({ allowed: true });
  });

  it("refuses on any refusal, with the Cert API's reason", () => {
    expect(mayAsk({ kind: 'refused', status: 403, code: 'desktop_not_available', message: 'For RESO members.' })).toEqual({
      allowed: false,
      reason: 'For RESO members.'
    });
    expect(mayAsk({ kind: 'refused', status: 503, code: 'member_access_unavailable', message: 'Not checked.' })).toEqual({
      allowed: false,
      reason: 'Not checked.'
    });
  });
});
