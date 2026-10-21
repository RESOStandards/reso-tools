/**
 * Describing why the proxy could not reach an upstream server.
 *
 * Node's fetch rejects every connection failure with the same TypeError, "fetch failed", and keeps
 * the real reason in `cause`: a DNS failure, a refused or timed-out connection, or a TLS
 * certificate the machine does not trust. That last one is what a corporate network that inspects
 * HTTPS produces, because Node does not use the operating system's certificate store. Without the
 * cause, every one of them reaches the client as the same bare 502.
 */

export type ProxyFailureKind = 'tls' | 'dns' | 'connect' | 'timeout' | 'other';

export interface ProxyFailure {
  /** The most specific message available, for the log and the response. */
  readonly error: string;
  /** Node's error code, when one is available. */
  readonly code: string | null;
  /** A plain category a client can explain to a person without knowing Node's codes. */
  readonly kind: ProxyFailureKind;
}

const FALLBACK_MESSAGE = 'Proxy request failed';
const GENERIC_FETCH_MESSAGE = 'fetch failed';

const TLS_CODE_PREFIXES: ReadonlyArray<string> = ['CERT_', 'UNABLE_TO_', 'SELF_SIGNED_', 'DEPTH_ZERO_', 'ERR_TLS_', 'ERR_SSL_'];
const DNS_CODES: ReadonlyArray<string> = ['ENOTFOUND', 'EAI_AGAIN'];
const CONNECT_CODES: ReadonlyArray<string> = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'];
const TIMEOUT_CODES: ReadonlyArray<string> = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const stringOf = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** The first code on the error, its cause, or any error an aggregate cause holds. */
const findCode = (err: unknown): string | null => {
  if (!isRecord(err)) return null;
  const cause = isRecord(err.cause) ? err.cause : null;
  const nested = Array.isArray(cause?.errors) ? cause.errors : [];
  const candidates = [cause?.code, ...nested.map(inner => (isRecord(inner) ? inner.code : null)), err.code];
  return candidates.map(stringOf).find((code): code is string => code !== null) ?? null;
};

/** The cause's message when the error itself only says "fetch failed". */
const findMessage = (err: unknown): string => {
  if (!(err instanceof Error)) return FALLBACK_MESSAGE;
  const causeMessage = isRecord(err.cause) ? stringOf(err.cause.message) : null;
  return err.message === GENERIC_FETCH_MESSAGE && causeMessage ? causeMessage : err.message || FALLBACK_MESSAGE;
};

const classify = (code: string | null): ProxyFailureKind => {
  if (code === null) return 'other';
  if (TLS_CODE_PREFIXES.some(prefix => code.startsWith(prefix))) return 'tls';
  if (DNS_CODES.includes(code)) return 'dns';
  if (CONNECT_CODES.includes(code)) return 'connect';
  if (TIMEOUT_CODES.includes(code)) return 'timeout';
  return 'other';
};

export const describeProxyFailure = (err: unknown): ProxyFailure => {
  const code = findCode(err);
  return { error: findMessage(err), code, kind: classify(code) };
};

/** One line for the server log. Names the origin and path only: the query string and any
 *  credentials in the URL never reach the log. */
export const proxyFailureLogLine = (method: string, targetUrl: string, failure: ProxyFailure): string => {
  const parsed = new URL(targetUrl);
  const reason = failure.code ? `${failure.error} (${failure.code})` : failure.error;
  return `[proxy] ${method} ${parsed.origin}${parsed.pathname} could not be reached: ${reason}`;
};
