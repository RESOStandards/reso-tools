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
 * Cert deliberately runs with the stateful resilience layers off AND without retries,
 * because cert's job is to *record* how a server behaves, not to protect a workload
 * from it. One request per scenario, record the result, move on:
 *
 *  - **Circuit breaker off.** In cert every HTTP response — a 5xx included — is a
 *    result to record, not a health signal to fail fast on. A shared breaker keyed per
 *    host|resource would (a) false-fail scenarios the server actually handles once a
 *    burst of 5xx/timeouts on one resource trips it open, and (b) on a path-prefixed
 *    service root (host/odata/Property, host/odata/Member, …) collapse every resource
 *    onto one key, so a burst on one resource silently blocks testing of the others.
 *    "Endpoint unreachable" is already handled explicitly: sampling gates reachability
 *    and an unsampleable resource is reported SKIPPED, not FAILED.
 *  - **No retries.** A re-send only helps when the first failure wasn't the server's
 *    verdict — but a 5xx *is* the verdict (re-sending gets the same answer and risks a
 *    picky vendor blocking us for duplicate queries), a 429 means we paced too hard (the
 *    lever there is pacing, not a retry that hammers the rate limit), and a timeout
 *    re-sent is how a run balloons to 15 min × N. So cert records the first outcome and
 *    moves on. If rate-limiting shows up with pacing off, the lever is the governor.
 *  - **Governor (pacing) off.** A bounded cert run should stay fast; the ~1 rps floor
 *    is a replication concern. Tune the rate here if a picky vendor rate-limits a run.
 *
 * What stays on is the per-request 15-minute timeout — the one protection cert still
 * wants, so a single hung request can't stall the run indefinitely. Cert declares it
 * explicitly (rather than inheriting the SDK default) so the contract is self-owned and
 * a change to the SDK default can't silently shorten it under a legitimately slow read.
 *
 * The shared-session plumbing itself is retained — it is the seam the future parallel
 * fetchers (#271) and the DD 2.2 sampling migration will draw a shared rate budget
 * from, where retries + Retry-After + the breaker all earn their keep; cert just
 * configures those layers inert today. An infinite breaker threshold is a real breaker
 * that provably never opens; maxRetries 0 is a real send path that never re-sends.
 */
/** Cert's per-request timeout: 15 min. Some legitimate paged reads run this long (Josh's call). */
const CERT_REQUEST_TIMEOUT_MS = 15 * 60_000;

export const createCertSession = (): ResilienceSession =>
  createResilienceSession({
    governor: { ratePerSec: 0, burst: 0 },
    breaker: { threshold: Number.POSITIVE_INFINITY, cooldownMs: 0 },
    backoff: { ...DEFAULT_BACKOFF, maxRetries: 0 },
    timeoutMs: CERT_REQUEST_TIMEOUT_MS
  });
