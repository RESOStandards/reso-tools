/**
 * `reso-cert shell` over scripted input, against a stubbed Cert API and Assistant.
 *
 * The contract: signing in with an emailed code, who may ask checked before each question is sent, follow-ups
 * sent with the recent turns, the session revoked however the shell ends, and no token in anything shown. Tokens here
 * are synthetic.
 */
import { describe, expect, it, vi } from 'vitest';
import { HISTORY_TURNS, MAX_CODE_ATTEMPTS, SHELL_EXIT, type ShellIo, describeSession, runShell } from '../../src/cli/shell-command.js';
import { CODE_NOT_ACCEPTED, SIGN_IN_ENDED } from '../../src/sign-in/sign-in.js';
import type { SignedInSession } from '../../src/sign-in/signed-in-session.js';

const API = 'https://cert-api.example.org';
const ASSISTANT = 'https://assistant.example.org';
const EMAIL = 'person@example.org';
const CODE = '123456';

const jwtFor = (claims: Readonly<Record<string, unknown>>, tag: string): string =>
  ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify(claims)).toString('base64url'), `sig-${tag}`].join('.');

const ACCESS = jwtFor({ sub: 'subject-0001' }, 'access');
const REFRESH = 'SENTINEL-refresh-token-for-tests';

const MEMBER = { authenticated: true, isAdmin: false, email: EMAIL, fullName: 'Pat Person', groups: [] };
const NOT_MEMBER = { authenticated: false, code: 'desktop_not_available', message: 'The desktop app is for RESO members.' };

const answerTo = (question: string) => ({
  answer: `Answer to: ${question}`,
  citations: [{ id: 'dd-versions', title: 'Data Dictionary versions' }],
  sectionReviews: []
});

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface World {
  /** What `GET /session` answers. */
  readonly session?: { readonly status: number; readonly body: unknown };
  /** What `POST /session/login` answers. */
  readonly login?: { readonly status: number; readonly body: unknown };
  /** Codes `/verify` accepts. Any other is refused with 401. */
  readonly goodCodes?: ReadonlyArray<string>;
  /** Answers `POST /ask`; default, an answer naming the question. */
  readonly ask?: (call: Call, init: RequestInit | undefined) => Response | Promise<Response>;
}

/** A stub of both services, recording every call. */
const services = (world: World = {}) => {
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    const route = `${call.method} ${call.url}`;
    if (route === `POST ${API}/api/v1/session/login`) {
      return json(world.login?.status ?? 200, world.login?.body ?? { session: 'cognito-session', codeSent: true });
    }
    if (route === `POST ${API}/api/v1/session/verify`) {
      const code = (call.body as { code?: string }).code ?? '';
      return (world.goodCodes ?? [CODE]).includes(code)
        ? json(200, { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600 })
        : json(401, { message: 'Incorrect code.' });
    }
    if (route === `GET ${API}/api/v1/session`) return json(world.session?.status ?? 200, world.session?.body ?? MEMBER);
    if (route === `DELETE ${API}/api/v1/session`) return json(200, { success: true });
    if (route === `POST ${ASSISTANT}/ask`) {
      return world.ask?.(call, init) ?? json(200, answerTo((call.body as { question: string }).question));
    }
    return json(404, { message: `No route for ${route}` });
  });
  return { fetch, calls, routes: () => calls.map(call => `${call.method} ${call.url.replace(API, '').replace(ASSISTANT, '')}`) };
};

/** Input typed line by line, then the end of input. */
const scripted = (lines: ReadonlyArray<string>) => {
  const queue = [...lines];
  const printed: string[] = [];
  const noted: string[] = [];
  const prompts: string[] = [];
  const io: ShellIo = {
    read: async prompt => {
      prompts.push(prompt);
      return queue.shift();
    },
    print: text => {
      printed.push(text);
    },
    note: text => {
      noted.push(text);
    }
  };
  return { io, printed, noted, prompts, everything: () => [...printed, ...noted].join('\n') };
};

const questionsSent = (calls: ReadonlyArray<Call>) =>
  calls.filter(call => call.url === `${ASSISTANT}/ask`).map(call => call.body as { question: string; history?: unknown });

describe('signing in and asking', () => {
  it('signs in with the typed address and code, says who, answers, and signs out at /exit', async () => {
    const { fetch, calls, routes } = services();
    const term = scripted([EMAIL, CODE, 'What is the current Data Dictionary?', '/exit']);
    const code = await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });

    expect(code).toBe(SHELL_EXIT.left);
    expect(routes()).toEqual([
      'POST /api/v1/session/login',
      'POST /api/v1/session/verify',
      'GET /api/v1/session',
      'GET /api/v1/session',
      'POST /ask',
      'DELETE /api/v1/session'
    ]);
    expect(term.prompts.slice(0, 2)).toEqual(['Email: ', 'Code: ']);
    expect(term.noted).toContain(`If ${EMAIL} can sign in to certification.reso.org, a code is on its way to it.`);
    expect(term.noted).toContain(`Signed in as Pat Person (${EMAIL}).\nQuestions to the Assistant are available.`);
    expect(term.printed[0]).toContain('Answer to: What is the current Data Dictionary?');
    expect(term.noted.at(-1)).toBe('Signed out.');
    expect(calls.find(call => call.method === 'DELETE')?.body).toEqual({ refreshToken: REFRESH });
  });

  it('sends the question to the Assistant with the signed-in bearer', async () => {
    const seen: string[] = [];
    const { fetch } = services({
      ask: (call, init) => {
        seen.push(new Headers(init?.headers).get('Authorization') ?? '');
        return json(200, answerTo((call.body as { question: string }).question));
      }
    });
    await runShell({ io: scripted([EMAIL, CODE, 'A question']).io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(seen).toEqual([`Bearer ${ACCESS}`]);
  });

  it('skips the address prompt when one was given', async () => {
    const { fetch } = services();
    const term = scripted([CODE, '/exit']);
    await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch, email: EMAIL });
    expect(term.prompts[0]).toBe('Code: ');
  });

  it('sends follow-ups with the recent answered turns, at most HISTORY_TURNS, and none after /new', async () => {
    const { fetch, calls } = services();
    const questions = Array.from({ length: HISTORY_TURNS + 2 }, (_, index) => `Question ${index + 1}`);
    const term = scripted([EMAIL, CODE, ...questions, '/new', 'Fresh question']);
    await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });

    const sent = questionsSent(calls);
    expect(sent[0]).not.toHaveProperty('history');
    expect(sent[1]?.history).toEqual([{ question: 'Question 1', answer: 'Answer to: Question 1' }]);
    const last = sent[HISTORY_TURNS + 1]?.history as ReadonlyArray<{ question: string }>;
    expect(last.map(turn => turn.question)).toEqual(questions.slice(1, HISTORY_TURNS + 1));
    expect(sent.at(-1)).toEqual({ question: 'Fresh question' });
    expect(term.noted).toContain('Started a new conversation.');
  });

  it('signs out at the end of input, as at /exit', async () => {
    const { fetch, routes } = services();
    const code = await runShell({ io: scripted([EMAIL, CODE]).io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(code).toBe(SHELL_EXIT.left);
    expect(routes().at(-1)).toBe('DELETE /api/v1/session');
  });

  it('answers /whoami and /help, and names a slash command it does not know without sending it', async () => {
    const { fetch, calls } = services();
    const term = scripted([EMAIL, CODE, '/whoami', '/help', '/report 42', 'quit']);
    await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(term.printed[0]).toBe(`Signed in as Pat Person (${EMAIL}).\nQuestions to the Assistant are available.`);
    expect(term.printed[1]).toContain('/whoami');
    expect(term.noted).toContain('/report is not a shell command. Type /help for the list.');
    expect(questionsSent(calls)).toHaveLength(0);
  });
});

describe('who may ask', () => {
  it("signs a non-member in, says questions are not available in the Cert API's words, and sends no question", async () => {
    const { fetch, calls, routes } = services({ session: { status: 403, body: NOT_MEMBER } });
    const term = scripted([EMAIL, CODE, 'What is the current Data Dictionary?', '/exit']);
    const code = await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });

    expect(code).toBe(SHELL_EXIT.left);
    expect(term.noted).toContain(`Signed in as ${EMAIL}.\nQuestions to the Assistant are not available. ${NOT_MEMBER.message}`);
    expect(term.noted).toContain(`Not sent. ${NOT_MEMBER.message}`);
    expect(questionsSent(calls)).toHaveLength(0);
    expect(routes().at(-1)).toBe('DELETE /api/v1/session');
  });

  it('names the address signed in with when /whoami is asked by a non-member', async () => {
    const { fetch } = services({ session: { status: 403, body: NOT_MEMBER } });
    const term = scripted([EMAIL, CODE, '/whoami']);
    await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(term.printed).toEqual([`Signed in as ${EMAIL}.\nQuestions to the Assistant are not available. ${NOT_MEMBER.message}`]);
  });

  it('checks before every question, so access withdrawn mid-session stops the next one', async () => {
    const answers = [
      { status: 200, body: MEMBER },
      { status: 200, body: MEMBER },
      { status: 403, body: NOT_MEMBER }
    ];
    const base = services();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET' && String(input) === `${API}/api/v1/session`) {
        const next = answers.shift() ?? { status: 403, body: NOT_MEMBER };
        return json(next.status, next.body);
      }
      return base.fetch(input, init);
    });
    const term = scripted([EMAIL, CODE, 'First', 'Second']);
    await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(questionsSent(base.calls).map(sent => sent.question)).toEqual(['First']);
    expect(term.noted).toContain(`Not sent. ${NOT_MEMBER.message}`);
  });

  it('tells the person when the Assistant refuses the sign-in, and keeps the shell open', async () => {
    const { fetch } = services({ ask: () => json(403, { message: 'Not in the beta.' }) });
    const term = scripted([EMAIL, CODE, 'A question', '/whoami']);
    await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(term.noted.some(line => line.startsWith('The Assistant did not accept this sign-in:'))).toBe(true);
    expect(term.printed).toHaveLength(1);
  });
});

describe('codes', () => {
  it('lets a refused code be typed again, with the same sign-in', async () => {
    const { fetch, calls } = services();
    const term = scripted([EMAIL, '000000', CODE, '/exit']);
    const code = await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(code).toBe(SHELL_EXIT.left);
    expect(term.noted).toContain('Incorrect code.');
    const verifies = calls.filter(call => call.url.endsWith('/verify')).map(call => (call.body as { session: string }).session);
    expect(verifies).toEqual(['cognito-session', 'cognito-session']);
  });

  it(`stops after ${MAX_CODE_ATTEMPTS} refused codes, without a session to sign out`, async () => {
    const { fetch, routes } = services();
    const term = scripted([EMAIL, ...Array.from({ length: MAX_CODE_ATTEMPTS + 1 }, () => '000000')]);
    const code = await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(code).toBe(SHELL_EXIT.notSignedIn);
    expect(routes().filter(route => route.endsWith('/verify'))).toHaveLength(MAX_CODE_ATTEMPTS);
    expect(term.noted).toContain(`${MAX_CODE_ATTEMPTS} codes did not work. Run reso-cert shell again for a new code.`);
    expect(routes()).not.toContain('DELETE /api/v1/session');
  });

  it('fails a code for an address the server opened no sign-in for the way a wrong code fails, without sending it', async () => {
    const { fetch, routes } = services({ login: { status: 200, body: { session: null, codeSent: true } } });
    const term = scripted(['nobody@example.org', CODE]);
    const code = await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(code).toBe(SHELL_EXIT.notSignedIn);
    expect(term.noted).toContain('If nobody@example.org can sign in to certification.reso.org, a code is on its way to it.');
    expect(term.noted).toContain(CODE_NOT_ACCEPTED);
    expect(routes()).toEqual(['POST /api/v1/session/login']);
  });

  it('does not sign in when no address or no code is typed', async () => {
    const none = services();
    expect(await runShell({ io: scripted([]).io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch: none.fetch })).toBe(
      SHELL_EXIT.notSignedIn
    );
    expect(none.calls).toHaveLength(0);

    const noCode = services();
    expect(await runShell({ io: scripted([EMAIL, '']).io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch: noCode.fetch })).toBe(
      SHELL_EXIT.notSignedIn
    );
  });

  it('reports a Cert API it cannot reach as an error, with nothing to sign out', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const term = scripted([EMAIL]);
    expect(await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch })).toBe(SHELL_EXIT.error);
    expect(term.noted.at(-1)).toBe(`Error: Could not reach the Cert API at ${API}: fetch failed`);
  });
});

describe('ending', () => {
  it('stops a question under way and signs out when interrupted', async () => {
    const stop = new AbortController();
    const { fetch, routes } = services({
      ask: (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
          stop.abort();
        })
    });
    const term = scripted([EMAIL, CODE, 'A long question', 'Never read']);
    const code = await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch, signal: stop.signal });
    expect(code).toBe(SHELL_EXIT.left);
    expect(term.noted).toContain('Stopped.');
    expect(routes().filter(route => route === 'POST /ask')).toHaveLength(1);
    expect(routes().at(-1)).toBe('DELETE /api/v1/session');
  });

  it('leaves the shell when the sign-in has ended, and says so', async () => {
    const { fetch } = services({ session: { status: 401, body: { authenticated: false } } });
    const term = scripted([EMAIL, CODE, 'A question']);
    const code = await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(code).toBe(SHELL_EXIT.error);
    expect(term.noted).toContain(`Error: ${SIGN_IN_ENDED}`);
  });

  it('says so when the Cert API did not confirm the sign-out', async () => {
    const base = services();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
      init?.method === 'DELETE' ? json(502, {}) : base.fetch(input, init)
    );
    const term = scripted([EMAIL, CODE]);
    await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(term.noted.at(-1)).toBe('Signed out here. The Cert API did not confirm it, so the sign-in ends when it expires.');
  });

  it('shows no token anywhere, whatever happens', async () => {
    const { fetch } = services();
    const term = scripted([EMAIL, '000000', CODE, '/whoami', 'A question', '/nope', '/exit']);
    await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch });
    expect(term.everything()).not.toContain(ACCESS);
    expect(term.everything()).not.toContain(REFRESH);
  });
});

describe('a session the host already holds', () => {
  it('uses it without signing in, and leaves it open for the host to end', async () => {
    const { fetch, routes } = services();
    const end = vi.fn(async () => true);
    const session: SignedInSession = {
      authorization: async () => 'Bearer SENTINEL-host-token-for-tests',
      check: async () => ({ kind: 'signed-in', person: { isAdmin: false, email: EMAIL } }),
      end
    };
    const term = scripted(['A question', '/exit']);
    const code = await runShell({ io: term.io, apiOrigin: API, assistantOrigin: ASSISTANT, fetch, session });
    expect(code).toBe(SHELL_EXIT.left);
    expect(routes()).toEqual(['POST /ask']);
    expect(end).not.toHaveBeenCalled();
    expect(term.prompts[0]).toBe('reso> ');
  });
});

describe('describing the session', () => {
  it('names the person by what the Cert API knows, falling back to the address typed', () => {
    expect(describeSession({ kind: 'signed-in', person: { isAdmin: false } }, EMAIL)).toBe(
      `Signed in as ${EMAIL}.\nQuestions to the Assistant are available.`
    );
    expect(describeSession({ kind: 'signed-in', person: { isAdmin: false } })).toBe(
      'Signed in.\nQuestions to the Assistant are available.'
    );
    expect(describeSession({ kind: 'signed-in', person: { isAdmin: true, fullName: 'Pat Person' } })).toBe(
      'Signed in as Pat Person.\nQuestions to the Assistant are available.'
    );
  });
});
