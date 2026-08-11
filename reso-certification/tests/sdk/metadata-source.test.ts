import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

// Mock the $metadata fetcher so the test is offline + deterministic (no reso-client
// HTTP path). metadata-source.ts only depends on fetchMetadataWithVersion from here.
vi.mock('../../src/test-runner/metadata.js', () => ({
  fetchMetadataWithVersion: vi.fn(),
}));

import { fetchMetadataWithVersion } from '../../src/test-runner/metadata.js';
import { fetchMetadataReportFromServer } from '../../src/sdk/metadata-source.js';

describe('fetchMetadataReportFromServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches $metadata from the endpoint (with the bearer) and serializes it to a report', async () => {
    // good-edmx.xml carries an EntityContainer, which generateMetadataReport requires
    // (sample-metadata.xml is deliberately the no-container negative case elsewhere).
    const sampleEdmx = await readFile(new URL('../fixtures/commander/good-edmx.xml', import.meta.url), 'utf-8');
    vi.mocked(fetchMetadataWithVersion).mockResolvedValue({ xml: sampleEdmx, odataVersion: '4.01' });

    const report = await fetchMetadataReportFromServer({
      url: 'https://server.example.org',
      bearerToken: 'tok',
      version: '2.0',
    });

    // The endpoint + bearer are passed straight through to the fetcher.
    expect(fetchMetadataWithVersion).toHaveBeenCalledWith('https://server.example.org', 'tok');
    // The serialized report carries fields — i.e. the CSDL was actually parsed, not passed through.
    expect(report.fields.length).toBeGreaterThan(0);
    expect(report.resources.length).toBeGreaterThan(0);
  });

  it('propagates a fetch failure rather than swallowing it', async () => {
    vi.mocked(fetchMetadataWithVersion).mockRejectedValue(new Error('HTTP 401 Unauthorized'));

    await expect(
      fetchMetadataReportFromServer({ url: 'https://server.example.org', bearerToken: 'bad', version: '2.0' }),
    ).rejects.toThrow('401');
  });
});
