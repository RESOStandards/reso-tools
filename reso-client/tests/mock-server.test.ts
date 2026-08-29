import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type MockServer, startMockServer } from './helpers/mock-server.js';

describe('mock server harness', () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await startMockServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => server.reset());

  it('serves queued replies FIFO and records requests in order', async () => {
    server.enqueue({ status: 200, body: { value: [1] } }, { status: 200, body: { value: [2] } });
    const a = await (await fetch(`${server.url}/Property`)).json();
    const b = await (await fetch(`${server.url}/Member`)).json();
    expect(a).toEqual({ value: [1] });
    expect(b).toEqual({ value: [2] });
    expect(server.requests.map((r) => r.url)).toEqual(['/Property', '/Member']);
  });

  it('serves a scripted 429 with a Retry-After header', async () => {
    server.enqueue({ status: 429, headers: { 'retry-after': '2' } });
    const res = await fetch(`${server.url}/Property`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it('can return a malformed (non-JSON) 200 body', async () => {
    server.enqueue({ status: 200, rawBody: '<html>gateway error</html>' });
    const res = await fetch(`${server.url}/Property`);
    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toThrow();
  });

  it('delays a response by the configured ms', async () => {
    server.enqueue({ delayMs: 40, body: { value: [] } });
    const start = Date.now();
    const res = await fetch(`${server.url}/Property`);
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('drops the socket → the client sees a transport error', async () => {
    server.enqueue({ drop: true });
    await expect(fetch(`${server.url}/Property`)).rejects.toThrow();
  });

  it('hangs → a client AbortController can time it out', async () => {
    server.enqueue({ hang: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    await expect(fetch(`${server.url}/Property`, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
    clearTimeout(timer);
  });

  it('falls back to a handler when the queue is empty', async () => {
    server.setHandler((req) => (req.url === '/Media' ? { status: 404 } : { status: 200 }));
    expect((await fetch(`${server.url}/Media`)).status).toBe(404);
    expect((await fetch(`${server.url}/Property`)).status).toBe(200);
  });
});
