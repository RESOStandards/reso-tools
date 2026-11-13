/**
 * `reso-cert ask`: ask RESO's Assistant a question from the command line.
 *
 * A passthrough. The question goes to the Assistant with the same credential the downloaded credentials file
 * carries, and the Assistant decides what this person may see from the identity behind it. The command adds nothing
 * of its own to the answer: it prints the Assistant's progress while it works, then the answer, the sections a
 * reviewer could not confirm, and the sources.
 *
 * The Assistant is in a closed beta, and its address comes with access: `--origin`, or `RESO_ASSISTANT_ORIGIN` in
 * the environment or the `.env`. Nothing is sent without one.
 */

import { type AskAnswer, type AskTurn, askAssistant, isAskFailure } from '../assistant/ask.js';
import { ensureHttps } from '../sdk/common.js';
import {
  CERT_API_TOKEN_VARIABLE,
  registerCertApiSecrets,
  resolveCertApiAuthorization,
  resolveCertApiOrigin
} from './cert-api-credential.js';

export const ASSISTANT_ORIGIN_VARIABLE = 'RESO_ASSISTANT_ORIGIN';

const NO_ORIGIN = `No address for the Assistant. Pass --origin, or set ${ASSISTANT_ORIGIN_VARIABLE}. The Assistant is in a closed beta, and its address comes with access. Nothing was sent.`;

export interface AskCommandOptions {
  readonly question: string;
  /** `--origin`: where the Assistant answers. Without it, `RESO_ASSISTANT_ORIGIN`. */
  readonly origin?: string;
  /** `--url`: the Cert API origin, which mints the token. Without it, the origin of `TOKEN_URI`. */
  readonly url?: string;
  readonly history?: ReadonlyArray<AskTurn>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly onStatus?: (text: string) => void;
}

const present = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim());

/** The Assistant's address: an origin, with any path prefix it is served under, never a query or a fragment. */
export const resolveAssistantOrigin = (input: { readonly origin?: string; readonly env: NodeJS.ProcessEnv }): string => {
  const given = present(input.origin);
  const raw = given ?? present(input.env[ASSISTANT_ORIGIN_VARIABLE]);
  if (raw === undefined) throw new Error(NO_ORIGIN);
  const parsed = new URL(ensureHttps(raw, given === undefined ? ASSISTANT_ORIGIN_VARIABLE : '--origin'));
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`The Assistant's address is an origin with an optional path, such as ${parsed.origin}. Nothing was sent.`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
};

/**
 * The credential, as the other commands that call RESO's services find it: `CERT_API_TOKEN`, else a token minted
 * from the credentials file, else the older API key. The Cert API's address is needed only to mint a token.
 */
const authorizationFor = async (options: AskCommandOptions, env: NodeJS.ProcessEnv): Promise<string> => {
  const needsCertApi = present(env[CERT_API_TOKEN_VARIABLE]) === undefined;
  const origin = needsCertApi ? resolveCertApiOrigin({ ...(options.url === undefined ? {} : { url: options.url }), env }) : '';
  return resolveCertApiAuthorization({ env, origin });
};

/** Asks the Assistant. The address is checked before any credential is read or minted. */
export const runAsk = async (options: AskCommandOptions): Promise<AskAnswer> => {
  const env = options.env ?? process.env;
  registerCertApiSecrets(env);
  const origin = resolveAssistantOrigin({ ...(options.origin === undefined ? {} : { origin: options.origin }), env });
  const authorization = await authorizationFor(options, env);
  return askAssistant({
    origin,
    authorization,
    question: options.question,
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus })
  });
};

/** The answer for a person: the answer, then what a reviewer could not confirm, then the sources. */
export const renderAnswer = (answer: AskAnswer): string => {
  const unconfirmed = answer.sectionReviews.flatMap(review =>
    review.status === 'not-confirmed'
      ? [`- ${review.heading}: ${review.statements.length > 0 ? review.statements.join(' / ') : 'not confirmed'}`]
      : [`- ${review.heading}: not reviewed${review.reason === undefined ? '' : ` (${review.reason})`}`]
  );
  const sources = answer.citations.map(citation => `- ${citation.title}${citation.ref === undefined ? '' : ` (${citation.ref})`}`);
  return [
    answer.answer.trim(),
    ...(unconfirmed.length > 0 ? ['', 'A reviewer could not confirm:', ...unconfirmed] : []),
    ...(sources.length > 0 ? ['', 'Sources:', ...sources] : [])
  ].join('\n');
};

/** Passes each progress line on once: the Assistant repeats a line while one stage runs long, and a person needs it once. */
export const withoutRepeats = (onStatus: (text: string) => void): ((text: string) => void) => {
  const last: { text?: string } = {};
  return text => {
    if (text === last.text) return;
    last.text = text;
    onStatus(text);
  };
};

/** 0 answered; 1 the Assistant refused this credential or account; 2 anything else. */
export const askExitCode = (error?: unknown): number => {
  if (error === undefined) return 0;
  return isAskFailure(error) && (error.status === 401 || error.status === 403) ? 1 : 2;
};
