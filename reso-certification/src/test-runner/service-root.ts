/**
 * The service root a run was given, in the one form the engine joins paths onto.
 *
 * A root arrives as typed: `http://127.0.0.1:8801` or `http://127.0.0.1:8801/`, with or without a path. Request URLs
 * are built by joining `/${resource}` onto it, so a root that ends in a slash produced `http://127.0.0.1:8801//Property`,
 * a different path that a server may answer 404. Every place that starts a run or builds a request URL from the root
 * passes it through here first.
 */

/** A scheme and authority (`http://host:port`), the path after it, and a query or fragment, each possibly empty. */
const SERVICE_ROOT_PARTS = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)(.*)$/s;

/**
 * Drop the slash, or slashes, at the end of a service root's path. Only the path's end: a query or fragment is
 * returned as given, slashes included, and so is everything before the path. A root with nothing to drop comes back
 * unchanged, so applying this twice is the same as applying it once.
 */
export const normalizeServiceRoot = (serviceRoot: string): string => {
  const [, origin = '', path = '', queryOrFragment = ''] = SERVICE_ROOT_PARTS.exec(serviceRoot) ?? [];
  return `${origin}${path.replace(/\/+$/, '')}${queryOrFragment}`;
};
