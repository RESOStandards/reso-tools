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

import type { ResilienceSession } from '@reso-standards/reso-client';
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
