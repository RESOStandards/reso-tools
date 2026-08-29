/**
 * OData HTTP client — wraps native fetch with OData-standard headers,
 * normalized response handling, and automatic token refresh with 401 retry.
 */

import type { ClientConfig, ODataClient, ODataResponse } from '../types.js';
import { SDK_VERSION } from '../version.js';
import { createTokenProvider } from './auth.js';
import { resilientSend } from './resilience/resilient-send.js';
import { createResilienceSession } from './resilience/session.js';

const HTTP_UNAUTHORIZED = 401;

/** Derives the governor/breaker key from a request URL: `host|resource`. */
const resilienceKey = (url: string): string => {
  try {
    const parsed = new URL(url);
    const firstSegment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    return `${parsed.host}|${firstSegment.split('(')[0]}`;
  } catch {
    return url;
  }
};

/**
 * Parse a fetch Response into a normalized ODataResponse.
 */
const parseResponse = async (response: Response): Promise<ODataResponse> => {
  const rawBody = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Empty body is expected for 204 No Content
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });

  return { status: response.status, headers: responseHeaders, body, rawBody };
};

/**
 * Create an OData client for the given configuration.
 *
 * The client automatically sets OData-Version, Content-Type, Accept, and
 * Authorization headers on every request. For Client Credentials auth,
 * tokens are refreshed proactively at 90% TTL and reactively on 401.
 *
 * @example
 * ```ts
 * const client = await createClient({
 *   baseUrl: "http://localhost:8080",
 *   auth: { mode: "token", authToken: "test" },
 * });
 *
 * const response = await client.request("GET", "http://localhost:8080/Property('key')");
 * ```
 */
export const createClient = async (config: ClientConfig): Promise<ODataClient> => {
  const tokenProvider = createTokenProvider(config.auth);

  // Eagerly warm the token cache
  await tokenProvider();

  const doFetch = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    token: string,
    options?: {
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    },
    signal?: AbortSignal
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      // Identifying User-Agent so servers behind WAFs (e.g. MLS Grid)
      // do not reject the request based on undici's default of 'node'.
      // Consumers can override via config.defaultHeaders or options.headers.
      'User-Agent': `RESO-Client-SDK/${SDK_VERSION}`,
      Authorization: `Bearer ${token}`,
      ...config.defaultHeaders,
      ...options?.headers,
    };

    // Only send OData-Version if configured — some servers (e.g., FBS/Spark)
    // reject 4.01 but accept 4.0. The version can be detected from metadata
    // and passed via config.defaultHeaders or options.headers.
    // Not sent by default for maximum compatibility.

    // Only set Content-Type on requests that carry a body
    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }

    // Pass the URL as-is — some servers (e.g., Spark API) reject %24-encoded
    // OData system query options. The URI builder's encoding is decoded back
    // to literal $ for maximum compatibility.
    const encodedUrl = url.replace(/%24/g, '$');

    return fetch(encodedUrl, {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      keepalive: true,
      signal
    });
  };

  const session = config.session ?? createResilienceSession(config.resilience);

  const request = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options?: {
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  ): Promise<ODataResponse> => {
    // One physical attempt: token -> fetch -> one-shot 401 refresh -> normalized response.
    // The resilient send layers timeout, pacing, retry/backoff, and the breaker around it.
    const send = async (signal: AbortSignal): Promise<ODataResponse> => {
      const token = await tokenProvider();
      const response = await doFetch(method, url, token, options, signal);
      if (response.status === HTTP_UNAUTHORIZED) {
        const freshToken = await tokenProvider(true);
        if (freshToken !== token) {
          return parseResponse(await doFetch(method, url, freshToken, options, signal));
        }
      }
      return parseResponse(response);
    };

    return resilientSend(send, method, resilienceKey(url), session);
  };

  return {
    baseUrl: config.baseUrl,
    request
  };
};
