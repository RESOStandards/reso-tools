/**
 * Where the reference server's `/api/proxy` may send a request (reso-tools #424).
 *
 * The proxy makes API calls on behalf of a browser, which cannot call another origin itself. It forwards a request only
 * to a service root its host has allowed, and so sends credentials only there. The host configures the roots: a
 * standalone server through `ALLOWED_SERVICE_ROOTS`, an embedding host (the desktop) by allowing each root it uses.
 * With no roots allowed, nothing is forwarded.
 *
 * Pure functions, plus one small store of the roots allowed while the server runs.
 */

/** A service root as allowed: its origin, and its path without a trailing slash ('' for the whole origin). */
export interface ServiceRoot {
  readonly origin: string;
  readonly path: string;
}

export type ProxyDecision = { readonly allowed: true; readonly url: URL } | { readonly allowed: false; readonly reason: string };

/**
 * Hosts the proxy never calls, whatever is allowed: link-local addresses, which include the cloud metadata service
 * (169.254.169.254, fd00:ec2::254), and names that stand for it. A careless root cannot open them.
 */
const isLinkLocalOrMetadata = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (host === 'fd00:ec2::254') return true;
  return host === 'metadata.google.internal' || host === 'metadata';
};

const trimTrailingSlash = (path: string): string => path.replace(/\/+$/, '');

/** One service root, checked as it comes in. `source` names where it came from, for the message. */
const parseServiceRoot = (raw: string, source: string): ServiceRoot => {
  const value = raw.trim();
  const url = (() => {
    try {
      return new URL(value);
    } catch {
      throw new Error(`${source}: "${value}" is not an absolute URL`);
    }
  })();
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${source}: "${value}" is not an http(s) URL`);
  if (url.username || url.password) throw new Error(`${source}: "${value}" has credentials in it; send them as a header`);
  if (url.search || url.hash) throw new Error(`${source}: "${value}" has a query or fragment; give the service root alone`);
  if (isLinkLocalOrMetadata(url.hostname)) throw new Error(`${source}: "${value}" is a link-local or metadata address`);
  return { origin: url.origin, path: trimTrailingSlash(url.pathname) };
};

/**
 * Service roots from a setting (comma-separated) or a list, each checked as it comes in. A bad entry stops the caller with
 * a message naming it, so a mistake shows at start rather than as a refused request later.
 */
export const parseServiceRoots = (input: string | ReadonlyArray<string>, source: string): ReadonlyArray<ServiceRoot> => {
  const entries = (typeof input === 'string' ? input.split(',') : [...input]).map(entry => entry.trim()).filter(entry => entry.length > 0);
  return entries.map((entry, index) => parseServiceRoot(entry, entries.length > 1 ? `${source} entry ${index + 1}` : source));
};

/** Under a root: the same origin, and the path the root's own or below it, segment by segment (/odata is not /odata2). */
const isUnder = (url: URL, root: ServiceRoot): boolean =>
  url.origin === root.origin && (root.path === '' || url.pathname === root.path || url.pathname.startsWith(`${root.path}/`));

/** Whether the proxy may send a request to `target`. */
export const decide = (target: string, roots: ReadonlyArray<ServiceRoot>, allowAny: boolean): ProxyDecision => {
  const url = (() => {
    try {
      return new URL(target);
    } catch {
      return undefined;
    }
  })();
  if (url === undefined) return { allowed: false, reason: 'Invalid URL' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { allowed: false, reason: 'Only http and https URLs are allowed' };
  if (url.username || url.password) return { allowed: false, reason: 'URLs with credentials in them are not forwarded' };
  if (isLinkLocalOrMetadata(url.hostname)) return { allowed: false, reason: 'Link-local and metadata addresses are never forwarded' };
  if (allowAny || roots.some(root => isUnder(url, root))) return { allowed: true, url };
  return {
    allowed: false,
    reason:
      roots.length === 0
        ? 'This proxy has no service roots allowed, so it forwards nothing. Allow the server first (ALLOWED_SERVICE_ROOTS).'
        : `${url.origin}${url.pathname} is not under a service root this proxy allows`
  };
};

/** The roots allowed while the server runs: those it started with, and those its host allows or forgets later. */
export interface ProxyPolicy {
  readonly decide: (target: string) => ProxyDecision;
  readonly allow: (root: string) => void;
  readonly forget: (root: string) => void;
  readonly roots: () => ReadonlyArray<ServiceRoot>;
  readonly allowsAny: boolean;
}

export const createProxyPolicy = (initial: ReadonlyArray<ServiceRoot>, allowAny: boolean): ProxyPolicy => {
  // The one piece of state, scoped to this server: roots keyed by origin + path, so allowing one twice is harmless.
  const allowed = new Map(initial.map(root => [`${root.origin}${root.path}`, root]));
  return {
    decide: target => decide(target, [...allowed.values()], allowAny),
    allow: raw => {
      const [root] = parseServiceRoots(raw, 'allowServiceRoot');
      if (root) allowed.set(`${root.origin}${root.path}`, root);
    },
    forget: raw => {
      const [root] = parseServiceRoots(raw, 'forgetServiceRoot');
      if (root) allowed.delete(`${root.origin}${root.path}`);
    },
    roots: () => [...allowed.values()],
    allowsAny: allowAny
  };
};

/** How many redirects the proxy follows, each checked as a new request. */
export const MAX_PROXY_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const isRedirect = (status: number): boolean => REDIRECT_STATUSES.has(status);

/** The method a redirect is followed with, as browsers do: 303, and 301 or 302 after a POST, become GET. */
export const redirectedMethod = (status: number, method: string): string =>
  status === 303 || ((status === 301 || status === 302) && method === 'POST') ? 'GET' : method;
