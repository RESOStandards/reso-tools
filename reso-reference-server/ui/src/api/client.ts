import type { ODataCollectionResponse, ODataError } from '../types';

/** Query parameters for collection requests. */
export interface CollectionParams {
  readonly $filter?: string;
  readonly $select?: string;
  readonly $orderby?: string;
  readonly $top?: number;
  readonly $skip?: number;
  readonly $count?: boolean;
  readonly $expand?: string;
}

/** Runtime API configuration — set by ServerProvider when the active server changes. */
interface ApiConfig {
  baseUrl: string;
  token?: string;
}

const apiConfig: ApiConfig = { baseUrl: '' };

/** Configure the API client's base URL and auth token. Called by ServerProvider. */
export const setApiConfig = (baseUrl: string, token?: string): void => {
  apiConfig.baseUrl = baseUrl;
  apiConfig.token = token;
};

/** Build request headers, including auth token if configured. */
const buildHeaders = (extra?: Record<string, string>): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...extra
  };
  if (apiConfig.token) {
    headers['Authorization'] = `Bearer ${apiConfig.token}`;
  }
  return headers;
};

/** Check whether the current config points to an external (non-local) server. */
const isExternal = (): boolean => apiConfig.baseUrl !== '';

/** Check whether a URL points to localhost (same machine — no CORS, skip proxy). */
const isLocalhostUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  } catch {
    return false;
  }
};

/**
 * Resolve a URL for fetching.
 * - Local server (baseUrl empty): relative paths go through Vite dev proxy; absolute nextLinks are stripped to path.
 * - External localhost server: connect directly (same machine, no CORS issues).
 * - External remote server: route through /api/proxy?url=... to avoid browser CORS restrictions.
 */
const resolveUrl = (path: string): string => {
  if (!isExternal()) {
    // Local server
    if (!path.startsWith('http://') && !path.startsWith('https://')) {
      return path;
    }
    // Absolute nextLink from local server — strip origin for dev proxy
    try {
      const parsed = new URL(path);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return path;
    }
  }

  // External server — build the full target URL
  const fullUrl = path.startsWith('http://') || path.startsWith('https://')
    ? rebaseNextLink(path)
    : `${apiConfig.baseUrl}${path}`;

  // Localhost URLs can be fetched directly — no CORS issues on same machine
  if (isLocalhostUrl(fullUrl)) {
    return fullUrl;
  }

  // Remote URLs go through the proxy to avoid CORS
  return `/api/proxy?url=${encodeURIComponent(fullUrl)}`;
};

/** Returns true when the resolved URL goes through the proxy (needs cache bypass to avoid stale 304s). */
const isProxied = (resolvedUrl: string): boolean => resolvedUrl.startsWith('/api/proxy');

/** Build fetch options, disabling browser cache for proxied requests to prevent stale 304 responses. */
const buildFetchOptions = (resolvedUrl: string, extra?: RequestInit): RequestInit => ({
  ...extra,
  ...(isProxied(resolvedUrl) ? { cache: 'no-store' as const } : {})
});

/** Rebase an absolute nextLink onto the configured baseUrl (external servers may return internal hostnames). */
const rebaseNextLink = (url: string): string => {
  try {
    const parsed = new URL(url);
    const base = new URL(apiConfig.baseUrl);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  } catch {
    return url;
  }
};

/** Builds a query string from OData params. */
const buildQueryString = (params: CollectionParams): string => {
  const parts: string[] = [];
  if (params.$filter) parts.push(`$filter=${encodeURIComponent(params.$filter)}`);
  if (params.$select) parts.push(`$select=${encodeURIComponent(params.$select)}`);
  if (params.$orderby) parts.push(`$orderby=${encodeURIComponent(params.$orderby)}`);
  if (params.$top !== undefined) parts.push(`$top=${params.$top}`);
  if (params.$skip !== undefined) parts.push(`$skip=${params.$skip}`);
  if (params.$count) parts.push('$count=true');
  if (params.$expand) parts.push(`$expand=${encodeURIComponent(params.$expand)}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

/** Extracts an OData error from a failed response, or builds a generic one. */
const parseError = async (res: Response): Promise<ODataError> => {
  try {
    const body = await res.json();
    if (body?.error) return body as ODataError;
  } catch {
    // Ignore parse errors
  }
  return {
    error: {
      code: String(res.status),
      message: res.statusText || 'Request failed',
      details: []
    }
  };
};

/** Queries a resource collection. Uses Prefer: odata.maxpagesize for server-driven pagination. */
export const queryCollection = async (
  resource: string,
  params: CollectionParams = {},
  maxpagesize?: number
): Promise<ODataCollectionResponse> => {
  const url = resolveUrl(`/${resource}${buildQueryString(params)}`);
  const extra: Record<string, string> = {};
  if (maxpagesize !== undefined) {
    extra['Prefer'] = `odata.maxpagesize=${maxpagesize}`;
  }
  const res = await fetch(url, buildFetchOptions(url, { headers: buildHeaders(extra) }));
  if (!res.ok) throw await parseError(res);
  return res.json();
};

/** Fetches a collection response from a raw URL (e.g., an @odata.nextLink). */
export const fetchCollectionByUrl = async (url: string, maxpagesize?: number): Promise<ODataCollectionResponse> => {
  const resolved = resolveUrl(url);
  const extra: Record<string, string> = {};
  if (maxpagesize !== undefined) {
    extra['Prefer'] = `odata.maxpagesize=${maxpagesize}`;
  }
  const res = await fetch(resolved, buildFetchOptions(resolved, { headers: buildHeaders(extra) }));
  if (!res.ok) throw await parseError(res);
  return res.json();
};

/** Reads a single entity by key. */
export const readEntity = async (
  resource: string,
  key: string,
  params?: { $select?: string; $expand?: string }
): Promise<Record<string, unknown>> => {
  const qs: string[] = [];
  if (params?.$select) qs.push(`$select=${encodeURIComponent(params.$select)}`);
  if (params?.$expand) qs.push(`$expand=${encodeURIComponent(params.$expand)}`);
  const queryStr = qs.length > 0 ? `?${qs.join('&')}` : '';
  const url = resolveUrl(`/${resource}('${encodeURIComponent(key)}')${queryStr}`);
  const res = await fetch(url, buildFetchOptions(url, { headers: buildHeaders() }));
  if (!res.ok) throw await parseError(res);
  return res.json();
};

/** Creates a new entity. Returns the created record (with server-generated key). */
export const createEntity = async (resource: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const url = resolveUrl(`/${resource}`);
  const res = await fetch(url, buildFetchOptions(url, {
    method: 'POST',
    headers: buildHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }),
    body: JSON.stringify(body)
  }));
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return {};
  return res.json();
};

/** Updates an entity by key (PATCH — merge semantics). */
export const updateEntity = async (
  resource: string,
  key: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const url = resolveUrl(`/${resource}('${encodeURIComponent(key)}')`);
  const res = await fetch(url, buildFetchOptions(url, {
    method: 'PATCH',
    headers: buildHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }),
    body: JSON.stringify(body)
  }));
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return {};
  return res.json();
};

/** Deletes an entity by key. */
export const deleteEntity = async (resource: string, key: string): Promise<void> => {
  const url = resolveUrl(`/${resource}('${encodeURIComponent(key)}')`);
  const res = await fetch(url, buildFetchOptions(url, {
    method: 'DELETE',
    headers: buildHeaders()
  }));
  if (!res.ok) throw await parseError(res);
};
