/**
 * Credential resolution: the environment channel, the argument override, and what each control
 * prevents.
 *
 * Every test here is named for the failure it would allow if the control were removed. The
 * resolution decision is observable directly, because resolveAuth takes the environment as an
 * argument and returns the channel it chose, so nothing has to be inferred from a side effect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_CREDENTIAL_ARG_NAMES,
  CREDENTIAL_ARG_NAMES,
  ENV_AUTH_TOKEN,
  ENV_BASE_URL,
  ENV_CLIENT_CREDENTIAL_NAMES,
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
  ENV_SCOPE,
  ENV_TOKEN_URI
} from '../src/auth-env.js';
import { handlers, resolveAuth } from '../src/handlers.js';

// Distinctive values so an assertion that a secret did NOT travel cannot pass by coincidence.
const ENV_SECRET = 'env-secret-4f81a2';
const ARG_SECRET = 'arg-secret-9b07c3';
const ENV_TOKEN = 'env-token-1d5e9f';
const ARG_TOKEN = 'arg-token-6c2b84';
const MINTED_TOKEN = 'minted-token-a37d10';

const ENV_TOKEN_ENDPOINT = 'https://env.example.com/oauth/token';
const ARG_TOKEN_ENDPOINT = 'https://arg.example.com/oauth/token';

/** The data server the environment credential is bound to. */
const DATA_SERVER = 'http://localhost:9999';

/**
 * An environment credential is only usable when bound to a server, so every fixture that expects
 * the environment channel to SUCCEED carries the binding. Tests that assert the refusals omit it
 * deliberately and say so.
 */
const BOUND = { [ENV_BASE_URL]: DATA_SERVER };

const ENV_TRIPLE = {
  ...BOUND,
  [ENV_CLIENT_ID]: 'env-client-id',
  [ENV_CLIENT_SECRET]: ENV_SECRET,
  [ENV_TOKEN_URI]: ENV_TOKEN_ENDPOINT
};

/** A bound bearer-token environment. */
const ENV_TOKEN_SET = { ...BOUND, [ENV_AUTH_TOKEN]: ENV_TOKEN };

const ARG_TRIPLE = { clientId: 'arg-client-id', clientSecret: ARG_SECRET, tokenUrl: ARG_TOKEN_ENDPOINT };

const ALL_AUTH_ENV = [ENV_AUTH_TOKEN, ENV_CLIENT_ID, ENV_CLIENT_SECRET, ENV_TOKEN_URI, ENV_SCOPE, ENV_BASE_URL];

/**
 * Replace the whole auth environment for one test. Clearing first matters: without it a developer
 * shell that exports RESO_AUTH_TOKEN would turn a refusal test into a live request.
 */
const setAuthEnv = (values: Record<string, string> = {}): void => {
  for (const name of ALL_AUTH_ENV) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
};

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Record every outgoing request and answer token endpoints with a minted token and everything else
 * with an empty OData collection. This is the only way to watch which credential actually left the
 * process, which is the assertion that matters for a multi-server leak.
 */
const recordRequests = (tokenStatus = 200): ReadonlyArray<RecordedCall> => {
  const calls: RecordedCall[] = [];

  vi.stubGlobal('fetch', async (input: unknown, init: Record<string, unknown> = {}) => {
    const url = String(input);
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : ''
    });

    if (url.includes('/oauth/token')) {
      if (tokenStatus !== 200) {
        return new Response('{"error":"invalid_client"}', { status: tokenStatus, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ access_token: MINTED_TOKEN, token_type: 'bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  return calls;
};

const resultText = (result: { content: Array<{ text: string }> }): string => result.content[0].text;

beforeEach(() => {
  setAuthEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveAuth: the argument channel wins as a set', () => {
  // Remove the arguments-first branch and a session that passes a second server's token silently
  // authenticates against the first server's environment credentials instead.
  it('uses an argument token over an environment token', () => {
    const resolved = resolveAuth({ authToken: ARG_TOKEN }, { [ENV_AUTH_TOKEN]: ENV_TOKEN });
    expect(resolved).toEqual({ source: 'arguments', auth: { mode: 'token', authToken: ARG_TOKEN } });
  });

  // Remove it and an explicit per-call credential set for server B is ignored in favor of server A's
  // environment credentials, so B is queried with A's authority.
  it('uses an argument client-credentials set over a complete environment set, carrying no environment value', () => {
    const resolved = resolveAuth(ARG_TRIPLE, ENV_TRIPLE);
    expect(resolved.source).toBe('arguments');
    expect(resolved.auth).toEqual({
      mode: 'client_credentials',
      clientId: 'arg-client-id',
      clientSecret: ARG_SECRET,
      tokenUrl: ARG_TOKEN_ENDPOINT
    });
    expect(JSON.stringify(resolved)).not.toContain(ENV_SECRET);
    expect(JSON.stringify(resolved)).not.toContain(ENV_TOKEN_ENDPOINT);
  });

  // Remove the token-first order inside the argument channel and a caller who passes both shapes
  // gets a different mode than this server has always used (handlers.ts token check preceded the
  // client-credentials check before the environment existed).
  it('prefers an argument token over an argument client-credentials set, which is the pre-existing order', () => {
    const resolved = resolveAuth({ authToken: ARG_TOKEN, ...ARG_TRIPLE }, {});
    expect(resolved.auth.mode).toBe('token');
  });
});

describe('resolveAuth: a partial argument set is refused, never completed', () => {
  // This is the leak the design exists to prevent. Remove the refusal and per-field merging takes
  // over: clientId and tokenUrl for server B plus RESO_CLIENT_SECRET for server A posts A's secret
  // to B's token endpoint.
  it('refuses clientId plus tokenUrl rather than borrowing the client secret from the environment', () => {
    expect(() => resolveAuth({ clientId: 'arg-client-id', tokenUrl: ARG_TOKEN_ENDPOINT }, ENV_TRIPLE)).toThrow(/clientSecret/);
  });

  it('names only the missing argument and never the environment secret it declined to use', () => {
    try {
      resolveAuth({ clientId: 'arg-client-id', tokenUrl: ARG_TOKEN_ENDPOINT }, ENV_TRIPLE);
      expect.unreachable('a partial argument set must be refused');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('clientSecret');
      expect(message).not.toContain(ENV_SECRET);
      expect(message).not.toContain(ARG_SECRET);
    }
  });

  // Remove it and a single stray credential argument falls through to a bearer token from the
  // environment, so the call is authenticated by something the caller did not name.
  it('refuses one credential argument on its own even when the environment holds a usable token', () => {
    expect(() => resolveAuth({ clientId: 'arg-client-id' }, { [ENV_AUTH_TOKEN]: ENV_TOKEN })).toThrow(/Incomplete client credentials/);
  });
});

describe('resolveAuth: the environment channel', () => {
  // Remove the environment branch and there is no safe channel at all, which is the defect: the
  // only way to authenticate is to put a secret in the conversation.
  it('reads a bearer token from the environment when the call carries no credential argument', () => {
    const resolved = resolveAuth({}, ENV_TOKEN_SET);
    expect(resolved).toEqual({ source: 'environment', auth: { mode: 'token', authToken: ENV_TOKEN }, boundTo: DATA_SERVER });
  });

  it('reads a client-credentials set from the environment', () => {
    const resolved = resolveAuth({}, ENV_TRIPLE);
    expect(resolved).toEqual({
      source: 'environment',
      auth: { mode: 'client_credentials', clientId: 'env-client-id', clientSecret: ENV_SECRET, tokenUrl: ENV_TOKEN_ENDPOINT },
      boundTo: DATA_SERVER
    });
  });

  // Remove the RESO_SCOPE read and a provider that requires a scope cannot be reached from the
  // environment at all, because scope is an argument on authorize only and on no other tool.
  it('applies RESO_SCOPE to environment client credentials, and omits scope when it is unset', () => {
    const withScope = resolveAuth({}, { ...ENV_TRIPLE, [ENV_SCOPE]: 'api' });
    expect(withScope.auth).toMatchObject({ scope: 'api' });
    expect(resolveAuth({}, ENV_TRIPLE).auth).not.toHaveProperty('scope');
  });

  // Remove the triple-first order and the same .env file gives the reso-cert CLI and this server
  // different auth modes, since reso-client/src/env.ts:54 checks the triple before the token.
  it('prefers a complete environment client-credentials set over an environment token, matching reso-client', () => {
    const resolved = resolveAuth({}, { ...ENV_TRIPLE, [ENV_AUTH_TOKEN]: ENV_TOKEN });
    expect(resolved.auth.mode).toBe('client_credentials');
  });

  // Remove the partial-environment refusal and a typo such as RESO_TOKEN_URL is answered silently
  // by whatever unrelated RESO_AUTH_TOKEN happens to be exported, which is the hazard the carve names.
  it('refuses a half-configured environment set by name instead of falling through to the token', () => {
    const partial = { [ENV_CLIENT_ID]: 'env-client-id', [ENV_CLIENT_SECRET]: ENV_SECRET, [ENV_AUTH_TOKEN]: ENV_TOKEN };
    try {
      resolveAuth({}, partial);
      expect.unreachable('a half-configured environment set must be refused');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(ENV_TOKEN_URI);
      expect(message).not.toContain(ENV_SECRET);
      expect(message).not.toContain(ENV_TOKEN);
    }
  });
});

describe('resolveAuth: refusal when nothing is configured', () => {
  // Remove the refusal and an unauthenticated call proceeds with an empty token.
  it('refuses with a message naming every variable and every argument, and no value', () => {
    try {
      resolveAuth({}, {});
      expect.unreachable('an unconfigured call must be refused');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('Authorization required');
      for (const name of [ENV_AUTH_TOKEN, ...ENV_CLIENT_CREDENTIAL_NAMES]) expect(message).toContain(name);
      for (const name of CREDENTIAL_ARG_NAMES) expect(message).toContain(name);
    }
  });

  // Remove the exact-name lookups and an unrelated CLIENT_SECRET, which in this monorepo is a
  // credential for RESO's own services rather than a provider API, would authenticate a provider call.
  it('never reads an unprefixed or unrelated variable', () => {
    const lookalikes = { CLIENT_ID: 'x', CLIENT_SECRET: 'y', TOKEN_URI: 'z', AUTH_TOKEN: 'w', ADMIN_TOKEN: 'v', RESO_TOKEN_URL: 'u' };
    expect(() => resolveAuth({}, lookalikes)).toThrow(/Authorization required/);
  });

  // Remove the non-empty check and an empty string reads as a configured credential, so a blank
  // placeholder in a .env file authenticates with nothing.
  it('treats an empty string as absent in both channels', () => {
    expect(() => resolveAuth({}, { [ENV_AUTH_TOKEN]: '' })).toThrow(/Authorization required/);
    expect(resolveAuth({ authToken: '' }, ENV_TOKEN_SET).source).toBe('environment');
  });

  // Remove the injected environment parameter and the resolution decision stops being observable,
  // because every assertion would then depend on the process the test happens to run in.
  it('reads only the environment it is given, never the process environment', () => {
    vi.stubEnv(ENV_AUTH_TOKEN, 'process-token');
    expect(() => resolveAuth({}, {})).toThrow(/Authorization required/);
  });
});

describe('handlers consult the process environment: the second reader', () => {
  // resolveAuth being correct proves nothing if no handler passes process.env to it. These tests
  // watch the credential that actually left the process.
  it('sends an environment bearer token on a query that carries no credential argument', async () => {
    setAuthEnv(ENV_TOKEN_SET);
    const calls = recordRequests();

    await handlers.query({ url: DATA_SERVER, resource: 'Property' });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${ENV_TOKEN}`);
  });

  it('sends an environment bearer token on metadata too, so the chokepoint is not query-only', async () => {
    setAuthEnv(ENV_TOKEN_SET);
    const calls = recordRequests();

    // The recorded response is not CSDL, so parsing it fails. That is irrelevant here: the subject
    // is the credential on the way out. Were metadata to stop consulting the environment it would
    // refuse before any request and leave no recorded call, which is what the assertions catch.
    await handlers.metadata({ url: DATA_SERVER }).catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${ENV_TOKEN}`);
  });

  // Remove the argument override and multi-server support is gone: every call in the session goes
  // out with the one credential in the environment.
  it('sends an argument token instead of the environment token when both are present', async () => {
    setAuthEnv(ENV_TOKEN_SET);
    const calls = recordRequests();

    await handlers.query({ url: DATA_SERVER, resource: 'Property', authToken: ARG_TOKEN });

    expect(calls[0].headers.Authorization).toBe(`Bearer ${ARG_TOKEN}`);
  });

  // Two servers in one session, which is the invariant the carve protects. Remove the per-call
  // resolution and the second call inherits the first call's credential.
  it('alternates between the environment default and an explicit credential across calls in one session', async () => {
    setAuthEnv(ENV_TOKEN_SET);
    const calls = recordRequests();

    await handlers.query({ url: DATA_SERVER, resource: 'Property' });
    await handlers.query({ url: DATA_SERVER, resource: 'Property', authToken: ARG_TOKEN });
    await handlers.query({ url: DATA_SERVER, resource: 'Property' });

    expect(calls.map(call => call.headers.Authorization)).toEqual([`Bearer ${ENV_TOKEN}`, `Bearer ${ARG_TOKEN}`, `Bearer ${ENV_TOKEN}`]);
  });

  // The leak test with a count, not just an exception: nothing may reach the environment's token
  // endpoint when the call named a different server incompletely.
  it('issues no request at all when a query passes a partial credential set over a complete environment', async () => {
    setAuthEnv(ENV_TRIPLE);
    const calls = recordRequests();

    await expect(
      handlers.query({ url: DATA_SERVER, resource: 'Property', clientId: 'arg-client-id', tokenUrl: ARG_TOKEN_ENDPOINT })
    ).rejects.toThrow(/Incomplete client credentials/);

    expect(calls).toHaveLength(0);
  });

  // Remove the environment client-credentials branch and the only environment shape that works is a
  // bearer token, which expires and so pushes users back to pasting credentials.
  it('mints from environment client credentials and sends the minted token on the data request', async () => {
    setAuthEnv(ENV_TRIPLE);
    const calls = recordRequests();

    await handlers.query({ url: DATA_SERVER, resource: 'Property' });

    expect(calls[0].url).toBe(ENV_TOKEN_ENDPOINT);
    expect(new URLSearchParams(calls[0].body).get('client_secret')).toBe(ENV_SECRET);
    expect(calls[1].headers.Authorization).toBe(`Bearer ${MINTED_TOKEN}`);
  });

  // run-compliance resolves through buildAuthConfig rather than resolveAuthToken. Remove the
  // environment read there and the certification tools stay argument-only while the rest moved on.
  it('resolves run-compliance credentials from the environment, so it fails on the endorsement and not on auth', async () => {
    setAuthEnv(ENV_TOKEN_SET);

    await expect(handlers['run-compliance']({ endorsement: 'nonexistent', url: DATA_SERVER })).rejects.toThrow(/Unknown endorsement/);
  });

  it('refuses run-compliance when neither channel is configured', async () => {
    await expect(handlers['run-compliance']({ endorsement: 'core', url: DATA_SERVER })).rejects.toThrow(/Authorization required/);
  });
});

describe('authorize does not return a token', () => {
  // The defect itself. Remove the discard and the minted bearer token is written into conversation
  // history, where it is readable by anything that can read the transcript.
  it('reports mode, channel and endpoint, and never the minted token or the client secret', async () => {
    setAuthEnv(ENV_TRIPLE);
    recordRequests();

    const result = await handlers.authorize({});
    const text = resultText(result);

    expect(result.isError).toBeFalsy();
    expect(text).not.toContain(MINTED_TOKEN);
    expect(text).not.toContain(ENV_SECRET);

    const reported = JSON.parse(text);
    expect(reported.mode).toBe('client_credentials');
    expect(reported.source).toBe('environment');
    expect(reported.tokenEndpoint).toBe(ENV_TOKEN_ENDPOINT);
    expect(reported).not.toHaveProperty('token');
  });

  // Remove the source field and a user cannot tell whether the check exercised the environment they
  // just configured or an argument that happened to be passed.
  it('reports the arguments channel and hits the argument endpoint when credentials are passed', async () => {
    setAuthEnv(ENV_TRIPLE);
    const calls = recordRequests();

    const reported = JSON.parse(resultText(await handlers.authorize(ARG_TRIPLE)));

    expect(reported.source).toBe('arguments');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ARG_TOKEN_ENDPOINT);
    expect(new URLSearchParams(calls[0].body).get('client_secret')).toBe(ARG_SECRET);
  });

  // Remove the empty required list and the tool cannot be called without arguments, which is what
  // made an assistant ask the user to paste a client secret in the first place.
  it('checks the environment with no arguments at all', async () => {
    setAuthEnv(ENV_TRIPLE);
    const calls = recordRequests();

    const result = await handlers.authorize({});

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENV_TOKEN_ENDPOINT);
  });

  // Remove the token-mode branch and a configured bearer token is sent to a token endpoint that
  // does not exist, or the tool claims an exchange that never happened.
  it('makes no request and claims no verification when a bearer token is configured', async () => {
    setAuthEnv(ENV_TOKEN_SET);
    const calls = recordRequests();

    const text = resultText(await handlers.authorize({}));
    const reported = JSON.parse(text);

    expect(calls).toHaveLength(0);
    expect(reported.mode).toBe('token');
    expect(reported.source).toBe('environment');
    expect(reported.message).toContain('nothing was checked');
    expect(text).not.toContain(ENV_TOKEN);
  });

  it('refuses when neither channel is configured', async () => {
    await expect(handlers.authorize({})).rejects.toThrow(/Authorization required/);
  });

  // Remove the scope overlay and a provider that requires a scope cannot be checked at all from
  // environment credentials.
  it('sends an argument scope over RESO_SCOPE, and RESO_SCOPE when no argument scope is given', async () => {
    setAuthEnv({ ...ENV_TRIPLE, [ENV_SCOPE]: 'env-scope' });
    const calls = recordRequests();

    await handlers.authorize({ scope: 'arg-scope' });
    await handlers.authorize({});

    expect(new URLSearchParams(calls[0].body).get('scope')).toBe('arg-scope');
    expect(new URLSearchParams(calls[1].body).get('scope')).toBe('env-scope');
  });

  // Remove the origin-and-path reduction and a token URL configured with a secret in its query
  // string is echoed into the result text verbatim.
  it('reports the token endpoint without its query string', async () => {
    setAuthEnv({ ...ENV_TRIPLE, [ENV_TOKEN_URI]: `${ENV_TOKEN_ENDPOINT}?client_secret=${ENV_SECRET}` });
    recordRequests();

    const text = resultText(await handlers.authorize({}));

    expect(JSON.parse(text).tokenEndpoint).toBe(ENV_TOKEN_ENDPOINT);
    expect(text).not.toContain(ENV_SECRET);
  });

  // The error path. A fix that keeps a secret out of the success body but lets it into a failure
  // message has fixed nothing.
  it('carries no credential in the message when the token endpoint rejects the credentials', async () => {
    setAuthEnv(ENV_TRIPLE);
    recordRequests(401);

    try {
      await handlers.authorize({});
      expect.unreachable('a 401 from the token endpoint must reject');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('401');
      expect(message).not.toContain(ENV_SECRET);
      expect(message).not.toContain('env-client-id');
    }
  });
});

describe('no credential is required by any tool argument', () => {
  // These two live here rather than in tools.test.ts because they guard the credential channel
  // itself: the required list is what makes an assistant ask a user for a secret.
  it('passes the four credential argument names the resolver reads to every credential test', () => {
    expect([...CREDENTIAL_ARG_NAMES]).toEqual(['authToken', 'clientId', 'clientSecret', 'tokenUrl']);
    expect([...CLIENT_CREDENTIAL_ARG_NAMES]).toEqual(['clientId', 'clientSecret', 'tokenUrl']);
  });

  // Remove the pinning and a rename in reso-client, or a typo here, silently changes which variable
  // a reader must set, while the documentation keeps naming the old one.
  it('pins the environment variable names to the declared convention', () => {
    expect(ENV_AUTH_TOKEN).toBe('RESO_AUTH_TOKEN');
    expect(ENV_CLIENT_ID).toBe('RESO_CLIENT_ID');
    expect(ENV_CLIENT_SECRET).toBe('RESO_CLIENT_SECRET');
    expect(ENV_TOKEN_URI).toBe('RESO_TOKEN_URI');
    expect(ENV_SCOPE).toBe('RESO_SCOPE');
  });
});

describe('the environment credential is bound to one server', () => {
  const OTHER_SERVER = 'https://not-the-members-server.example';

  // THE control this binding exists for. Without it an environment credential is ambient: no caller
  // chose it for this call, and `url` is a free-form argument the model fills in, so the secret is
  // collected by whatever host that argument names. Remove the binding and this call sends the
  // member's bearer token to OTHER_SERVER.
  it('refuses a call that targets a host other than the bound server', () => {
    expect(() => resolveAuth({ url: OTHER_SERVER }, ENV_TOKEN_SET)).toThrow(/bound to/);
  });

  it('refuses a client-credentials environment for an unbound host before minting anything', () => {
    expect(() => resolveAuth({ url: OTHER_SERVER }, ENV_TRIPLE)).toThrow(/bound to/);
  });

  // The refusal must name the two hosts so the operator can see the mismatch, and must not name the
  // credential it declined to use.
  it('names both hosts in the refusal and no secret', () => {
    try {
      resolveAuth({ url: OTHER_SERVER }, ENV_TRIPLE);
      throw new Error('expected a refusal');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(DATA_SERVER);
      expect(message).toContain(OTHER_SERVER);
      expect(message).not.toContain(ENV_SECRET);
      expect(message).not.toContain('env-client-id');
    }
  });

  it('uses the environment credential when the call targets the bound server', () => {
    expect(resolveAuth({ url: DATA_SERVER }, ENV_TOKEN_SET).source).toBe('environment');
  });

  // The binding must not be brittle: a path or a trailing slash is the same server.
  it('matches on origin, so a path or trailing slash on the same server still resolves', () => {
    expect(resolveAuth({ url: `${DATA_SERVER}/` }, ENV_TOKEN_SET).source).toBe('environment');
    expect(resolveAuth({ url: `${DATA_SERVER}/odata/Property` }, ENV_TOKEN_SET).source).toBe('environment');
  });

  // Protocol is part of the origin deliberately. A credential set for the secure origin must not
  // travel over the insecure one for the same host.
  it('refuses an http call when the binding is https on the same host', () => {
    const httpsBound = { ...ENV_TOKEN_SET, [ENV_BASE_URL]: 'https://data.example.com' };
    expect(() => resolveAuth({ url: 'http://data.example.com' }, httpsBound)).toThrow(/bound to/);
  });

  it('refuses a different port on the same host', () => {
    expect(() => resolveAuth({ url: 'http://localhost:8080' }, ENV_TOKEN_SET)).toThrow(/bound to/);
  });

  // A target that does not parse fails closed rather than being waved through.
  it('refuses a target url that does not parse', () => {
    expect(() => resolveAuth({ url: 'not-a-url' }, ENV_TOKEN_SET)).toThrow(/bound to/);
  });

  // An environment credential with no binding at all is refused rather than used everywhere. Remove
  // this and an operator who sets only the credential gets the ambient behavior back silently.
  it('refuses an environment credential when the base url is not set', () => {
    expect(() => resolveAuth({ url: DATA_SERVER }, { [ENV_AUTH_TOKEN]: ENV_TOKEN })).toThrow(/RESO_BASE_URL is not set/);
  });

  it('refuses an environment client-credentials set when the base url is not set', () => {
    const { [ENV_BASE_URL]: _dropped, ...unbound } = ENV_TRIPLE;
    expect(() => resolveAuth({ url: DATA_SERVER }, unbound)).toThrow(/RESO_BASE_URL is not set/);
  });

  // An argument credential carries no binding, because the caller chose the credential and the host
  // together. Binding it would break multi-server use, which is the point of the argument channel.
  it('leaves an argument credential unbound, so it reaches any host the caller names', () => {
    const resolved = resolveAuth({ url: OTHER_SERVER, authToken: ARG_TOKEN }, ENV_TOKEN_SET);
    expect(resolved.source).toBe('arguments');
    expect(resolved.boundTo).toBeUndefined();
  });

  // authorize contacts only the token endpoint carried by the credential itself and returns no
  // token, so it has no data server to constrain.
  it('allows a call with no target url, which is authorize', () => {
    expect(resolveAuth({}, ENV_TRIPLE).source).toBe('environment');
  });
});

describe('the binding holds at the handler, not just the resolver', () => {
  const OTHER_SERVER = 'https://not-the-members-server.example';

  // The two-reader assertion. resolveAuth refusing proves nothing if a handler never passes the
  // call's url to it. This watches the wire: the secret must not leave the process at all.
  it('sends NO request when a query targets a host the environment credential is not bound to', async () => {
    setAuthEnv(ENV_TOKEN_SET);
    const calls = recordRequests();

    await handlers.query({ url: OTHER_SERVER, resource: 'Property' }).catch(() => undefined);

    expect(calls).toHaveLength(0);
  });

  it('sends no request on metadata either, so the check is not query-only', async () => {
    setAuthEnv(ENV_TOKEN_SET);
    const calls = recordRequests();

    await handlers.metadata({ url: OTHER_SERVER }).catch(() => undefined);

    expect(calls).toHaveLength(0);
  });

  it('still reaches the bound server, so the check is not refusing everything', async () => {
    setAuthEnv(ENV_TOKEN_SET);
    const calls = recordRequests();

    await handlers.query({ url: DATA_SERVER, resource: 'Property' }).catch(() => undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${ENV_TOKEN}`);
  });
});
