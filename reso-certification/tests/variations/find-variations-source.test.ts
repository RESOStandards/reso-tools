import { describe, it, expect, vi, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findVariations } from '../../src/variations/find-variations.js';

/** Encode a report the way the /compute handler does — gzip then base64. */
const gzB64 = (obj: unknown): string => gzipSync(JSON.stringify(obj)).toString('base64');

const serviceResponse = (report: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => gzB64(report),
});

describe('findVariations — metadata source resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESO_SERVICES_URL;
  });

  it('throws when no metadata source is provided', async () => {
    await expect(findVariations({})).rejects.toThrow(/provide a metadata source/i);
  });

  it('throws when both an in-memory report and a file path are provided', async () => {
    await expect(
      findVariations({ metadataReportJson: { fields: [] }, pathToMetadataReportJson: '/tmp/x.json' }),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  it('computes from an in-memory report and writes the artifact when variations exist', async () => {
    process.env.RESO_SERVICES_URL = 'https://services.example.org';
    const report = {
      description: 'x',
      version: '2.0',
      fuzziness: 0.25,
      variations: { fields: [{ resourceName: 'Property', suggestedFieldName: 'X' }] },
    };
    const fetchMock = vi.fn().mockResolvedValue(serviceResponse(report));
    vi.stubGlobal('fetch', fetchMock);

    const dir = await mkdtemp(join(tmpdir(), 'find-variations-'));
    try {
      const result = await findVariations({
        metadataReportJson: { fields: [] },
        version: '2.0',
        fuzziness: 0.25,
        bearerToken: 'tok', // pass a token so the service client skips minting
        outputPath: dir,
      });

      // The in-memory report went to /compute (not a file read), and the report came back.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://services.example.org/v2/certification/variations/compute');
      expect(result).toEqual(report);

      // The canonical artifact was written because variations were present.
      const written = JSON.parse(await readFile(join(dir, 'data-dictionary-variations.json'), 'utf-8'));
      expect(written).toEqual(report);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a nested, non-existent --output-dir before writing (honors "created if missing")', async () => {
    process.env.RESO_SERVICES_URL = 'https://services.example.org';
    const report = {
      description: 'x',
      version: '2.0',
      fuzziness: 0.25,
      variations: { fields: [{ resourceName: 'Property', suggestedFieldName: 'X' }] },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serviceResponse(report)));

    const base = await mkdtemp(join(tmpdir(), 'find-variations-'));
    const nested = join(base, 'results', 'run1'); // does not exist yet
    try {
      await findVariations({
        metadataReportJson: { fields: [] },
        version: '2.0',
        bearerToken: 'tok',
        outputPath: nested,
      });
      const written = JSON.parse(await readFile(join(nested, 'data-dictionary-variations.json'), 'utf-8'));
      expect(written).toEqual(report);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not write an artifact when there are no variations', async () => {
    process.env.RESO_SERVICES_URL = 'https://services.example.org';
    const report = { description: 'x', version: '2.0', fuzziness: 0.25, variations: { fields: [] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serviceResponse(report)));

    const dir = await mkdtemp(join(tmpdir(), 'find-variations-'));
    try {
      const result = await findVariations({
        metadataReportJson: { fields: [] },
        version: '2.0',
        bearerToken: 'tok',
        outputPath: dir,
      });
      expect(result).toEqual(report);
      await expect(readFile(join(dir, 'data-dictionary-variations.json'), 'utf-8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
