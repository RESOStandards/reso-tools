/**
 * The proxy forwards only to service roots its host allows (reso-tools #424): the rule on its own, then a real app proxying
 * to real local upstream servers, so redirects and credentials are observed on the wire.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../src/config.js';
import { createApp, loadConfig } from '../src/index.js';
import { createProxyPolicy, decide, parseServiceRoots, redirectedMethod } from '../src/proxy-policy.js';

describe('service roots as they come in', () => {
  it('accepts http(s) roots and normalizes a trailing slash', () => {
    expect(parseServiceRoots('https://api.example.com/odata/, http://localhost:8080', 'ALLOWED_SERVICE_ROOTS')).toEqual([
      { origin: 'https://api.example.com', path: '/odata' },
      { origin: 'http://localhost:8080', path: '' }
    ]);
  });

  it('refuses a bad entry with a message naming it', () => {
    const bad = (value: string, pattern: RegExp) => expect(() => parseServiceRoots(value, 'ALLOWED_SERVICE_ROOTS')).toThrow(pattern);
    bad('api.example.com/odata', /is not an absolute URL/);
    bad('ftp://api.example.com', /is not an http\(s\) URL/);
    bad('https://user:pass@api.example.com', /has credentials in it/);
    bad('https://api.example.com/odata?x=1', /has a query or fragment/);
    bad('http://169.254.169.254/latest', /link-local or metadata/);
    bad('https://api.example.com, nope', /ALLOWED_SERVICE_ROOTS entry 2: "nope"/);
  });
});

describe('where the proxy may send a request', () => {
  const roots = parseServiceRoots('https://api.example.com/odata', 'test');

  it('forwards under a root, segment by segment, and nowhere else', () => {
    expect(decide('https://api.example.com/odata', roots, false).allowed).toBe(true);
    expect(decide('https://api.example.com/odata/Property?$top=1', roots, false).allowed).toBe(true);
    expect(decide('https://api.example.com/odata2/Property', roots, false).allowed).toBe(false);
    expect(decide('https://api.example.com/other', roots, false).allowed).toBe(false);
    expect(decide('http://api.example.com/odata', roots, false).allowed).toBe(false);
    expect(decide('https://api.example.com:8443/odata', roots, false).allowed).toBe(false);
    expect(decide('https://api.example.com.attacker.example/odata', roots, false).allowed).toBe(false);
  });

  it('forwards nothing when no roots are allowed, and says so', () => {
    const outcome = decide('https://api.example.com/odata', [], false);
    expect(outcome).toMatchObject({ allowed: false, reason: expect.stringMatching(/forwards nothing/) });
  });

  it('never forwards credentials in the URL, or to link-local and metadata addresses, even with the opt-out', () => {
    expect(decide('https://user:pass@api.example.com/odata', roots, true).allowed).toBe(false);
    for (const target of [
      'http://169.254.169.254/latest/meta-data',
      'http://[fd00:ec2::254]/',
      'http://metadata.google.internal/',
      'http://[fe80::1]/'
    ]) {
      expect(decide(target, roots, true).allowed).toBe(false);
    }
    expect(decide('https://anything.example/odata', roots, true).allowed).toBe(true);
  });

  it('lets the host allow and forget roots while the server runs', () => {
    const policy = createProxyPolicy([], false);
    expect(policy.decide('https://api.example.com/odata/Property').allowed).toBe(false);
    policy.allow('https://api.example.com/odata/');
    expect(policy.decide('https://api.example.com/odata/Property').allowed).toBe(true);
    policy.forget('https://api.example.com/odata');
    expect(policy.decide('https://api.example.com/odata/Property').allowed).toBe(false);
    expect(() => policy.allow('ftp://api.example.com')).toThrow(/http\(s\)/);
  });

  it('follows a redirect with the method browsers use', () => {
    expect(redirectedMethod(303, 'POST')).toBe('GET');
    expect(redirectedMethod(302, 'POST')).toBe('GET');
    expect(redirectedMethod(307, 'POST')).toBe('POST');
    expect(redirectedMethod(301, 'GET')).toBe('GET');
  });
});

// ── A real app proxying to real local servers ─────────────────────────────

const METADATA = resolve(import.meta.dirname, '../server-metadata.json');
const AUTHORIZATION = 'Bearer <test token>';

interface Upstream {
  readonly origin: string;
  readonly seen: Array<{ path: string; headers: IncomingHttpHeaders }>;
  readonly server: Server;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
});

/** A local server that records each request and answers from `route`. */
const upstream = async (route: (path: string) => { status: number; location?: string }): Promise<Upstream> => {
  const seen: Upstream['seen'] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    const { status, location } = route(req.url ?? '');
    res.writeHead(status, { 'Content-Type': 'application/json', ...(location ? { Location: location } : {}) });
    res.end(JSON.stringify({ path: req.url }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', () => done()));
  closers.push(() => new Promise<void>(done => server.close(() => done())));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
};

const app = async (overrides: Partial<ServerConfig>) => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-policy-'));
  const instance = await createApp({
    config: loadConfig({
      dbBackend: 'sqlite',
      sqliteDbPath: join(dir, 'test.db'),
      metadataPath: METADATA,
      resources: ['OUID'],
      ...overrides
    })
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', () => done()));
  closers.push(async () => {
    await new Promise<void>(done => server.close(() => done()));
    instance.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const proxy = (target: string) =>
    fetch(`${base}/api/proxy?url=${encodeURIComponent(target)}`, { headers: { Accept: 'application/json', Authorization: AUTHORIZATION } });
  return { instance, proxy };
};

describe('the proxy, end to end', () => {
  it('forwards under an allowed root with the credentials, and refuses everything else', async () => {
    const allowed = await upstream(() => ({ status: 200 }));
    const other = await upstream(() => ({ status: 200 }));
    const { proxy } = await app({ allowedServiceRoots: [`${allowed.origin}/odata`] });

    expect((await proxy(`${allowed.origin}/odata/Property`)).status).toBe(200);
    expect(allowed.seen[0]?.headers.authorization).toBe(AUTHORIZATION);
    expect((await proxy(`${other.origin}/odata/Property`)).status).toBe(403);
    expect((await proxy(`${allowed.origin}/elsewhere`)).status).toBe(403);
    expect(other.seen).toHaveLength(0);
  });

  it('refuses a redirect to a target it does not allow, before that target is reached', async () => {
    const other = await upstream(() => ({ status: 200 }));
    const allowed = await upstream(() => ({ status: 302, location: `${other.origin}/collect` }));
    const { proxy } = await app({ allowedServiceRoots: [allowed.origin] });

    const response = await proxy(`${allowed.origin}/odata/Property`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toMatch(/redirected to a target this proxy does not forward to/);
    expect(other.seen).toHaveLength(0);
  });

  it('follows a redirect within the root with the credentials, and to another allowed origin without them', async () => {
    const second = await upstream(() => ({ status: 200 }));
    const first = await upstream(path =>
      path === '/odata/start'
        ? { status: 302, location: '/odata/next' }
        : path === '/odata/next'
          ? { status: 307, location: `${second.origin}/odata/last` }
          : { status: 200 }
    );
    const { proxy } = await app({ allowedServiceRoots: [`${first.origin}/odata`, `${second.origin}/odata`] });

    expect((await proxy(`${first.origin}/odata/start`)).status).toBe(200);
    expect(first.seen.map(request => [request.path, request.headers.authorization])).toEqual([
      ['/odata/start', AUTHORIZATION],
      ['/odata/next', AUTHORIZATION]
    ]);
    expect(second.seen.map(request => [request.path, request.headers.authorization])).toEqual([['/odata/last', undefined]]);
  });

  it('forwards nothing when no roots are allowed', async () => {
    const target = await upstream(() => ({ status: 200 }));
    const { proxy } = await app({});
    const response = await proxy(`${target.origin}/odata`);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/forwards nothing/);
    expect(target.seen).toHaveLength(0);
  });

  it('forwards to a root the host allows while it runs, and stops when the host forgets it', async () => {
    const target = await upstream(() => ({ status: 200 }));
    const { instance, proxy } = await app({});
    expect((await proxy(`${target.origin}/odata`)).status).toBe(403);
    instance.allowServiceRoot(`${target.origin}/odata`);
    expect((await proxy(`${target.origin}/odata/Property`)).status).toBe(200);
    instance.forgetServiceRoot(`${target.origin}/odata`);
    expect((await proxy(`${target.origin}/odata/Property`)).status).toBe(403);
  });

  it('forwards anywhere with the opt-out, warning at start, but still not to metadata addresses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = await upstream(() => ({ status: 200 }));
    const { proxy } = await app({ allowAnyServiceRoot: true });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ALLOW_ANY_SERVICE_ROOT/));
    warn.mockRestore();
    expect((await proxy(`${target.origin}/anything`)).status).toBe(200);
    expect((await proxy('http://169.254.169.254/latest/meta-data')).status).toBe(403);
  });

  it('stops at start on a bad root, naming it', async () => {
    await expect(app({ allowedServiceRoots: ['https://api.example.com', 'ftp://nope'] })).rejects.toThrow(
      /ALLOWED_SERVICE_ROOTS entry 2: "ftp:\/\/nope" is not an http\(s\) URL/
    );
  });
});
