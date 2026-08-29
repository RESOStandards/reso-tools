import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';

// The metadata scenario fetches through a separate path (fetchMetadataWithVersion), not the
// requester seam, so mock it — this test is about the requester threading, not the metadata path.
vi.mock('../../src/test-runner/metadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/test-runner/metadata.js')>();
  return {
    ...actual,
    fetchMetadataWithVersion: vi.fn(async () => ({ xml: '<edmx:Edmx></edmx:Edmx>', odataVersion: '4.01' }))
  };
});

import { runCoreResourceScenarios } from '../../src/web-api-core/test-runner.js';

const params: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerField: 'BedroomsTotal',
  integerValueHigh: 3,
  integerValueLow: 1,
  integerValueMin: 1,
  integerValueMax: 5,
  integerNotSentinel: -1,
  skippedTypes: [],
  sampleComplete: true
};

// A recording test client — serves every OData request from the injected seam and logs the URLs.
const recordingRequester = (): { requester: ODataRequester; urls: string[] } => {
  const urls: string[] = [];
  return {
    requester: {
      request: async (options) => {
        urls.push(options.url);
        return {
          status: 200,
          headers: { 'odata-version': '4.01' },
          body: { value: [{ ListingKey: '1', BedroomsTotal: 3 }], '@odata.count': 1 },
          rawBody: ''
        };
      }
    },
    urls
  };
};

describe('runCoreResourceScenarios — container with an injected test client (#125)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs the whole resource through the injected requester — no real network', async () => {
    // If any runner still reached the free odataRequest (a missed thread), it would call global
    // fetch. With the requester injected and metadata mocked, complete threading means fetch is
    // never touched — so this spy is the end-to-end proof.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected real network call'));
    const rec = recordingRequester();

    const report = await runCoreResourceScenarios('http://server', 'Property', params, 'tok', '2.0.0', rec.requester);

    // The container produced a well-formed report.
    expect(report.resource).toBe('Property');
    expect(report.scenarios.length).toBeGreaterThan(0);
    expect(report.summary).toBeDefined();

    // Every OData request went through the injected client, and nothing reached the network.
    expect(rec.urls.length).toBeGreaterThan(0);
    for (const url of rec.urls) expect(url).toContain('http://server');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
