/**
 * Whether a signed-in person may ask RESO's Assistant from the command line. The one place that decides it.
 *
 * Signing in is open to anyone who can sign in to certification.reso.org. Asking is a member service: a person the
 * desktop app admits may ask here too, and nobody else. The Cert API gives that answer on `GET /session`, so this reads
 * it rather than restating the rule. A person it admits gets who they are; one it does not gets its refusal, with a
 * reason written for them (`desktop_not_available`, or `member_access_unavailable` when membership could not be
 * checked).
 *
 * The Assistant checks the token on its own as well. This keeps a question from being sent only to be refused, and
 * gives the person the Cert API's reason in its own words. When member services are granted one by one rather than
 * together, this function is what changes, and nothing that calls it.
 */
import type { SessionAnswer } from './sign-in.js';

export type AskPermission = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Allowed only when the Cert API said who the person is. Any refusal, for any reason, is a no. */
export const mayAsk = (answer: SessionAnswer): AskPermission =>
  answer.kind === 'signed-in' ? { allowed: true } : { allowed: false, reason: answer.message };
