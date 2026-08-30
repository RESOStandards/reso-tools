/**
 * The injectable request seam for the certification containers (reso-tools #125).
 *
 * A runner depends on an `ODataRequester` — the single capability it needs (make a
 * request, get a response) — instead of reaching for the free `odataRequest`. The
 * web requester wraps reso-client (and, in a later increment, the run's shared
 * resilience session); a test requester returns scripted responses. The same runner
 * logic then runs against a live server or a fixture just by swapping the injected
 * requester — no `vi.mock`, no "test mode" branches.
 */

import { DEFAULT_BACKOFF, type ResilienceSession, createResilienceSession } from '@reso-standards/reso-client';
import { type RequestOptions, odataRequest } from './client.js';
import type { ODataResponse } from './types.js';

/** What a certification runner needs from its client: issue an OData request, get a response. */
export interface ODataRequester {
  request(options: RequestOptions & { readonly odataVersion?: string }): Promise<ODataResponse>;
}

/** The production requester — reso-client via `odataRequest` (today's behavior, unchanged). */
export const webRequester: ODataRequester = {
  request: (options) => odataRequest(options)
};

/**
 * A web requester bound to a shared resilience session. Created once per run and injected, it
 * makes the governor + circuit breaker persist across the run's requests (per-call clients each
 * see the same session), which is where the shared breaker's fail-fast behavior comes from.
 */
export const createSessionRequester = (session: ResilienceSession): ODataRequester => ({
  request: (options) => odataRequest({ ...options, session })
});

/**
 * The resilience session for a certification run.
 *
 * Cert runs with the stateful resilience layers off and retries limited to the two
 * statuses that mean "reachable, come back later", because cert's job is to *record*
 * how a server behaves, not to protect a workload from it. Effectively: one request per
 * scenario, record the result, and move on — except a 429/503 is retried a couple of
 * times first:
 *
 *  - **Circuit breaker off.** In cert every HTTP response — a 5xx included — is a
 *    result to record, not a health signal to fail fast on. A shared breaker keyed per
 *    host|resource would (a) false-fail scenarios the server actually handles once a
 *    burst of 5xx/timeouts on one resource trips it open, and (b) on a path-prefixed
 *    service root (host/odata/Property, host/odata/Member, …) collapse every resource
 *    onto one key, so a burst on one resource silently blocks testing of the others.
 *    "Endpoint unreachable" is already handled explicitly: sampling gates reachability
 *    and an unsampleable resource is reported SKIPPED, not FAILED.
 *  - **Retry only when the server tells us to** (429 / 503), up to twice, honoring
 *    Retry-After. Those two statuses mean "come back later", so a re-send can genuinely
 *    succeed. Every other failure is a verdict to record and move on: a 500/502/504 is
 *    the server's answer (re-sending gets the same one and risks a duplicate-query
 *    block), and a network drop or timeout is re-sent into the same wall. Two retries
 *    (down from the SDK default of five) caps the wait; a rate-limit that outlasts even
 *    that is bounded by the job's own timeout, not by hammering the server.
 *  - **Governor (pacing) off.** A bounded cert run should stay fast; the ~1 rps floor
 *    is a replication concern. Tune the rate here if a picky vendor rate-limits a run.
 *
 * What stays on is the per-request 15-minute timeout — so a single hung request can't
 * stall the run indefinitely — plus the bounded 429/503 retry above. Cert declares the
 * timeout explicitly (rather than inheriting the SDK default) so the contract is
 * self-owned and a change to the SDK default can't silently shorten it under a slow read.
 *
 * The shared-session plumbing itself is retained — it is the seam the future parallel
 * fetchers (#271) and the DD 2.2 sampling migration will draw a shared rate budget
 * from, where full retries + the breaker also earn their keep; cert just configures the
 * breaker + governor inert today. An infinite breaker threshold is a real breaker that
 * provably never opens.
 *
 * Note: a bare 503 (no Retry-After) retries on the short exponential backoff, while a
 * 429 falls back to the long `defaultRetryWaitMs` — rate-limit windows are long, a 503
 * is usually a transient blip. Both honor a Retry-After header when present.
 */
/** Cert's per-request timeout: 15 min. Some legitimate paged reads run this long (Josh's call). */
const CERT_REQUEST_TIMEOUT_MS = 15 * 60_000;

/** The two statuses that mean "reachable, come back later" — the only ones cert retries. */
const CERT_RETRYABLE_STATUSES = [429, 503] as const;

/**
 * Default total run budget: 55 min. Generous for a normal Core run, and meant to sit UNDER
 * the job scheduler's own kill (e.g. a 1 h AWS Batch timeout) so the client stops first — it
 * unwinds gracefully and writes a partial report, where a hard kill would leave none. Override
 * via `CoreConfig.totalTimeoutMs` to match the actual scheduler timeout.
 */
export const DEFAULT_CERT_TOTAL_TIMEOUT_MS = 55 * 60_000;

export const createCertSession = (
  totalTimeoutMs: number = DEFAULT_CERT_TOTAL_TIMEOUT_MS
): ResilienceSession =>
  createResilienceSession({
    governor: { ratePerSec: 0, burst: 0 },
    breaker: { threshold: Number.POSITIVE_INFINITY, cooldownMs: 0 },
    backoff: { ...DEFAULT_BACKOFF, maxRetries: 2 },
    retryableStatuses: CERT_RETRYABLE_STATUSES,
    timeoutMs: CERT_REQUEST_TIMEOUT_MS,
    totalTimeoutMs
  });
