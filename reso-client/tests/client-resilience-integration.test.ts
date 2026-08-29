import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../src/http/client.js';
import { isResilienceError } from '../src/http/resilience/errors.js';
import type { ClientConfig } from '../src/types.js';
import { type MockServer, startMockServer } from './helpers/mock-server.js';

// Pacing off + tiny waits so the real-fetch retry path runs fast.
const fastResilience: ClientConfig['resilience'] = {
  governor: { ratePerSec: 0, burst: 0 },
  backoff: { baseMs: 1, maxMs: 5, maxRetries: 3 },
  defaultRetryWaitMs: 5,
  maxRetryWaitMs: 10_000,
  timeoutMs: 200
};

describe('createClient — resilience integration (real fetch, misbehaving server)', () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await startMockServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => server.reset());

  const makeClient = () =>
    createClient({
      baseUrl: server.url,
      auth: { mode: 'token', authToken: 'test' },
      resilience: fastResilience
    });

  it('returns a 200 through the resilient path', async () => {
    server.enqueue({ status: 200, body: { value: [1] } });
    const client = await makeClient();
    const res = await client.request('GET', `${server.url}/Property`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ value: [1] });
  });

  it('retries a real 429, then succeeds', async () => {
    server.enqueue({ status: 429, headers: { 'retry-after': '0' } }, { status: 200, body: { value: [] } });
    const client = await makeClient();
    const res = await client.request('GET', `${server.url}/Property`);
    expect(res.status).toBe(200);
    expect(server.requests.length).toBe(2);
  });

  it('retries a real dropped connection, then succeeds', async () => {
    server.enqueue({ drop: true }, { status: 200, body: { value: [] } });
    const client = await makeClient();
    const res = await client.request('GET', `${server.url}/Property`);
    expect(res.status).toBe(200);
    expect(server.requests.length).toBe(2);
  });

  it('returns a terminal 404 without retrying', async () => {
    server.enqueue({ status: 404 });
    const client = await makeClient();
    const res = await client.request('GET', `${server.url}/Media`);
    expect(res.status).toBe(404);
    expect(server.requests.length).toBe(1);
  });

  it('times out a persistently hung endpoint and exhausts retries', async () => {
    server.setHandler(() => ({ hang: true }));
    const client = await makeClient();
    try {
      await client.request('GET', `${server.url}/Property`);
      expect.unreachable('a hung endpoint should have timed out and exhausted');
    } catch (err) {
      expect(isResilienceError(err) && err.resilienceKind === 'exhausted').toBe(true);
    }
  }, 10_000);
});
