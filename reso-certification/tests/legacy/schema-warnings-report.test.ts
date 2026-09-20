import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeSchemaValidationWarningsReport, writeSchemaValidationErrorReport, SCHEMA_VALIDATION_WARNINGS_FILENAME } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/replication/utils.js')
);

/**
 * #298 review: on a DD run the transport-path @reso.context findings are warnings until DD 3.0. The errors report
 * is written only when totalErrors > 0 (and in place of the analytics reports), so a run whose only findings were
 * warnings left no trace of them. The warnings file is written beside the analytics reports, only when there are
 * warnings and no errors, so the errors report keeps its meaning for every existing reader.
 */
const errorMapWith = (totalErrors: number, totalWarnings: number) => ({
  stats: { totalErrors, totalWarnings },
  errorCache: {},
  warningsCache: totalWarnings ? { Property: { '@reso.context': { 'The "@reso.context" version does not match the run version': { fileName: 'page-1' } } } } : {},
  payloadErrors: {},
});

const tempDirs: string[] = [];
const tempDir = (): string => { const d = mkdtempSync(resolve(tmpdir(), 'schema-warn-')); tempDirs.push(d); return d; };
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

describe('schema-validation warnings report (transport-path context findings on a DD run)', () => {
  it('warnings without errors → the warnings file is written beside the analytics reports, carrying the combined report', async () => {
    const outputPath = tempDir();
    const written = await writeSchemaValidationWarningsReport({ outputPath, errorMap: errorMapWith(0, 1) });
    expect(written).toBeTruthy();
    const file = resolve(outputPath, SCHEMA_VALIDATION_WARNINGS_FILENAME);
    expect(existsSync(file)).toBe(true);
    const report = JSON.parse(readFileSync(file, 'utf8'));
    expect(report.totalWarnings).toBe(1);
    expect(report.totalErrors).toBe(0);
    expect(JSON.stringify(report.warnings)).toMatch(/@reso\.context/);
  });

  it('an empty accumulator (no page was validated) → nothing written, nothing thrown, for either writer', async () => {
    const outputPath = tempDir();
    expect(await writeSchemaValidationWarningsReport({ outputPath, errorMap: {} })).toBeUndefined();
    expect(await writeSchemaValidationWarningsReport({ outputPath, errorMap: undefined })).toBeUndefined();
    await expect(writeSchemaValidationErrorReport({ outputPath, errorMap: {} })).resolves.toBeUndefined();
    expect(existsSync(resolve(outputPath, SCHEMA_VALIDATION_WARNINGS_FILENAME))).toBe(false);
  });

  it('no warnings → nothing is written; errors present → the errors report is the artifact, not this one', async () => {
    const outputPath = tempDir();
    expect(await writeSchemaValidationWarningsReport({ outputPath, errorMap: errorMapWith(0, 0) })).toBeUndefined();
    expect(await writeSchemaValidationWarningsReport({ outputPath, errorMap: errorMapWith(2, 1) })).toBeUndefined();
    expect(existsSync(resolve(outputPath, SCHEMA_VALIDATION_WARNINGS_FILENAME))).toBe(false);
    await writeSchemaValidationErrorReport({ outputPath, errorMap: errorMapWith(2, 1) });
    expect(existsSync(resolve(outputPath, 'data-availability-schema-validation-errors.json'))).toBe(true);
  });
});
