/**
 * When the proxy cannot reach an upstream server at all, Node's fetch rejects with a generic
 * "fetch failed" and keeps the real reason in `cause`. These tests pin how that reason is recovered
 * and reported: the code, a plain category a client can explain to a person, and a log line that
 * never carries a query string or credentials.
 */

import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { describeProxyFailure, proxyFailureLogLine } from '../src/proxy-failure.js';

const fetchFailed = (cause: unknown): TypeError => new TypeError('fetch failed', { cause });

const withCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe('describeProxyFailure', () => {
  it('recovers a TLS trust failure, the usual sign of a network that inspects HTTPS', () => {
    expect(
      describeProxyFailure(fetchFailed(withCode('unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')))
    ).toEqual({
      error: 'unable to get local issuer certificate',
      code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      kind: 'tls'
    });
  });

  it('classifies each family of failure', () => {
    const cases = [
      ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
      ['CERT_HAS_EXPIRED', 'tls'],
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
      ['ENOTFOUND', 'dns'],
      ['EAI_AGAIN', 'dns'],
      ['ECONNREFUSED', 'connect'],
      ['ECONNRESET', 'connect'],
      ['EHOSTUNREACH', 'connect'],
      ['ETIMEDOUT', 'timeout'],
      ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
      ['SOMETHING_NEW', 'other']
    ] as const;
    expect(cases.map(([code]) => describeProxyFailure(fetchFailed(withCode('x', code))).kind)).toEqual(cases.map(([, kind]) => kind));
  });

  it('reads the code from an aggregate cause, as a connection tried over IPv4 and IPv6 produces', () => {
    const aggregate = Object.assign(new AggregateError([withCode('connect ECONNREFUSED ::1:1', 'ECONNREFUSED')], ''), {
      code: undefined
    });
    expect(describeProxyFailure(fetchFailed(aggregate))).toMatchObject({ code: 'ECONNREFUSED', kind: 'connect' });
  });

  it('keeps the message of an error that carries no cause, with no code', () => {
    expect(describeProxyFailure(new Error('socket hang up'))).toEqual({
      error: 'socket hang up',
      code: null,
      kind: 'other'
    });
  });

  it('describes something thrown that is not an error at all', () => {
    expect(describeProxyFailure('boom')).toEqual({ error: 'Proxy request failed', code: null, kind: 'other' });
  });

  // The shape above is what Node documents. This checks it against a real failure, so the tests do
  // not only agree with an assumption about it.
  it('recovers the code from a real fetch failure', async () => {
    // A port that was just listening and is now closed refuses the connection for real. (A fixed
    // low port will not do: fetch refuses its blocked ports, port 1 among them, before connecting.)
    const port = await new Promise<number>(resolve => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
      });
    });
    const thrown = await fetch(`http://127.0.0.1:${port}/`).then(
      () => null,
      (err: unknown) => err
    );
    expect(describeProxyFailure(thrown)).toMatchObject({ code: 'ECONNREFUSED', kind: 'connect' });
  });
});

describe('proxyFailureLogLine', () => {
  it('names the method, origin, path, reason and code', () => {
    expect(
      proxyFailureLogLine('POST', 'https://cert-api.reso.org/api/v1/session/login', {
        error: 'unable to get local issuer certificate',
        code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        kind: 'tls'
      })
    ).toBe(
      '[proxy] POST https://cert-api.reso.org/api/v1/session/login could not be reached: unable to get local issuer certificate (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)'
    );
  });

  it('never logs a query string or credentials in the URL', () => {
    const line = proxyFailureLogLine('GET', 'https://user:secret@example.org/odata/Property?$filter=x&token=abc', {
      error: 'getaddrinfo ENOTFOUND example.org',
      code: 'ENOTFOUND',
      kind: 'dns'
    });
    expect([line.includes('secret'), line.includes('token'), line.includes('$filter'), line.includes('user:')]).toEqual([
      false,
      false,
      false,
      false
    ]);
  });

  it('omits the code when there is none', () => {
    expect(proxyFailureLogLine('GET', 'https://example.org/', { error: 'socket hang up', code: null, kind: 'other' })).toBe(
      '[proxy] GET https://example.org/ could not be reached: socket hang up'
    );
  });
});
