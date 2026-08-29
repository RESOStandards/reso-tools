import { createResilienceSession } from '@reso-standards/reso-client';
import { describe, expect, it, vi } from 'vitest';

// Mock the underlying odataRequest so we can assert the session is threaded onto every request.
vi.mock('../src/test-runner/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/test-runner/client.js')>();
  return {
    ...actual,
    odataRequest: vi.fn(async () => ({ status: 200, headers: {}, body: {}, rawBody: '' }))
  };
});

import { odataRequest } from '../src/test-runner/client.js';
import { createSessionRequester } from '../src/test-runner/requester.js';

describe('createSessionRequester', () => {
  it('threads the shared session onto every request (so the breaker/pacing persist across the run)', async () => {
    const session = createResilienceSession({ governor: { ratePerSec: 0, burst: 0 } });
    const requester = createSessionRequester(session);

    await requester.request({ method: 'GET', url: 'http://server/Property', authToken: 'tok' });
    await requester.request({ method: 'GET', url: 'http://server/Member', authToken: 'tok' });

    // Both requests carry the SAME session instance — that's what makes it shared.
    expect(odataRequest).toHaveBeenCalledTimes(2);
    expect(odataRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({ session, url: 'http://server/Property' }));
    expect(odataRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ session, url: 'http://server/Member' }));
  });
});
