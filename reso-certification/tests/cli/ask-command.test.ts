/**
 * `reso-cert ask` against a stubbed Assistant.
 *
 * The contract is the request it makes (one POST to `{origin}/ask`, the caller's bearer, NDJSON asked for), how it reads
 * the stream (progress as it arrives, the result line's own status, lines split across chunks), and what it refuses
 * before sending anything. Credentials here are synthetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askFailure } from '../../src/assistant/ask.js';
import {
  ASSISTANT_ORIGIN_VARIABLE,
  askExitCode,
  renderAnswer,
  resolveAssistantOrigin,
  runAsk,
  withoutRepeats
} from '../../src/cli/ask-command.js';
import { __clearSecretsForTest } from '../../src/cli/secrets.js';

const ORIGIN = 'https://assistant.example.org';
const CREDENTIAL = 'SENTINEL-credential-for-tests';
const ENV = { [ASSISTANT_ORIGIN_VARIABLE]: ORIGIN, CERT_API_TOKEN: CREDENTIAL };
const ANSWER = {
  answer: '## Short answer\nThe Data Dictionary 2.1 is the current version.',
  citations: [{ id: 'dd-versions', title: 'Data Dictionary versions', ref: 'references/dd-versions.md', registry: 'member', score: 3 }],
  sectionReviews: [{ heading: 'Short answer', status: 'not-confirmed', statements: ['It was ratified in 2025.'] }]
};

const ndjson = (chunks: ReadonlyArray<string>, status = 200): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: controller => {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    { status, headers: { 'Content-Type': 'application/x-ndjson' } }
  );

const lines = (...values: ReadonlyArray<unknown>): string => values.map(value => `${JSON.stringify(value)}\n`).join('');

const stub = (response: Response | (() => Promise<Response>)) =>
  vi.fn<typeof fetch>(async () => (typeof response === 'function' ? response() : response));

afterEach(() => __clearSecretsForTest());

describe('asking', () => {
  it('sends one POST to {origin}/ask with the bearer and NDJSON asked for, and reports progress before the answer', async () => {
    const fetch = stub(
      ndjson([
        lines({ type: 'status', text: 'Reading your question' }, { type: 'status', text: 'Checking the facts' }),
        lines({ type: 'result', status: 200, body: ANSWER })
      ])
    );
    const progress: string[] = [];
    const answer = await runAsk({
      question: 'What is the current Data Dictionary?',
      env: ENV,
      fetch,
      onStatus: text => progress.push(text)
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/ask`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${CREDENTIAL}`, Accept: 'application/x-ndjson' });
    expect(JSON.parse(String(init?.body))).toEqual({ question: 'What is the current Data Dictionary?' });
    expect(progress).toEqual(['Reading your question', 'Checking the facts']);
    expect(answer.answer).toBe(ANSWER.answer);
    expect(answer.citations).toEqual([
      { id: 'dd-versions', title: 'Data Dictionary versions', ref: 'references/dd-versions.md', registry: 'member' }
    ]);
    expect(answer.sectionReviews).toEqual([{ heading: 'Short answer', status: 'not-confirmed', statements: ['It was ratified in 2025.'] }]);
  });

  it('reads a line split across chunks as one line', async () => {
    const whole = lines({ type: 'status', text: 'Searching' }, { type: 'result', status: 200, body: ANSWER });
    const fetch = stub(ndjson([whole.slice(0, 7), whole.slice(7, 40), whole.slice(40)]));
    const progress: string[] = [];
    const answer = await runAsk({ question: 'q', env: ENV, fetch, onStatus: text => progress.push(text) });
    expect(progress).toEqual(['Searching']);
    expect(answer.answer).toBe(ANSWER.answer);
  });

  it('keeps a path prefix on the address and sends the history only when there is one', async () => {
    const fetch = stub(ndjson([lines({ type: 'result', status: 200, body: ANSWER })]));
    await runAsk({
      question: 'And 2.0?',
      origin: 'https://assistant.example.org/api/',
      history: [{ question: 'What is current?', answer: '2.1' }],
      env: { CERT_API_TOKEN: CREDENTIAL },
      fetch
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://assistant.example.org/api/ask');
    expect(JSON.parse(String(init?.body))).toEqual({ question: 'And 2.0?', history: [{ question: 'What is current?', answer: '2.1' }] });
  });
});

describe('refusals', () => {
  it('takes the status from the result line, not the 200 the stream was sent under, and the Assistant’s own words', async () => {
    const fetch = stub(ndjson([lines({ type: 'result', status: 403, body: { error: 'not authorized for that registry' } })]));
    const error = await runAsk({ question: 'q', env: ENV, fetch }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, message: 'not authorized for that registry' });
    expect(askExitCode(error)).toBe(1);
  });

  it('reads a refusal that is not a stream, such as a gateway’s, and says what to do', async () => {
    const fetch = stub(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
    const error = await runAsk({ question: 'q', env: ENV, fetch }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401 });
    expect(String((error as Error).message)).toMatch(/did not accept the credential/);
    expect(askExitCode(error)).toBe(1);
  });

  it('a stream that ends without a result line is an error, not an empty answer', async () => {
    const fetch = stub(ndjson([lines({ type: 'status', text: 'Working' })]));
    const error = await runAsk({ question: 'q', env: ENV, fetch }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502 });
    expect(askExitCode(error)).toBe(2);
  });

  it('never follows a redirect, so the credential and the question go only to the address given', async () => {
    const fetch = stub(new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example.org/ask' } }));
    const error = await runAsk({ question: 'q', env: ENV, fetch }).catch((e: unknown) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(error).toMatchObject({ status: 307 });
    expect(String((error as Error).message)).toMatch(/redirect, which is never followed/);
    expect(String((error as Error).message)).not.toContain(CREDENTIAL);
    expect(askExitCode(error)).toBe(2);
  });

  it('never puts the credential in an error, even when the network fails', async () => {
    const fetch = vi.fn<typeof fetch>(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const error = await runAsk({ question: 'q', env: ENV, fetch }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0 });
    expect(String((error as Error).message)).not.toContain(CREDENTIAL);
    expect(String((error as Error).message)).toContain(ORIGIN);
  });
});

describe('before anything is sent', () => {
  it('refuses without an address for the Assistant, and makes no request', async () => {
    const fetch = stub(ndjson([]));
    await expect(runAsk({ question: 'q', env: { CERT_API_TOKEN: CREDENTIAL }, fetch })).rejects.toThrow(/RESO_ASSISTANT_ORIGIN/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses without a credential, and makes no request', async () => {
    const fetch = stub(ndjson([]));
    await expect(runAsk({ question: 'q', env: { [ASSISTANT_ORIGIN_VARIABLE]: ORIGIN }, fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an empty question, and makes no request', async () => {
    const fetch = stub(ndjson([]));
    await expect(runAsk({ question: '   ', env: ENV, fetch })).rejects.toThrow(/question is required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an address with a query, and reads one without a scheme as https', () => {
    expect(() => resolveAssistantOrigin({ origin: 'https://assistant.example.org/?x=1', env: {} })).toThrow(/origin with an optional path/);
    expect(resolveAssistantOrigin({ origin: 'assistant.example.org', env: {} })).toBe('https://assistant.example.org');
  });
});

describe('the answer for a person', () => {
  it('prints the answer, then what a reviewer could not confirm, then the sources', () => {
    const text = renderAnswer({
      answer: ANSWER.answer,
      citations: [
        { id: 'a', title: 'Data Dictionary versions', ref: 'references/dd-versions.md' },
        { id: 'b', title: 'No ref' }
      ],
      sectionReviews: [
        { heading: 'Short answer', status: 'not-confirmed', statements: ['It was ratified in 2025.'] },
        { heading: 'Details', status: 'not-reviewed', statements: [], reason: 'time ran out' }
      ]
    });
    expect(text).toBe(
      [
        ANSWER.answer,
        '',
        'A reviewer could not confirm:',
        '- Short answer: It was ratified in 2025.',
        '- Details: not reviewed (time ran out)',
        '',
        'Sources:',
        '- Data Dictionary versions (references/dd-versions.md)',
        '- No ref'
      ].join('\n')
    );
  });

  it('shows a progress line once when the Assistant repeats it, and again after another line', () => {
    const shown: string[] = [];
    const onStatus = withoutRepeats(text => shown.push(text));
    for (const text of ['Writing the answer', 'Writing the answer', 'Checking', 'Writing the answer']) onStatus(text);
    expect(shown).toEqual(['Writing the answer', 'Checking', 'Writing the answer']);
  });

  it('exit code 0 for an answer', () => {
    expect(askExitCode()).toBe(0);
    expect(askExitCode(askFailure(500, 'x'))).toBe(2);
  });
});
