import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintRcfInput } from '../../src/rcf/fingerprint.js';
import { serviceError } from '../../src/sdk/common.js';
import { runRcfCompliance } from '../../src/sdk/rcf.js';
import type { RcfConfig } from '../../src/sdk/types.js';
import { computeVariationsViaService } from '../../src/variations/index.js';

/**
 * RESO Common Format through the SDK, as the cloud job will run it and as the `rcf` command runs it: the files are
 * fingerprinted, the reports inferred and written beside `report.json`, and the run certifies only when it checked
 * every record against the Data Dictionary and ran variations.
 */

// Only the service call is replaced; the real error classification still runs.
vi.mock('../../src/variations/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/variations/index.js')>();
  return { ...actual, computeVariationsViaService: vi.fn() };
});
const mockedCompute = vi.mocked(computeVariationsViaService);

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rcf');
const SINGLE = resolve(fixtures, 'single-payload.json');

const ONE_VARIATION = {
  description: 'Data Dictionary Variations Report',
  version: '2.0',
  fuzziness: 0.25,
  variations: {
    fields: [{ level: 'field', resourceName: 'Property', fieldName: 'Cty', suggestions: [{ suggestedFieldName: 'City' }] }]
  },
  deprecations: []
};

beforeEach(() => {
  mockedCompute.mockReset();
  mockedCompute.mockResolvedValue(ONE_VARIATION as never);
});

const run = async (over: Partial<RcfConfig> = {}) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'rcf-sdk-'));
  const result = await runRcfCompliance({
    endorsement: 'rcf',
    input: SINGLE,
    schemaValidate: true,
    servicesAuthToken: 'test-token',
    options: { outputDir },
    ...over
  });
  const files = (await readdir(outputDir)).sort();
  const read = async (name: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(outputDir, name), 'utf-8'));
  return { result, outputDir, files, read };
};

const stepNamed = (result: Awaited<ReturnType<typeof run>>['result'], name: string) => result.steps.find(step => step.name === name);

describe('an RCF run through the SDK', () => {
  it('certifies a clean run that schema-validated and ran variations, and writes every report', async () => {
    const { result, files, read } = await run();

    expect(result.status).toBe('passed');
    expect(result.certification).toEqual({ valid: true });
    expect(files).toEqual([
      'data-availability-report.json',
      'data-dictionary-variations.json',
      'metadata-report.json',
      'report-detailed.json',
      'report.json'
    ]);
    const report = await read('report.json');
    expect(report).toMatchObject({ description: 'RESO Common Format', version: '2.0', outcome: 'passed' });
    expect(report).not.toHaveProperty('certification');
    expect(report.remarks).toBe('2 records in 1 file(s): 1 resources, 3 fields, 2 lookups. 0 schema error(s). 1 variation(s).');
  });

  it('names its steps as reports read them', async () => {
    const { result } = await run();
    expect(result.steps.map(step => step.name)).toEqual(['Read RCF input', 'Infer RCF reports', 'Write reports']);
  });

  it('records the fingerprint of the files it read, in the detailed report', async () => {
    const { read } = await run();
    const detailed = (await read('report-detailed.json')) as { steps: ReadonlyArray<{ name: string; params?: Record<string, unknown> }> };
    const readStep = detailed.steps.find(step => step.name === 'Read RCF input');
    expect(readStep?.params?.fingerprint).toBe((await fingerprintRcfInput(SINGLE)).sha256);
  });

  it('does not certify a run that did not schema-validate', async () => {
    const { result, read } = await run({ schemaValidate: false });
    expect(result.status).toBe('passed');
    expect(result.certification).toEqual({
      valid: false,
      reasons: ['Schema validation did not run, so no record was checked against the Data Dictionary']
    });
    const report = await read('report.json');
    expect(report.certification).toEqual(result.certification);
    expect(report.remarks).toContain('Schema validation did not run.');
  });

  it('does not certify a run that skipped variations, and never calls the service', async () => {
    const { result, files } = await run({ runVariations: false });
    expect(result.certification).toEqual({
      valid: false,
      reasons: ['Variations did not run, so no name was checked against the Data Dictionary']
    });
    expect(mockedCompute).not.toHaveBeenCalled();
    expect(files).not.toContain('data-dictionary-variations.json');
  });

  it('fails a run whose variations did not complete, and still writes the inferred reports', async () => {
    mockedCompute.mockRejectedValueOnce(serviceError('SERVICE_ERROR', 'Compressed request is 9 MB (limit ~6 MB).'));
    const { result, files, read } = await run();
    expect(result.status).toBe('failed');
    expect(result.certification.valid).toBe(false);
    expect(stepNamed(result, 'Infer RCF reports')?.errors).toEqual([
      'Variations did not complete: Compressed request is 9 MB (limit ~6 MB).'
    ]);
    expect(files).toContain('metadata-report.json');
    expect(files).toContain('data-availability-report.json');
    expect((await read('report.json')).outcome).toBe('failed');
  });

  it('writes the report to submit for review when it has an identity and variations', async () => {
    const { files, read } = await run({ providerUoi: 'T00000000', providerUsi: '50000', recipientUoi: 'M00000123' });
    expect(files).toContain('variations-report.json');
    expect(await read('variations-report.json')).toMatchObject({
      providerUoi: 'T00000000',
      providerUsi: '50000',
      recipientUoi: 'M00000123'
    });
  });

  it('refuses a partial identity before it infers anything, and says why in its report', async () => {
    const { result, files, read } = await run({ providerUoi: 'T00000000' });
    expect(result.status).toBe('failed');
    expect(stepNamed(result, 'Read RCF input')?.status).toBe('failed');
    expect(stepNamed(result, 'Infer RCF reports')?.status).toBe('skipped');
    expect(mockedCompute).not.toHaveBeenCalled();
    expect(files).toEqual(['report-detailed.json', 'report.json']);
    expect(String((await read('report.json')).remarks)).toMatch(/^No report was inferred\. .*go together/);
  });

  it('fails an input rcf cannot read, and says so', async () => {
    const { result, read } = await run({ input: resolve(fixtures, 'notes.txt') });
    expect(result.status).toBe('failed');
    expect(String((await read('report.json')).remarks)).toContain('Unsupported RCF input');
  });

  it('fails a run with no certifiable records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcf-empty-'));
    await writeFile(join(dir, 'notrcf.json'), JSON.stringify({ hello: 'world' }));
    const { result } = await run({ input: dir });
    expect(result.status).toBe('failed');
    expect(stepNamed(result, 'Infer RCF reports')?.errors).toContain('No certifiable records were read');
  });

  it('fails a run on a Data Dictionary version with no reference, naming it', async () => {
    const { result, read } = await run({ version: '3.0' });
    expect(result.status).toBe('failed');
    expect(String((await read('report.json')).remarks)).toContain('Unsupported Data Dictionary version "3.0"');
  });
});
