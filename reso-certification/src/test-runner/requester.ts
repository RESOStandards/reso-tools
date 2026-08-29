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
 * Cert deliberately runs with the two STATEFUL resilience layers off, because cert's
 * job is to *record* how a server behaves, not to protect a workload from it:
 *
 *  - **Circuit breaker off.** In cert every HTTP response — a 5xx included — is a
 *    result to record, not a health signal to fail fast on. A shared breaker keyed per
 *    host|resource would (a) false-fail scenarios the server actually handles once a
 *    burst of 5xx/timeouts on one resource trips it open, and (b) on a path-prefixed
 *    service root (host/odata/Property, host/odata/Member, …) collapse every resource
 *    onto one key, so a burst on one resource silently blocks testing of the others.
 *    "Endpoint unreachable" is already handled explicitly: sampling gates reachability
 *    and an unsampleable resource is reported SKIPPED, not FAILED.
 *  - **Governor (pacing) off.** A bounded cert run should stay fast; the ~1 rps floor
 *    is a replication concern. Tune the rate here if a picky vendor rate-limits a run.
 *
 * What stays on is per-request and stateless: a single retry with short backoff
 * ("try again or move on"), Retry-After handling, and the 15-minute timeout.
 *
 * The shared-session plumbing itself is retained — it is the seam the future parallel
 * fetchers (#271) and the DD 2.2 sampling migration will draw a shared rate budget
 * from; cert just configures the stateful layers inert today, as the governor already
 * was. An infinite breaker threshold is a real breaker that provably never opens.
 */
export const createCertSession = (): ResilienceSession =>
  createResilienceSession({
    governor: { ratePerSec: 0, burst: 0 },
    breaker: { threshold: Number.POSITIVE_INFINITY, cooldownMs: 0 },
    backoff: { ...DEFAULT_BACKOFF, maxRetries: 1 }
  });
