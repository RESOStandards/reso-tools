import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Offline: the step's two network reads are stubbed, and everything it writes is real.
vi.mock('../../src/test-runner/metadata.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/test-runner/metadata.js')>()),
  fetchMetadataWithVersion: vi.fn()
}));
vi.mock('../../src/metadata/lookup-resource.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/metadata/lookup-resource.js')>()),
  fetchAndMergeLookupResource: vi.fn()
}));

import { fetchAndMergeLookupResource } from '../../src/metadata/lookup-resource.js';
import { generateMetadata } from '../../src/sdk/dd.js';
import { SOFTWARE_VERSION } from '../../src/sdk/reports.js';
import type { DDConfig, DDContext } from '../../src/sdk/types.js';
import { fetchMetadataWithVersion } from '../../src/test-runner/metadata.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe('the Data Dictionary metadata step', () => {
  // A Data Dictionary result goes to the Cert API as this file and the availability report. The industry aggregates
  // trace a value the parser missed back to the code that wrote the report, through this field.
  it('stamps metadata-report.json with the software that wrote it', async () => {
    const edmx = await readFile(new URL('../fixtures/commander/good-edmx.xml', import.meta.url), 'utf-8');
    vi.mocked(fetchMetadataWithVersion).mockResolvedValue({ xml: edmx, odataVersion: '4.01' });
    vi.mocked(fetchAndMergeLookupResource).mockImplementation(async report => ({
      report,
      lookupResourceAvailable: false,
      lookupRecordCount: 0,
      rawRecords: undefined
    }));
    const outputPath = await mkdtemp(join(tmpdir(), 'dd-metadata-step-'));
    cleanups.push(() => rm(outputPath, { recursive: true, force: true }));

    const ctx = { serverUrl: 'https://server.example.org', authToken: 'tok', version: '2.0', outputPath } as unknown as DDContext;
    await generateMetadata({} as unknown as DDConfig).run(ctx, () => {});

    const written = JSON.parse(await readFile(join(outputPath, 'metadata-report.json'), 'utf-8'));
    expect(written.softwareVersion).toBe(SOFTWARE_VERSION);
    expect(written.fields.length).toBeGreaterThan(0);
  });
});
