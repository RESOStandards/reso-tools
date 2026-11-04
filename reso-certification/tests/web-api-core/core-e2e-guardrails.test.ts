import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCoreCompliance } from '../../src/sdk/core.js';
import type { CoreConfig } from '../../src/sdk/types.js';
import { INVALID_EDMX, type InstalledMock, installCoreMockServer } from '../helpers/core-mock-server.js';

/**
 * End-to-end guardrails for the Core run: a whole `runCoreCompliance` against a fetch-level mock
 * server, asserting the verdict AND the written report file. These lock the run-completion
 * correctness the adversarial review surfaced — a run that aborted or hit the deadline must never
 * write a clean-PASS report — so future cert changes can't silently reintroduce a false-PASS.
 */
const BASE = 'http://mock.local';

const makeConfig = (outputDir: string, over: Partial<CoreConfig> = {}): CoreConfig => ({
  endorsement: 'core',
  version: '2.0.0',
  resources: ['Property'], // the one resource the mock EDMX defines
  server: { url: BASE, auth: { mode: 'token', authToken: 'test' } },
  options: { outputDir },
  ...over
});

const readReportOutcome = async (outputPath: string): Promise<string> => {
  const detailed = JSON.parse(await readFile(join(outputPath, 'report-detailed.json'), 'utf-8'));
  return detailed.outcome;
};

describe('Core end-to-end guardrails (mock server + report-file assertions)', () => {
  let outputDir = '';
  let mock: InstalledMock | undefined;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'core-e2e-'));
  });
  afterEach(async () => {
    mock?.restore();
    await rm(outputDir, { recursive: true, force: true });
  });

  it('fatal-auth mid-run (sampling returns 401) → verdict AND report outcome are FAILED, not a false-PASS', async () => {
    mock = installCoreMockServer(BASE, { resourceStatus: 401 });

    const result = await runCoreCompliance(makeConfig(outputDir));

    expect(result.status).toBe('failed');
    expect(await readReportOutcome(result.context.outputPath)).toBe('failed');
  });

  it('invalid metadata → verdict AND report outcome are FAILED (a metadata failure is never passed)', async () => {
    // A run whose $metadata fails XSD/semantic validation must never write a 'passed' report.
    // (This exercises the failed-metadata-step outcome end to end; the specific priorStepFailed
    // guard — an upstream failure with zero test failures — is isolated in core-verdict.test.ts,
    // since empty-data sampling here makes some structural scenarios fail rather than skip.)
    mock = installCoreMockServer(BASE, { metadataXml: INVALID_EDMX });

    const result = await runCoreCompliance(makeConfig(outputDir));

    expect(result.status).toBe('failed');
    expect(await readReportOutcome(result.context.outputPath)).toBe('failed');
  });

  it('records whether full type coverage was achieved, with the types met and missed, in the detailed report', async () => {
    mock = installCoreMockServer(BASE);

    const result = await runCoreCompliance(makeConfig(outputDir));
    const detailed = JSON.parse(await readFile(join(result.context.outputPath, 'report-detailed.json'), 'utf-8'));
    const matrix = result.context.coverageMatrix as { coveredTypes: string[]; missingTypes: string[]; fullCoverage: boolean };

    expect(detailed.typeCoverage).toEqual({
      achieved: matrix.fullCoverage,
      coveredTypes: matrix.coveredTypes,
      missingTypes: matrix.missingTypes
    });
    expect([...detailed.typeCoverage.coveredTypes, ...detailed.typeCoverage.missingTypes].sort()).toEqual([
      'date',
      'decimal',
      'integer',
      'multiLookup',
      'singleLookup',
      'timestamp'
    ]);
    // report.json keeps the key set the Cert API takes; the coverage travels in the detailed report it keeps.
    const summary = JSON.parse(await readFile(join(result.context.outputPath, 'report.json'), 'utf-8'));
    expect(summary).not.toHaveProperty('typeCoverage');
  });

  it('writes the OData version, the authentication method and the parameters into report.json, never the token', async () => {
    mock = installCoreMockServer(BASE);
    // Stands for a credential, so a report that wrote one is caught by its value.
    const token = '<sentinel_token>';

    const result = await runCoreCompliance(makeConfig(outputDir, { server: { url: BASE, auth: { mode: 'token', authToken: token } } }));
    const written = await readFile(join(result.context.outputPath, 'report.json'), 'utf-8');
    const summary = JSON.parse(written);

    expect(summary.odataVersion).toBe('4.01');
    expect(summary.authentication).toEqual(['bearer token']);
    expect(summary.parameters.slice(0, 2)).toEqual([
      { name: 'Resource', value: 'Property' },
      { name: 'Key Field', value: 'ListingKey' }
    ]);
    expect(written).not.toContain(token);
  });

  it('run deadline spent → verdict AND report outcome are INCOMPLETE, and a partial report is still written', async () => {
    mock = installCoreMockServer(BASE);

    // A zero budget makes the deadline fire on the first sampled request — the run stops gracefully.
    const result = await runCoreCompliance(makeConfig(outputDir, { totalTimeoutMs: 0 }));

    expect(result.status).toBe('incomplete');
    expect(await readReportOutcome(result.context.outputPath)).toBe('incomplete');
  });
});
