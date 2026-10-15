/**
 * Saving what a run received, and never saving a credential while doing it.
 *
 * A Core report keeps `requestUrl` and no response body, so a passing run leaves nothing to
 * inspect: a skip can be verified from the request log (a skipped scenario issues no query), a
 * pass cannot. These cover the capture seam and, with more weight, the filter that keeps
 * credentials out of the files it writes.
 */

import { describe, expect, it, vi } from 'vitest';
import { bodyExtension, captureStem, createCapturingRequester, isKeptHeader, onlyKeptHeaders } from '../src/test-runner/payload-capture.js';
import type { ODataRequester } from '../src/test-runner/requester.js';

/** A responder whose rawBody is deliberately NOT a re-serialization of `body`, so a test can tell
 *  which one reached disk. */
const ok = (rawBody: string, headers: Record<string, string> = { 'content-type': 'application/json' }): ODataRequester => ({
  request: async () => ({ status: 200, headers, body: JSON.parse(rawBody), rawBody })
});

describe('isKeptHeader', () => {
  it('keeps the headers the RESO specs and the OData protocol turn on', () => {
    for (const name of [
      'OData-Version',
      'odata-version',
      'OData-MaxVersion',
      'OData-EntityId',
      'OData-Isolation',
      'Accept',
      'Content-Type',
      'Accept-Language',
      'Content-Language',
      'Prefer',
      'Preference-Applied',
      'Retry-After',
      'WWW-Authenticate'
    ]) {
      expect(isKeptHeader(name), name).toBe(true);
    }
  });

  it('keeps nothing else, which is what makes a credential unable to leak', () => {
    // An allowlist defaults to empty. A header reaches disk only because it was named on purpose,
    // so an auth header nobody anticipated cannot get through.
    for (const name of [
      'Authorization',
      'authorization',
      'AUTHORIZATION',
      'Proxy-Authorization',
      'Cookie',
      'Set-Cookie',
      'X-Api-Key',
      'X-Auth-Token',
      'X-Access-Token',
      'X-Amz-Security-Token',
      'X-Whatever-A-Provider-Invents-Next',
      'Server',
      'Date'
    ]) {
      expect(isKeptHeader(name), name).toBe(false);
    }
  });
});

describe('onlyKeptHeaders', () => {
  it('reduces to the kept names and drops the rest, in any casing', () => {
    const kept = onlyKeptHeaders({
      Authorization: 'Bearer <fixture-placeholder-not-a-credential>',
      'CONTENT-TYPE': 'application/json',
      'odata-version': '4.01'
    });
    expect(kept).toEqual({ 'CONTENT-TYPE': 'application/json', 'odata-version': '4.01' });
    expect(JSON.stringify(kept)).not.toContain('fixture-placeholder');
  });

  it('defaults empty', () => {
    expect(onlyKeptHeaders(undefined)).toEqual({});
  });
});

describe('bodyExtension', () => {
  it('saves metadata as XML so it opens in the tools someone would reach for', () => {
    expect(bodyExtension('application/xml;charset=utf-8')).toBe('xml');
    expect(bodyExtension('application/json;odata.metadata=minimal')).toBe('json');
    expect(bodyExtension(undefined)).toBe('bin');
  });
});

describe('captureStem', () => {
  it('sorts in request order and stays recognizable', () => {
    expect(captureStem(1, 'GET', 'https://api.example.com/OData/x/Property?$top=5')).toBe('0001-get-OData-x-Property-top-5');
  });

  it('pads so the tenth sorts after the second', () => {
    const names = [captureStem(2, 'GET', 'https://h/a'), captureStem(10, 'GET', 'https://h/a')];
    expect([...names].sort()).toEqual(names);
  });

  it('truncates a query longer than a filesystem accepts', () => {
    expect(captureStem(1, 'GET', `https://h/P?$filter=${'A'.repeat(500)}`).length).toBeLessThan(120);
  });
});

describe('createCapturingRequester', () => {
  it('writes the body EXACTLY as it came off the wire', async () => {
    // The point of the whole thing. `response.body` is parsed; re-serializing it reorders keys and
    // can move the precision of an Edm.Decimal, so the file would stop being what the server sent.
    const wire = '{"value":[{"ListPrice":425000.00,"b":1,"a":2}]}';
    const files = new Map<string, string>();
    const requester = createCapturingRequester(ok(wire), async (n, c) => void files.set(n, c));

    await requester.request({ method: 'GET', url: 'https://h/Property', authToken: 't' });

    expect(files.get('0001-get-Property')).toBeUndefined();
    expect(files.get('0001-get-Property.json')).toBe(wire);
  });

  it('returns the response unchanged', async () => {
    const requester = createCapturingRequester(ok('{"value":[]}'), async () => {});
    const response = await requester.request({ method: 'GET', url: 'https://h/Property', authToken: 't' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ value: [] });
  });

  it('never writes the authToken, which is not a header and so no header rule could catch it', async () => {
    // The fixture is deliberately shaped like a PLACEHOLDER, not like a token. An earlier version
    // used a real JWT header prefix, which authenticates nothing and still tripped secret scanning
    // the moment it reached a public repository. A test that proves a credential is withheld should
    // not itself be mistakable for one, and angle brackets say "stand-in" to a reader and to a
    // scanner alike.
    const files = new Map<string, string>();
    const requester = createCapturingRequester(ok('{"value":[]}'), async (n, c) => void files.set(n, c));

    await requester.request({
      method: 'GET',
      url: 'https://h/Property',
      authToken: '<fixture-placeholder-authToken>',
      headers: { Authorization: 'Bearer <fixture-placeholder-header>', Prefer: 'odata.maxpagesize=10' }
    });

    const all = [...files.values()].join('\n');
    expect(all).not.toContain('fixture-placeholder');
    expect(all).not.toContain('Authorization');
    expect(all).toContain('odata.maxpagesize=10');
  });

  it('records the OData-Version the requester adds below this seam', async () => {
    // It is a client default rather than a passed header, so a capture reading `options.headers`
    // alone would omit the one request header a Core run most needs to show.
    const files = new Map<string, string>();
    const requester = createCapturingRequester(ok('{}'), async (n, c) => void files.set(n, c));
    await requester.request({ method: 'GET', url: 'https://h/P', authToken: 't', odataVersion: '4.01' });
    expect(JSON.parse(files.get('0001-get-P.meta.json') as string).requestHeaders['OData-Version']).toBe('4.01');
  });

  it('freezes the envelope, because evidence a later stage can edit is not evidence', async () => {
    const metas: string[] = [];
    const requester = createCapturingRequester(ok('{}'), async (n, c) => {
      if (n.endsWith('.meta.json')) metas.push(c);
    });
    await requester.request({ method: 'GET', url: 'https://h/P', authToken: 't' });
    const meta = JSON.parse(metas[0]);
    expect(meta).toMatchObject({ seq: 1, method: 'GET', status: 200, bodyFile: '0001-get-P.json' });
    expect(meta.bodyBytes).toBe(2);
  });

  it('numbers exchanges in order', async () => {
    const names: string[] = [];
    const requester = createCapturingRequester(ok('{}'), async n => void names.push(n));
    await requester.request({ method: 'GET', url: 'https://h/a', authToken: 't' });
    await requester.request({ method: 'GET', url: 'https://h/b', authToken: 't' });
    expect(names.filter(n => n.endsWith('.meta.json')).map(n => n.slice(0, 4))).toEqual(['0001', '0002']);
  });

  it('a write failure does not fail the run', async () => {
    // Capture is instrumentation. A full disk must not turn a passing certification into a failing
    // one, and the error still surfaces rather than being swallowed.
    const onWriteError = vi.fn();
    const requester = createCapturingRequester(
      ok('{"value":[]}'),
      async () => {
        throw new Error('ENOSPC');
      },
      onWriteError
    );
    const response = await requester.request({ method: 'GET', url: 'https://h/Property', authToken: 't' });
    expect(response.status).toBe(200);
    expect(onWriteError).toHaveBeenCalledOnce();
  });
});
