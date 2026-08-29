import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { runPagingScenario } from '../../src/web-api-core/test-runner.js';

const response = (status: number, value: unknown[] = [], nextLink?: string): ODataResponse => ({
  status,
  headers: { 'odata-version': '4.01' },
  body: { value, ...(nextLink ? { '@odata.nextLink': nextLink } : {}) },
  rawBody: ''
});

// The injected test client — returns the scripted responses in order (one per page fetch).
const queuedRequester = (responses: readonly ODataResponse[]): ODataRequester => {
  const queue = [...responses];
  return {
    request: async () => {
      const next = queue.shift();
      if (!next) throw new Error('requester queue exhausted');
      return next;
    }
  };
};

const params: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true
};

const run = (requester: ODataRequester) => runPagingScenario('http://x', 'Property', params, 'tok', 0, requester);

// Characterization: locks runPagingScenario's outcomes, exercised through an injected test
// client (no vi.mock). Behaviour is unchanged by the injection — the default requester is the
// production one, and the full suite stays green.
describe('runPagingScenario (characterization — injected test client)', () => {
  it('multiple pages then no nextLink → passes', async () => {
    const out = await run(
      queuedRequester([
        response(200, [{ ListingKey: '1' }], 'http://x/Property?$skiptoken=2'),
        response(200, [{ ListingKey: '2' }])
      ])
    );
    expect(out.tag).toBe('server-driven-paging');
    expect(out.passed).toBe(true);
    expect(out.skipped).toBe(false);
  });

  it('single page with no nextLink → valid (fewer records than the page size) → passes', async () => {
    const out = await run(queuedRequester([response(200, [{ ListingKey: '1' }])]));
    expect(out.passed).toBe(true);
  });

  it('a non-200 page → fails', async () => {
    const out = await run(queuedRequester([response(400)]));
    expect(out.passed).toBe(false);
  });

  it('a malformed/failed response → errored → fails (caught, not thrown)', async () => {
    const out = await run(queuedRequester([undefined as unknown as ODataResponse]));
    expect(out.passed).toBe(false);
  });
});
