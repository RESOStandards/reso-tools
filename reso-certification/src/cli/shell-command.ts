/**
 * `reso-cert shell`: sign in with the code emailed to you, then ask RESO's Assistant questions, with follow-ups.
 *
 * Anyone who can sign in to certification.reso.org can sign in here. Asking is a member service, open to the people
 * the desktop app admits; `mayAsk` decides, from what the Cert API says, before each question is sent. The session is
 * held in memory only and is revoked when the shell ends, however it ends: `/exit`, Ctrl-D, or Ctrl-C.
 *
 * The shell runs over a small `ShellIo` rather than the terminal directly, so a host that already has the person
 * signed in can run it with its own session and its own input and output.
 */
import { createInterface } from 'node:readline';
import { type AskAnswer, type AskTurn, askAssistant, isAskFailure } from '../assistant/ask.js';
import { mayAsk } from '../sign-in/member-access.js';
import {
  DEFAULT_CERT_API_ORIGIN,
  SIGN_IN_ENDED,
  type SessionAnswer,
  isSignInFailure,
  requestCode,
  verifyCode
} from '../sign-in/sign-in.js';
import { type SignedInSession, openSignedInSession } from '../sign-in/signed-in-session.js';
import { renderAnswer, resolveAssistantOrigin, withoutRepeats } from './ask-command.js';
import { resolveCertApiOrigin } from './cert-api-credential.js';

/** How the shell reads and writes. */
export interface ShellIo {
  /** Shows `prompt` and resolves the line typed, or undefined at the end of input. */
  readonly read: (prompt: string) => Promise<string | undefined>;
  /** What the person asked to see: answers, `/whoami`, `/help`. */
  readonly print: (text: string) => void;
  /** Progress, notices and errors. */
  readonly note: (text: string) => void;
}

/** The answered turns sent with a question, most recent last, so a follow-up is read in context. */
export const HISTORY_TURNS = 4;

/** Codes that may be tried against one emailed code before the shell asks the person to start again. */
export const MAX_CODE_ATTEMPTS = 3;

export const PROMPT = 'reso> ';

/** 0 signed in and left; 1 not signed in; 2 anything else went wrong. */
export const SHELL_EXIT = { left: 0, notSignedIn: 1, error: 2 } as const;

const EXIT_COMMANDS: ReadonlySet<string> = new Set(['/exit', '/quit', 'exit', 'quit']);

export const SHELL_HELP = [
  "Type a question and press Enter to ask RESO's Assistant. A follow-up is read with the answers before it.",
  '',
  '  /new      Start a new conversation',
  '  /whoami   Who is signed in, and whether questions are available',
  '  /help     This list',
  '  /exit     Sign out and leave. Ctrl-D and Ctrl-C sign out too.'
].join('\n');

export interface ShellOptions {
  readonly io: ShellIo;
  /** Where the Assistant answers, already resolved. */
  readonly assistantOrigin: string;
  /** The Cert API to sign in at. Not used when `session` is given. */
  readonly apiOrigin: string;
  /** The address to sign in with. Asked for when absent. */
  readonly email?: string;
  /** A session the host already holds. The shell uses it and leaves it open: the host signs out, not the shell. */
  readonly session?: SignedInSession;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Called with every token as it comes into existence, so the caller can mask it in anything printed. */
  readonly onSecret?: (value: string) => void;
  /** Stops the question under way and ends the shell, such as on Ctrl-C. */
  readonly signal?: AbortSignal;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const blankToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

const transportOf = (options: ShellOptions) => ({
  apiOrigin: options.apiOrigin,
  ...(options.fetch === undefined ? {} : { fetch: options.fetch })
});

/** Asks for the code until one works, the person gives up, or `MAX_CODE_ATTEMPTS` have been refused. */
const enterCode = async (
  options: ShellOptions,
  email: string,
  session: string | undefined,
  attempt: number
): Promise<SignedInSession | undefined> => {
  if (attempt > MAX_CODE_ATTEMPTS) {
    options.io.note(`${MAX_CODE_ATTEMPTS} codes did not work. Run reso-cert shell again for a new code.`);
    return undefined;
  }
  const code = blankToUndefined(await options.io.read('Code: '));
  if (code === undefined) return undefined;
  try {
    const tokens = await verifyCode({ ...transportOf(options), email, code, ...(session === undefined ? {} : { session }) });
    return openSignedInSession({
      ...transportOf(options),
      tokens,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onSecret === undefined ? {} : { onSecret: options.onSecret })
    });
  } catch (error) {
    if (!isSignInFailure(error) || (error.status !== 400 && error.status !== 401)) throw error;
    options.io.note(error.message);
    return enterCode(options, email, session, attempt + 1);
  }
};

/** Signs in with an emailed code. Undefined when the person did not finish. */
const signInWithCode = async (
  options: ShellOptions
): Promise<{ readonly session: SignedInSession; readonly email: string } | undefined> => {
  const email = blankToUndefined(options.email ?? (await options.io.read('Email: ')));
  if (email === undefined) return undefined;
  const opened = await requestCode({ ...transportOf(options), email });
  options.io.note(`If ${email} can sign in to certification.reso.org, a code is on its way to it.`);
  const session = await enterCode(options, email, opened.session, 1);
  return session === undefined ? undefined : { session, email };
};

/** Who is signed in, and whether questions are open to them, in a person's words. */
export const describeSession = (answer: SessionAnswer, email?: string): string => {
  if (answer.kind === 'refused') {
    return [
      `Signed in${email === undefined ? '' : ` as ${email}`}.`,
      `Questions to the Assistant are not available. ${answer.message}`
    ].join('\n');
  }
  const address = answer.person.email ?? email;
  const name = answer.person.fullName;
  const who = name === undefined ? address : address === undefined ? name : `${name} (${address})`;
  return [`Signed in${who === undefined ? '' : ` as ${who}`}.`, 'Questions to the Assistant are available.'].join('\n');
};

/** Lines typed at the prompt, until the end of input or a stop. */
async function* linesFrom(io: ShellIo, signal: AbortSignal | undefined): AsyncGenerator<string> {
  while (signal?.aborted !== true) {
    const line = await io.read(PROMPT);
    if (line === undefined) return;
    yield line;
  }
}

/** One question: checked with `mayAsk`, then sent with the recent turns. The answer, or undefined when none came. */
const askOne = async (
  options: ShellOptions,
  session: SignedInSession,
  question: string,
  history: ReadonlyArray<AskTurn>
): Promise<AskAnswer | undefined> => {
  const { io } = options;
  const permission = mayAsk(await session.check());
  if (!permission.allowed) {
    io.note(`Not sent. ${permission.reason}`);
    return undefined;
  }
  try {
    const answer = await askAssistant({
      origin: options.assistantOrigin,
      authorization: await session.authorization(),
      question,
      ...(history.length > 0 ? { history } : {}),
      onStatus: withoutRepeats(text => io.note(`… ${text}`)),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    io.print(renderAnswer(answer));
    return answer;
  } catch (error) {
    if (options.signal?.aborted === true) {
      io.note('Stopped.');
      return undefined;
    }
    if (isAskFailure(error) && (error.status === 401 || error.status === 403)) {
      io.note(`The Assistant did not accept this sign-in: ${error.message}`);
      return undefined;
    }
    throw error;
  }
};

/** True when the error means the session is over and the shell should stop. */
const sessionIsOver = (error: unknown): boolean => isSignInFailure(error) && error.status === 401 && error.message === SIGN_IN_ENDED;

/**
 * One line typed at the prompt, other than an exit. `turns` is the conversation so far, owned by `converse`; a question
 * that is answered is added to it, and `/new` empties it.
 */
const handleLine = async (options: ShellOptions, session: SignedInSession, text: string, turns: AskTurn[]): Promise<void> => {
  const { io } = options;
  const command = text.toLowerCase();
  if (command === '/help') return io.print(SHELL_HELP);
  if (command === '/whoami') return io.print(describeSession(await session.check(), options.email));
  if (command === '/new') {
    turns.splice(0, turns.length);
    return io.note('Started a new conversation.');
  }
  if (text.startsWith('/')) return io.note(`${text.split(/\s/)[0]} is not a shell command. Type /help for the list.`);
  const answer = await askOne(options, session, text, turns.slice(-HISTORY_TURNS));
  if (answer !== undefined) turns.push({ question: text, answer: answer.answer });
};

/** The prompt loop. The conversation's turns live here and nowhere else. */
const converse = async (options: ShellOptions, session: SignedInSession): Promise<void> => {
  const turns: AskTurn[] = [];
  for await (const line of linesFrom(options.io, options.signal)) {
    const text = line.trim();
    if (text === '') continue;
    if (EXIT_COMMANDS.has(text.toLowerCase())) return;
    try {
      await handleLine(options, session, text, turns);
    } catch (error) {
      options.io.note(`Error: ${messageOf(error)}`);
      if (sessionIsOver(error)) return;
    }
  }
};

/**
 * Runs the shell: sign in (unless a session was given), say who is signed in and whether questions are open, then
 * answer until the person leaves. A session the shell opened is signed out before it returns.
 */
export const runShell = async (options: ShellOptions): Promise<number> => {
  const { io } = options;
  const opened = await (options.session === undefined ? signInWithCode(options) : Promise.resolve(undefined)).catch((error: unknown) => {
    io.note(`Error: ${messageOf(error)}`);
    return null;
  });
  if (opened === null) return SHELL_EXIT.error;
  const session = options.session ?? opened?.session;
  if (session === undefined) {
    io.note('Not signed in.');
    return SHELL_EXIT.notSignedIn;
  }
  try {
    const first = await session.check();
    io.note(describeSession(first, opened?.email));
    io.note(mayAsk(first).allowed ? 'Type a question, or /help. /exit signs out.' : 'Type /help, or /exit to sign out.');
    await converse({ ...options, ...(opened === undefined ? {} : { email: opened.email }) }, session);
    return SHELL_EXIT.left;
  } catch (error) {
    io.note(`Error: ${messageOf(error)}`);
    return SHELL_EXIT.error;
  } finally {
    if (opened !== undefined) {
      const revoked = await opened.session.end();
      io.note(revoked ? 'Signed out.' : 'Signed out here. The Cert API did not confirm it, so the sign-in ends when it expires.');
    }
  }
};

/**
 * `reso-cert shell` from the command line: resolves where to sign in and where the Assistant answers, refusing before
 * anything is sent when either is wrong, then runs the shell on the terminal.
 */
export const runShellCommand = async (input: {
  readonly email?: string;
  readonly url?: string;
  readonly origin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly mask?: (text: string) => string;
  readonly onSecret?: (value: string) => void;
}): Promise<number> => {
  const env = input.env ?? process.env;
  const resolved = ((): { readonly apiOrigin: string; readonly assistantOrigin: string } | { readonly problem: string } => {
    try {
      return {
        apiOrigin: input.url === undefined ? DEFAULT_CERT_API_ORIGIN : resolveCertApiOrigin({ url: input.url, env }),
        assistantOrigin: resolveAssistantOrigin({ ...(input.origin === undefined ? {} : { origin: input.origin }), env })
      };
    } catch (error) {
      return { problem: messageOf(error) };
    }
  })();
  if ('problem' in resolved) {
    process.stderr.write(`Error: ${resolved.problem}\n`);
    return SHELL_EXIT.error;
  }
  const io = terminalIo(input.mask);
  try {
    return await runShell({
      io,
      ...resolved,
      signal: io.signal,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.onSecret === undefined ? {} : { onSecret: input.onSecret })
    });
  } finally {
    io.close();
  }
};

/** The terminal as a `ShellIo`: prompts and notices on stderr, answers on stdout, Ctrl-C stops and signs out. */
export interface TerminalIo extends ShellIo {
  readonly signal: AbortSignal;
  readonly close: () => void;
}

/**
 * Input that is piped in reaches its end while the shell is still working through it, and readline closes then, with
 * the lines it has not handed out still queued. So a prompt is shown only while readline is open, and the queue is
 * read either way: closing ends the lines, not the ones already typed.
 */
export const terminalIo = (mask: (text: string) => string = text => text): TerminalIo => {
  const stopped = new AbortController();
  const closed = new AbortController();
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
  terminal.once('close', () => closed.abort());
  const lines = terminal[Symbol.asyncIterator]();
  const stop = (): void => {
    stopped.abort();
    terminal.close();
  };
  terminal.on('SIGINT', stop);
  process.on('SIGINT', stop);
  return {
    signal: stopped.signal,
    read: async prompt => {
      if (stopped.signal.aborted) return undefined;
      if (!closed.signal.aborted) {
        terminal.setPrompt(prompt);
        terminal.prompt();
      }
      const next = await lines.next();
      return next.done === true ? undefined : String(next.value);
    },
    print: text => {
      process.stdout.write(`${mask(text)}\n`);
    },
    note: text => {
      process.stderr.write(`${mask(text)}\n`);
    },
    close: () => {
      process.off('SIGINT', stop);
      terminal.close();
    }
  };
};
