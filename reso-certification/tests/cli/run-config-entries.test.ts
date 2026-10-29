import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComplianceConfig, PipelineResult } from '../../src/sdk/types.js';

/**
 * A config entry whose run stops before producing a result is reported and counted, never dropped.
 *
 * Dropping it let a batch whose every run crashed (an output directory that could not be made, say)
 * exit 0, and the single-run path printed "Cannot read properties of undefined" instead of the cause.
 */

const sdk = vi.hoisted(() => ({ runComplianceTests: vi.fn() }));

vi.mock('../../src/sdk/index.js', () => sdk);

import { resultsOf, runConfigEntries, runWithProgress, stoppedOf } from '../../src/cli/render.js';

const config = (url: string): ComplianceConfig => ({
  endorsement: 'core',
  server: { url, auth: { mode: 'token', authToken: 'synthetic-token-0001' } },
  version: '2.1.0'
});

const passed: PipelineResult = {
  status: 'passed',
  endorsement: 'core',
  steps: [],
  context: {},
  duration: 1,
  certification: { valid: true }
};

const NOT_A_DIRECTORY = "ENOTDIR: not a directory, mkdir '/dev/null/x'";

describe('runConfigEntries', () => {
  const stderr: Array<string> = [];

  beforeEach(() => {
    sdk.runComplianceTests.mockReset();
    stderr.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: ReadonlyArray<unknown>) => {
      stderr.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps one outcome per entry, in entry order, with the error that stopped a run', async () => {
    sdk.runComplianceTests
      .mockRejectedValueOnce(new Error(NOT_A_DIRECTORY))
      .mockResolvedValueOnce(passed)
      .mockRejectedValueOnce(new Error('auth revoked'));

    const outcomes = await runConfigEntries(
      [
        { config: config('https://one.example.com'), label: 'Feed one' },
        { config: config('https://two.example.com'), label: 'Feed two' },
        { config: config('https://three.example.com'), label: 'Feed three' }
      ],
      'silent'
    );

    expect(outcomes).toEqual([
      { label: 'Feed one', error: NOT_A_DIRECTORY },
      { label: 'Feed two', result: passed },
      { label: 'Feed three', error: 'auth revoked' }
    ]);
    expect(resultsOf(outcomes)).toEqual([passed]);
    expect(stoppedOf(outcomes).map(s => s.label)).toEqual(['Feed one', 'Feed three']);
  });

  it('says on stderr which entries stopped and why, even when nothing else is printed', async () => {
    sdk.runComplianceTests.mockRejectedValue(new Error(NOT_A_DIRECTORY));

    await runConfigEntries([{ config: config('https://one.example.com'), label: 'Feed one' }], 'silent');

    expect(stderr).toEqual(['Stopped before producing a result (1 of 1):', `  ✗ Feed one: ${NOT_A_DIRECTORY}`]);
  });

  it('prints nothing about stopped entries when every run produced a result', async () => {
    sdk.runComplianceTests.mockResolvedValue(passed);

    const outcomes = await runConfigEntries([{ config: config('https://one.example.com'), label: 'Feed one' }], 'silent');

    expect(stoppedOf(outcomes)).toEqual([]);
    expect(stderr).toEqual([]);
  });
});

describe('runWithProgress', () => {
  beforeEach(() => {
    sdk.runComplianceTests.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rethrows the error that stopped the run, rather than failing on the missing result', async () => {
    sdk.runComplianceTests.mockRejectedValue(new Error(NOT_A_DIRECTORY));
    await expect(runWithProgress(config('https://one.example.com'), 'Web API Core 2.1.0', 'silent')).rejects.toThrow(NOT_A_DIRECTORY);
  });

  it('returns the result of a run that produced one, passing or not', async () => {
    const failed: PipelineResult = { ...passed, status: 'failed' };
    sdk.runComplianceTests.mockResolvedValue(failed);
    await expect(runWithProgress(config('https://one.example.com'), 'Web API Core 2.1.0', 'silent')).resolves.toEqual(failed);
  });
});
