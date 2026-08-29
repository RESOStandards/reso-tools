import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyThrown } from '../src/http/resilience/errors.js';
import { withTimeout } from '../src/http/resilience/timeout.js';
import { type MockServer, startMockServer } from './helpers/mock-server.js';

describe('withTimeout', () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await startMockServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => server.reset());

  it('resolves normally when the request completes in time', async () => {
    server.enqueue({ status: 200, body: { ok: true } });
    const res = await withTimeout(1000, (signal) => fetch(`${server.url}/Property`, { signal }));
    expect(res.status).toBe(200);
  });

  it('aborts a hung request, and the abort classifies as a retryable timeout', async () => {
    server.enqueue({ hang: true });
    try {
      await withTimeout(30, (signal) => fetch(`${server.url}/Property`, { signal }));
      expect.unreachable('the hung request should have timed out');
    } catch (err) {
      const c = classifyThrown(err);
      expect(c.kind).toBe('timeout');
      expect(c.retryable).toBe(true);
    }
  });

  it('does not abort a slow-but-completing request when disabled (0)', async () => {
    server.enqueue({ delayMs: 20, status: 200 });
    const res = await withTimeout(0, (signal) => fetch(`${server.url}/Property`, { signal }));
    expect(res.status).toBe(200);
  });
});
