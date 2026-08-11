import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { processRcfStream, runRcf } from '../../src/cli/rcf-command.js';
import type { RcfPayload } from '../../src/cli/rcf-input.js';
import type { DdSchemaValidator } from '../../src/cli/schema-command.js';
import { computeVariationsViaService } from '../../src/variations/index.js';
import { serviceError } from '../../src/sdk/common.js';

// Mock only computeVariationsViaService; the real isVariationsAuthError still runs, so the
// degrade-vs-rethrow branch is exercised against genuine coded service errors.
vi.mock('../../src/variations/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/variations/index.js')>();
  return { ...actual, computeVariationsViaService: vi.fn() };
});
const mockedCompute = vi.mocked(computeVariationsViaService);

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rcf');

async function* stream(payloads: RcfPayload[]): AsyncGenerator<RcfPayload> {
  for (const p of payloads) yield p;
}

describe('processRcfStream', () => {
  it('accumulates records + per-field availability across the stream', async () => {
    const result = await processRcfStream(
      stream([
        { source: 'a', resource: 'Property', version: '2.0', records: [{ ListingKey: '1', City: 'X' }, { ListingKey: '2' }] },
        { source: 'b', resource: 'Property', records: [{ ListingKey: '3', City: 'Y' }] },
      ]),
    );
    expect(result.version).toBe('2.0'); // first payload that carried one
    expect(result.totalRecords).toBe(3);
    expect(result.recordsByResource.Property).toHaveLength(3);
    expect(result.availability.Property.recordCount).toBe(3);
    expect(result.availability.Property.fields.ListingKey).toBe(3);
    expect(result.availability.Property.fields.City).toBe(2); // present in 2 of 3 records
  });

  it('caps accumulated records for inference but counts availability over ALL records', async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ ListingKey: String(i), City: 'X' }));
    const result = await processRcfStream(stream([{ source: 'a', resource: 'Property', version: '2.0', records }]), { sampleCap: 4 });
    expect(result.recordsByResource.Property).toHaveLength(4); // capped for inference
    expect(result.availability.Property.recordCount).toBe(10); // all counted for availability
    expect(result.availability.Property.fields.City).toBe(10);
  });

  it('strict: throws a schemaFailure on the first payload with errors (fast-fail)', async () => {
    const validator: DdSchemaValidator = { validate: () => ({}), combine: () => ({ totalErrors: 3, report: {} }) };
    await expect(
      processRcfStream(stream([{ source: 'bad', resource: 'Property', version: '2.0', records: [{}] }]), { validator, strict: true }),
    ).rejects.toMatchObject({ schemaFailure: true });
  });

  it('accumulate: collects the error total, does not throw', async () => {
    const validator: DdSchemaValidator = { validate: () => ({}), combine: () => ({ totalErrors: 5, report: { x: 1 } }) };
    const result = await processRcfStream(stream([{ source: 'a', resource: 'Property', version: '2.0', records: [{}] }]), { validator });
    expect(result.schemaErrors).toBe(5);
  });
});

describe('runRcf (offline)', () => {
  it('infers a metadata report + data-availability report from a fixture, skipping variations', async () => {
    const result = await runRcf({
      input: resolve(fixtures, 'single-payload.json'),
      generatedOn: '2026-01-01T00:00:00.000Z',
      runVariations: false,
    });
    expect(result.version).toBe('2.0'); // peeked from @reso.context
    expect(result.variations).toBeUndefined();
    expect(result.stats.totalRecords).toBe(2);
    expect(result.metadataReport.fields.length).toBeGreaterThan(0);
    const da = result.dataAvailabilityReport as { resources: ReadonlyArray<{ resourceName: string }> };
    expect(da.resources.some(r => r.resourceName === 'Property')).toBe(true);
  });

  // Real DD validator (not a mock): guards the two crashes the mock tests couldn't see.
  it('schema-validates an @odata.context payload — the resolved version threads into validation (no "Version is required")', async () => {
    const result = await runRcf({
      input: resolve(fixtures, 'odata-payload.json'), // @odata.context form carries NO version in its context
      version: '2.0',
      schemaValidate: true,
      generatedOn: '2026-01-01T00:00:00.000Z',
      runVariations: false,
    });
    expect(result.version).toBe('2.0'); // caller-supplied fallback stuck
    expect(result.stats.totalRecords).toBe(2);
    expect(result.stats.schemaErrors).toBeGreaterThanOrEqual(0); // it validated without throwing
  });

  it('schema-validates a non-DD resource without crashing on combine (empty error map has no stats)', async () => {
    const result = await runRcf({
      input: resolve(fixtures, 'unknown-resource.json'), // resource absent from the DD schema
      version: '2.0',
      schemaValidate: true,
      generatedOn: '2026-01-01T00:00:00.000Z',
      runVariations: false,
    });
    expect(result.stats.schemaErrors).toBeGreaterThanOrEqual(0); // combine defaulted stats instead of dereferencing undefined
  });

  // Data-loss guard: a variations failure must never discard the already-computed reports.
  it('degrades to reports-only on a non-auth service failure (e.g. /compute payload too large)', async () => {
    mockedCompute.mockRejectedValueOnce(serviceError('SERVICE_ERROR', 'Compressed request is 9 MB (limit ~6 MB).'));
    const result = await runRcf({
      input: resolve(fixtures, 'single-payload.json'),
      generatedOn: '2026-01-01T00:00:00.000Z',
      runVariations: true,
      bearerToken: 'test-token',
    });
    expect(result.variations).toBeUndefined();
    expect(result.variationsError).toMatch(/limit ~6 MB/);
    expect(result.metadataReport.fields.length).toBeGreaterThan(0); // report still produced
    expect(result.dataAvailabilityReport).toBeDefined();
  });

  it('rethrows on an auth failure so a real misconfig fails loud (reports are not the goal there)', async () => {
    mockedCompute.mockRejectedValueOnce(serviceError('AUTH_REJECTED', 'invalid client credentials'));
    await expect(
      runRcf({
        input: resolve(fixtures, 'single-payload.json'),
        generatedOn: '2026-01-01T00:00:00.000Z',
        runVariations: true,
        bearerToken: 'test-token',
      }),
    ).rejects.toThrow(/invalid client credentials/);
  });
});
