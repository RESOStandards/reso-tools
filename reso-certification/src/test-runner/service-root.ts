/**
 * The service root a run was given, in the one form the engine joins paths onto.
 *
 * A root arrives as typed: `http://127.0.0.1:8801` or `http://127.0.0.1:8801/`, with or without a path. Request URLs
 * are built by joining `/${resource}` onto it, so a root that ends in a slash produced `http://127.0.0.1:8801//Property`,
 * a different path that a server may answer 404. Every place that joins a path onto the root passes it through here
 * first.
 *
 * Only a join. A request for the root itself (the service check, the service document) uses the root exactly as the
 * user gave it: a server may answer one form and not the other, and a run must test what it was pointed at.
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
