/**
 * RESO's Assistant, asked from code: one question in, the answer and its sources out.
 *
 * The Assistant answers `POST {origin}/ask`. Asked with `Accept: application/x-ndjson`, it streams
 * `{"type":"status","text":…}` lines while it works and closes with one `{"type":"result","status":…,"body":…}` line,
 * all under HTTP 200: the result line carries the real status. This client reads that stream, reports each status as
 * it arrives, and returns the answer. A response that is not a stream (a refusal at a gateway, or a deployment that
 * does not stream) is read as one JSON body.
 *
 * The client carries no Assistant logic. The service decides what the caller may see from the identity behind the
 * credential, which the caller brings: it is sent only as the bearer to the origin given, and never appears in an
 * error or in anything returned.
 */

export const ASK_PATH = '/ask';
export const NDJSON = 'application/x-ndjson';

/** One earlier turn of the conversation, so a follow-up question is read in context. */
export interface AskTurn {
  readonly question: string;
  readonly answer: string;
}

/** A source the answer drew on. */
export interface AskCitation {
  readonly id: string;
  readonly title: string;
  readonly ref?: string;
  readonly registry?: string;
}

/** A section of the answer that a reviewer did not confirm, or did not get to. */
export interface AskSectionReview {
  readonly heading: string;
  readonly status: 'not-reviewed' | 'not-confirmed';
  /** The statements that could not be confirmed, quoted from the answer. */
  readonly statements: ReadonlyArray<string>;
  /** Why the section was not reviewed, in the reader's words. */
  readonly reason?: string;
}

export interface AskAnswer {
  /** The answer, in Markdown. */
  readonly answer: string;
  readonly citations: ReadonlyArray<AskCitation>;
  readonly sectionReviews: ReadonlyArray<AskSectionReview>;
}

export interface AskOptions {
  /** Where the Assistant answers, with any path prefix it is served under. */
  readonly origin: string;
  /** The full `Authorization` header value, such as `Bearer …`. */
  readonly authorization: string;
  readonly question: string;
  readonly history?: ReadonlyArray<AskTurn>;
  /** Called with each progress line while the Assistant works. */
  readonly onStatus?: (text: string) => void;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/** An error from asking: `status` is the Assistant's HTTP status, or 0 when no answer arrived at all. */
export interface AskFailure extends Error {
  readonly status: number;
}

export const askFailure = (status: number, message: string): AskFailure => Object.assign(new Error(message), { status });

export const isAskFailure = (value: unknown): value is AskFailure =>
  value instanceof Error && typeof (value as { status?: unknown }).status === 'number';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.flatMap(item => (nonEmpty(item) === undefined ? [] : [item as string])) : [];

const citationFrom = (value: unknown): ReadonlyArray<AskCitation> => {
  if (!isRecord(value)) return [];
  const id = nonEmpty(value.id);
  const title = nonEmpty(value.title);
  if (id === undefined || title === undefined) return [];
  const ref = nonEmpty(value.ref);
  const registry = nonEmpty(value.registry);
  return [{ id, title, ...(ref === undefined ? {} : { ref }), ...(registry === undefined ? {} : { registry }) }];
};

const sectionReviewFrom = (value: unknown): ReadonlyArray<AskSectionReview> => {
  if (!isRecord(value)) return [];
  const heading = nonEmpty(value.heading);
  const status = value.status === 'not-reviewed' || value.status === 'not-confirmed' ? value.status : undefined;
  if (heading === undefined || status === undefined) return [];
  const reason = nonEmpty(value.reason);
  return [{ heading, status, statements: strings(value.statements), ...(reason === undefined ? {} : { reason }) }];
};

/** The answer in a response body, or undefined when the body holds none. Unknown fields are ignored. */
export const readAnswer = (body: unknown): AskAnswer | undefined => {
  if (!isRecord(body)) return undefined;
  const answer = nonEmpty(body.answer);
  if (answer === undefined) return undefined;
  return {
    answer,
    citations: Array.isArray(body.citations) ? body.citations.flatMap(citationFrom) : [],
    sectionReviews: Array.isArray(body.sectionReviews) ? body.sectionReviews.flatMap(sectionReviewFrom) : []
  };
};

/** What to tell a person when the Assistant refuses, preferring the Assistant's own words. */
export const failureMessage = (status: number, body: unknown): string => {
  const said = isRecord(body) ? (nonEmpty(body.error) ?? nonEmpty(body.message)) : undefined;
  if (said !== undefined) return said;
  if (status === 401) return 'The Assistant did not accept the credential. Sign in again, or check that the credentials file is current.';
  if (status === 403) return 'This account is not admitted to the Assistant, which is in a closed beta.';
  return `The Assistant answered with status ${status}.`;
};

const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw askFailure(502, 'The Assistant sent a progress line that is not JSON.');
  }
};

/** Reads newline-delimited JSON from a stream, calling `onValue` for each line as it completes. */
export const readNdjson = async (body: ReadableStream<Uint8Array>, onValue: (value: unknown) => void): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const emit = (lines: ReadonlyArray<string>): void => {
    for (const line of lines) if (line.trim() !== '') onValue(parseLine(line));
  };
  const pump = async (pending: string): Promise<string> => {
    const { done, value } = await reader.read();
    if (done) return pending + decoder.decode();
    const lines = (pending + decoder.decode(value, { stream: true })).split('\n');
    emit(lines.slice(0, -1));
    return pump(lines.at(-1) ?? '');
  };
  emit([await pump('')]);
};

const answerFromResult = (result: unknown): AskAnswer => {
  if (!isRecord(result)) throw askFailure(502, 'The Assistant closed the stream without an answer.');
  const status = typeof result.status === 'number' ? result.status : 502;
  if (status !== 200) throw askFailure(status, failureMessage(status, result.body));
  const answer = readAnswer(result.body);
  if (answer === undefined) throw askFailure(502, 'The Assistant finished without an answer.');
  return answer;
};

/** Asks the Assistant one question. Throws an `AskFailure` when no answer comes back. */
export const askAssistant = async (options: AskOptions): Promise<AskAnswer> => {
  if (options.question.trim() === '') throw askFailure(0, 'A question is required.');
  if (options.authorization.trim() === '') throw askFailure(0, 'A credential for RESO services is required.');
  const send = options.fetch ?? fetch;
  const origin = options.origin.replace(/\/+$/, '');
  const response = await send(`${origin}${ASK_PATH}`, {
    method: 'POST',
    headers: { Authorization: options.authorization, 'Content-Type': 'application/json', Accept: NDJSON },
    body: JSON.stringify({
      question: options.question,
      ...(options.history !== undefined && options.history.length > 0 ? { history: options.history } : {})
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  }).catch((error: unknown) => {
    throw askFailure(0, `Could not reach the Assistant at ${origin}: ${error instanceof Error ? error.message : 'the request failed'}.`);
  });

  const streamed = response.ok && (response.headers.get('content-type') ?? '').includes(NDJSON) && response.body !== null;
  if (streamed && response.body !== null) {
    const results: unknown[] = [];
    await readNdjson(response.body, value => {
      if (!isRecord(value)) return;
      const text = nonEmpty(value.text);
      if (value.type === 'status' && text !== undefined) options.onStatus?.(text);
      if (value.type === 'result') results.push(value);
    });
    return answerFromResult(results.at(-1));
  }

  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) throw askFailure(response.status, failureMessage(response.status, body));
  const answer = readAnswer(body);
  if (answer === undefined) throw askFailure(502, 'The Assistant answered without an answer.');
  return answer;
};
