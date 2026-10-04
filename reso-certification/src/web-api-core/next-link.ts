/**
 * `@odata.nextLink` re-basing, shared by the scenario runner and the sampler.
 *
 * It lives in its own module because `test-runner.ts` imports `sampling.ts`, so the sampler cannot import
 * back from the runner without a cycle. The logic is subtle enough that duplicating it would be worse than
 * moving it.
 */

/**
 * Re-base a server-supplied `@odata.nextLink` onto the origin we actually queried.
 *
 * Per OData JSON Format v4.01 a nextLink MAY be absolute or relative (§4.5.5, Control Information: nextLink),
 * and a relative URL resolves against its base URL — the enclosing `@odata.context`, else the request URL
 * (§4.3, Relative URLs; https://docs.oasis-open.org/odata/odata-json-format/v4.01/odata-json-format-v4.01.html).
 * We support both: `new URL(nextLink, requestUrl)` resolves a relative link, and for an absolute link we keep
 * its path + query but force the request's protocol/host/port.
 *
 * Why force the request origin rather than trust the link (or, per §4.3, the context URL)? A server behind a
 * proxy or with a misconfigured base URL emits an internal/wrong host — e.g. `http://localhost/…` with the
 * port dropped — in BOTH `@odata.nextLink` AND `@odata.context`, so even strict §4.3 resolution of a relative
 * link would land on the wrong host. A blind fetch there → "fetch failed" → a FALSE FAIL of a conformant
 * server whose paged resource is otherwise fine. The tester gave us the reachable origin and the paged data
 * lives on it, so re-basing there is strictly more robust than §4.3 resolution.
 */
export const rebaseNextLink = (nextLink: string, requestUrl: string): string => {
  try {
    const base = new URL(requestUrl);
    const next = new URL(nextLink, base); // absolute link keeps its own path/query; relative resolves on base
    // Set hostname + port SEPARATELY: the `.host` setter leaves an existing port in place, so a proxy nextLink
    // like `http://internal:9000/…` would keep :9000. Assigning port explicitly (to '' for a default-port base)
    // clears it.
    next.protocol = base.protocol;
    next.hostname = base.hostname;
    next.port = base.port;
    return next.toString();
  } catch {
    return nextLink; // unparseable — let the caller attempt it as-is
  }
};
