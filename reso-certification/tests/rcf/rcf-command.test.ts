import { describe, it, expect, vi, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { processRcfStream, runRcf, resolveRcfExitCode, type RcfResult } from '../../src/cli/rcf-command.js';
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
    const da = result.dataAvailabilityReport as { type: string; fields: ReadonlyArray<{ resourceName: string; fieldName: string }> };
    expect(da.type).toBe('data_availability'); // canonical RESO Data Availability Report shape
    expect(da.fields.some(f => f.resourceName === 'Property')).toBe(true);
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

  // #298: an RCF payload's context is required and validated. The @odata.context form carries no @reso.context,
  // so under RCF rules it is a schema ERROR (the context is the only model identifier an RCF payload has); a
  // well-formed @reso.context on the same records is clean. The severity here is the RCF column of the rule.
  it('an RCF payload without @reso.context (the @odata.context form) reports the REQUIRED context error', async () => {
    const result = await runRcf({
      input: resolve(fixtures, 'odata-payload.json'),
      version: '2.0',
      schemaValidate: true,
      generatedOn: '2026-01-01T00:00:00.000Z',
      runVariations: false,
    });
    expect(result.stats.schemaErrors).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result.schemaReport ?? result)).toMatch(/@reso\.context/);
  });

  it('an RCF payload with a well-formed, matching @reso.context reports no context finding', async () => {
    const result = await runRcf({
      input: resolve(fixtures, 'single-payload.json'), // urn:reso:metadata:2.0:resource:property
      version: '2.0',
      schemaValidate: true,
      generatedOn: '2026-01-01T00:00:00.000Z',
      runVariations: false,
    });
    expect(JSON.stringify(result.schemaReport ?? result)).not.toMatch(/@reso\.context" (value|version|resource)|MUST carry/);
  });

  it('a context naming a resource absent from the DD schema, in a non-lowercase form: no crash, and the malformed context is REPORTED (exit 1)', async () => {
    // The fixture's context is urn:reso:metadata:2.0:resource:NotADdResource — mixed case, so malformed under the
    // lowercase rule. Before the review this test asserted schemaErrors >= 0, which pinned the hole: the unknown
    // resource made validate() return the caller's empty accumulator and the MALFORMED error was lost.
    const result = await runRcf({
      input: resolve(fixtures, 'unknown-resource.json'),
      version: '2.0',
      schemaValidate: true,
      generatedOn: '2026-01-01T00:00:00.000Z',
      runVariations: false,
    });
    expect(result.stats.schemaErrors).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result.schemaReport)).toMatch(/@reso\.context/);
    expect(resolveRcfExitCode(result)).toBe(1);
  });

  const tempDirs: string[] = [];
  afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
  const tempDirWith = (files: Record<string, unknown>): string => {
    const dir = mkdtempSync(resolve(tmpdir(), 'rcf-review-'));
    tempDirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(resolve(dir, name), JSON.stringify(body));
    return dir;
  };
  const goodRecord = { ListingKey: 'P1', ListPrice: 100000 };

  it('a 1.7 context under --version 2.0 is a VERSION MISMATCH error (the declared run version is authoritative, never the context compared with itself)', async () => {
    const dir = tempDirWith({ 'a.json': { '@reso.context': 'urn:reso:metadata:1.7:resource:property', value: [goodRecord] } });
    const result = await runRcf({ input: dir, version: '2.0', schemaValidate: true, generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false });
    expect(result.stats.schemaErrors).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result.schemaReport)).toMatch(/version does not match/);
    expect(resolveRcfExitCode(result)).toBe(1);
  });

  it('a context naming a Data Dictionary version with no reference (3.0) fails loud with the version named, never a null dereference', async () => {
    const dir = tempDirWith({ 'a.json': { '@reso.context': 'urn:reso:metadata:3.0:resource:property', value: [goodRecord] } });
    await expect(runRcf({ input: dir, schemaValidate: true, generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false })).rejects.toThrow(/Unsupported Data Dictionary version "3\.0"/);
  });

  it('--version 2.0.0 (the Core form) is accepted as 2.0 on the rcf path', async () => {
    const dir = tempDirWith({ 'a.json': { '@reso.context': 'urn:reso:metadata:2.0:resource:property', value: [goodRecord] } });
    const result = await runRcf({ input: dir, version: '2.0.0', schemaValidate: true, generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false });
    expect(result.version).toBe('2.0');
    expect(result.stats.schemaErrors).toBe(0);
  });

  it('without --schema-validate an all-unreadable submission still exits non-zero and a mixed one counts only the certifiable records', async () => {
    // round 2: the round-1 ingestion fix counted invalid-context records as ingested even when no validator ran,
    // so an all-unreadable submission exited 0 with an empty report (before: exit 2), and a mixed directory's
    // record count disagreed with its availability report
    const allBad = tempDirWith({ 'bad.json': { '@reso.context': 'urn:reso:metadata:2.0', value: [goodRecord, goodRecord] } });
    const r1 = await runRcf({ input: allBad, version: '2.0', generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false });
    expect(r1.stats.totalRecords).toBe(0);
    expect(r1.stats.invalidContextFiles).toBe(1);
    expect(resolveRcfExitCode(r1)).not.toBe(0);

    const mixed = tempDirWith({
      'good.json': { '@reso.context': 'urn:reso:metadata:2.0:resource:property', value: [goodRecord] },
      'bad.json': { '@reso.context': 'urn:reso:metadata:2.0', value: [goodRecord, goodRecord] },
    });
    const r2 = await runRcf({ input: mixed, version: '2.0', generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false });
    expect(r2.stats.totalRecords).toBe(1); // only the certifiable records; the two invalid-context ones are their own stat
    expect(r2.stats.invalidContextFiles).toBe(1);
    expect(r2.stats.invalidContextRecords).toBe(2);
    expect(JSON.stringify(r2.dataAvailabilityReport)).not.toMatch(/_INVALID_/); // never inferred from
    expect(resolveRcfExitCode(r2)).toBe(2); // unreadable files in the submission with no validator to report them
  });

  it('a well-formed context naming a resource the DD does not define: exit 1 with the "not defined" error under --schema-validate, a schema failure under --strict', async () => {
    const dir = tempDirWith({ 'p.json': { '@reso.context': 'urn:reso:metadata:2.0:resource:propery', value: [goodRecord] } });
    const result = await runRcf({ input: dir, version: '2.0', schemaValidate: true, generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false });
    expect(result.stats.schemaErrors).toBe(1);
    expect(JSON.stringify(result.schemaReport)).toMatch(/propery.*is not defined in the schema/i);
    expect(resolveRcfExitCode(result)).toBe(1);
    await expect(runRcf({ input: dir, version: '2.0', schemaValidate: true, strict: true, generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false })).rejects.toMatchObject({ schemaFailure: true });
  });

  it('a lowercase multi-word resource in the context (the mandated form) is canonicalized to the DD resource name for inference and the reports', async () => {
    // round 2b: the lowercase rule plus a first-letter capitalize keyed OpenHouse records under "Openhouse", so
    // inference missed the reference map (every field local, no lookups) for 27 of the 41 DD 2.0 resources
    const openHouse = { OpenHouseKey: 'OH1', ListingKey: 'P1', OpenHouseDate: '2026-01-01', OpenHouseType: 'Public' };
    const dir = tempDirWith({ 'oh.json': { '@reso.context': 'urn:reso:metadata:2.0:resource:openhouse', value: [openHouse] } });
    const result = await runRcf({ input: dir, version: '2.0', schemaValidate: true, generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false });
    expect(result.stats.schemaErrors).toBe(0);
    expect(resolveRcfExitCode(result)).toBe(0);
    const report = result.metadataReport as { resources: ReadonlyArray<{ resourceName: string }>; fields: ReadonlyArray<{ resourceName: string; fieldName: string; type: string }>; lookups: ReadonlyArray<{ lookupName: string }> };
    expect(report.resources.map(r => r.resourceName)).toEqual(['OpenHouse']);
    const type = report.fields.find(f => f.resourceName === 'OpenHouse' && f.fieldName === 'OpenHouseType')?.type;
    expect(type).not.toBe('Edm.String'); // the DD enumeration, resolved through the reference map
    expect(report.lookups.length).toBeGreaterThan(0);
    const availability = result.dataAvailabilityReport as { fields: ReadonlyArray<{ resourceName: string }> };
    expect(new Set(availability.fields.map(f => f.resourceName))).toEqual(new Set(['OpenHouse']));
  });

  it('with no --version, the run version is peeked from the first payload that CARRIES one, not from an invalid-context file that sorts first', async () => {
    // round 2: peekVersion adopted undefined from the invalid-context payload, the run defaulted to 2.0 and every
    // clean 2.1 file got a spurious version mismatch
    const dir = tempDirWith({
      'a-bad.json': { '@reso.context': 'urn:reso:metadata:2.1', value: [goodRecord] },
      'b-good.json': { '@reso.context': 'urn:reso:metadata:2.1:resource:property', value: [goodRecord] },
    });
    const result = await runRcf({ input: dir, schemaValidate: true, generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false });
    expect(result.version).toBe('2.1');
    expect(JSON.stringify(result.schemaReport)).not.toMatch(/version does not match/);
  });

  it('a file whose @reso.context is present but unparseable is INGESTED and reported malformed, not silently dropped from a mixed directory', async () => {
    const dir = tempDirWith({
      'good.json': { '@reso.context': 'urn:reso:metadata:2.0:resource:property', value: [goodRecord] },
      'bad.json': { '@reso.context': 'urn:reso:metadata:2.0', value: [goodRecord, goodRecord] },
    });
    const result = await runRcf({ input: dir, version: '2.0', schemaValidate: true, generatedOn: '2026-01-01T00:00:00.000Z', runVariations: false });
    expect(result.stats.totalRecords).toBe(1); // the certifiable records; before: bad.json was dropped as "not an RCF payload" and the run certified on good.json alone
    expect(result.stats.invalidContextRecords).toBe(2);
    expect(result.stats.schemaErrors).toBe(1); // exactly one counted error for the one bad file (round 2b: it was two, the second keyed under "")
    expect(JSON.stringify(result.schemaReport)).toMatch(/MUST be urn:reso:metadata/); // the MALFORMED message, not merely REQUIRED
    const resourceKeys = Object.values((result.schemaReport as { errors: Record<string, { resources: Record<string, unknown> }> }).errors).flatMap(e => Object.keys(e.resources));
    expect(resourceKeys).not.toContain(''); // the finding is keyed under a named resource, never ""
    expect(resourceKeys).toEqual(['_INVALID_']);
    expect(resolveRcfExitCode(result)).toBe(1);
  });

  // Negative cert path with the REAL validator: a genuine DD violation must surface as schemaErrors
  // and drive a non-zero exit — proving real validation fails closed, not just the mock plumbing.
  it('a real DD violation yields schemaErrors > 0 and a non-zero (exit 1) result', async () => {
    const result = await runRcf({
      input: resolve(fixtures, 'dd-violation.json'), // ListPrice/BedroomsTotal carry non-numeric strings
      version: '2.0',
      schemaValidate: true,
      generatedOn: '2026-01-01T00:00:00.000Z',
      runVariations: false,
    });
    expect(result.stats.schemaErrors).toBeGreaterThan(0);
    expect(resolveRcfExitCode(result)).toBe(1);
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

describe('resolveRcfExitCode', () => {
  const stats = (over: Partial<RcfResult['stats']>): RcfResult['stats'] => ({
    totalRecords: 5,
    resources: 1,
    fields: 1,
    lookups: 0,
    schemaErrors: 0,
    invalidContextFiles: 0,
    invalidContextRecords: 0,
    ...over,
  });
  const result = (
    over: Partial<RcfResult['stats']>,
    variationsError?: string,
  ): Pick<RcfResult, 'stats' | 'variationsError'> => ({
    stats: stats(over),
    ...(variationsError ? { variationsError } : {}),
  });

  it('exits 2 when zero records were ingested — an empty/unreadable submission must not read as a clean pass', () => {
    expect(resolveRcfExitCode(result({ totalRecords: 0 }))).toBe(2);
  });

  it('zero records takes precedence over an otherwise-clean run', () => {
    expect(resolveRcfExitCode(result({ totalRecords: 0, schemaErrors: 0 }))).toBe(2);
  });

  it('exits 1 when there are schema errors', () => {
    expect(resolveRcfExitCode(result({ schemaErrors: 3 }))).toBe(1);
  });

  it('exits 2 when a requested variations pass degraded', () => {
    expect(resolveRcfExitCode(result({}, 'service unavailable'))).toBe(2);
  });

  it('exits 2 when the submission carried files with an unreadable @reso.context that no validator reported', () => {
    expect(resolveRcfExitCode(result({ invalidContextFiles: 1, invalidContextRecords: 3 }))).toBe(2);
  });

  it('schema errors take precedence over unreadable-context files (exit 1: they were reported)', () => {
    expect(resolveRcfExitCode(result({ schemaErrors: 2, invalidContextFiles: 1 }))).toBe(1);
  });

  it('exits 0 on a clean run with records and no errors', () => {
    expect(resolveRcfExitCode(result({}))).toBe(0);
  });
});
