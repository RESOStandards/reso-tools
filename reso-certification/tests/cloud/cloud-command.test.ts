import { describe, expect, it, vi } from 'vitest';
import {
  type CloudOfferIo,
  type CloudOfferMode,
  type RanEntry,
  cloudRunHint,
  formatAcceptedRun,
  formatRunStatusTable,
  offerCloudRun,
  planCloudRequests
} from '../../src/cli/cloud-command.js';
import type { AcceptedCloudRun } from '../../src/cloud/runs.js';
import type { CoreConfig, PipelineResult } from '../../src/sdk/types.js';

/**
 * The cloud-run choice at the end of a local run: only entries that passed and can be certified are offered,
 * nothing starts without `--start-cloud-run`, nothing waits for input, and the lines the CLI prints.
 *
 * Identities and credentials here are synthetic.
 */

const coreConfig = (recipientUoi: string, over: Partial<CoreConfig> = {}): CoreConfig => ({
  endorsement: 'core',
  server: { url: 'https://api.example.com/odata', auth: { mode: 'token', authToken: 'server-token-for-tests' } },
  version: '2.1.0',
  providerUoi: 'T00000000',
  providerUsi: '99999',
  recipientUoi,
  ...over
});

const passed: PipelineResult = {
  status: 'passed',
  endorsement: 'core',
  steps: [],
  context: {},
  duration: 1,
  certification: { valid: true }
};

const ran = (label: string, recipientUoi: string, result: PipelineResult | string, over: Partial<CoreConfig> = {}): RanEntry => ({
  label,
  config: coreConfig(recipientUoi, over),
  outcome: typeof result === 'string' ? { label, error: result } : { label, result }
});

const NOW = new Date('2026-10-29T20:00:00.000Z');

describe('planCloudRequests', () => {
  it('offers only the entries that passed and can be certified, and names the rest with why', () => {
    const plan = planCloudRequests(
      'T00000000',
      undefined,
      [
        ran('Feed one', 'M00000000', passed),
        ran('Feed two', 'M00000001', { ...passed, status: 'failed' }),
        ran('Feed three', 'M00000002', { ...passed, certification: { valid: false, reasons: ['a required step did not run'] } }),
        ran('Feed four', 'M00000003', 'ENOTDIR: not a directory'),
        ran('Feed five', 'M00000004', passed, { recipientUoi: undefined })
      ],
      NOW
    );

    expect(plan.offered).toBe(1);
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0].labels).toEqual(['Feed one']);
    expect(plan.requests[0].body.configs.map(c => c.recipientUoi)).toEqual(['M00000000']);
    expect(plan.requests[0].body.localRuns.map(r => r.recipientUoi)).toEqual(['M00000000']);
    expect(plan.notOffered).toEqual([
      { label: 'Feed two', reason: 'it failed' },
      { label: 'Feed three', reason: 'it cannot be certified: a required step did not run' },
      { label: 'Feed four', reason: 'it stopped before producing a result' },
      { label: 'Feed five', reason: 'it does not name the provider, system and recipient a cloud run is addressed to' }
    ]);
  });

  it('sends entries that ran at different versions as separate requests, with the concurrency on each', () => {
    const plan = planCloudRequests(
      'T00000000',
      100,
      [
        ran('Feed one', 'M00000000', passed),
        ran('Feed two', 'M00000001', passed, { version: '2.0.0' }),
        ran('Feed three', 'M00000002', passed)
      ],
      NOW
    );

    expect(plan.requests.map(r => [r.endorsementVersion, r.labels])).toEqual([
      ['2.1.0', ['Feed one', 'Feed three']],
      ['2.0.0', ['Feed two']]
    ]);
    expect(plan.requests.map(r => r.body.concurrency)).toEqual([100, 100]);
    expect(plan.requests.every(r => r.body.providerUoi === 'T00000000')).toBe(true);
  });

  it('sends the run as it ran: the credential and the options it used', () => {
    const plan = planCloudRequests(
      'T00000000',
      undefined,
      [ran('Feed one', 'M00000000', passed, { fieldOverrides: ['Office.FeedTypes'] })],
      NOW
    );
    expect(plan.requests[0].body.configs[0]).toMatchObject({
      token: 'server-token-for-tests',
      coreOptions: { version: '2.1.0', fieldOverrides: ['Office.FeedTypes'] }
    });
  });
});

describe('offerCloudRun', () => {
  const accepted = (version: string): AcceptedCloudRun => ({
    certificationRequestId: `test-T00000000-${version}`,
    providerUoi: 'T00000000',
    endorsementName: 'web-api-core',
    endorsementVersion: version,
    recipients: [{ recipientUoi: 'M00000000', providerUsi: '99999' }]
  });

  const io = () => {
    const said: Array<string> = [];
    const calls: CloudOfferIo = {
      say: text => {
        said.push(text);
      },
      submit: vi.fn(async request => accepted(request.endorsementVersion))
    };
    return { calls, said };
  };

  const mode = (over: Partial<CloudOfferMode> = {}): CloudOfferMode => ({ startCloudRun: false, json: false, ...over });

  const onePassed = planCloudRequests('T00000000', undefined, [ran('Feed one', 'M00000000', passed)], NOW);

  it('starts the run with --start-cloud-run', async () => {
    const { calls, said } = io();
    await expect(offerCloudRun(onePassed, mode({ startCloudRun: true }), calls)).resolves.toBe('started');
    expect(calls.submit).toHaveBeenCalledOnce();
    expect(said.join('\n')).toContain('Request: test-T00000000-2.1.0');
  });

  it('without --start-cloud-run, says how to choose it next time and starts nothing', async () => {
    const { calls, said } = io();
    await expect(offerCloudRun(onePassed, mode(), calls)).resolves.toBe('hinted');
    expect(calls.submit).not.toHaveBeenCalled();
    expect(said).toEqual([cloudRunHint(1)]);
  });

  it('offers nothing when no entry passed, and says so only when a start was asked for', async () => {
    const nonePassed = planCloudRequests('T00000000', undefined, [ran('Feed one', 'M00000000', { ...passed, status: 'failed' })], NOW);

    const quiet = io();
    await expect(offerCloudRun(nonePassed, mode(), quiet.calls)).resolves.toBe('none');
    expect(quiet.said).toEqual([]);

    const asked = io();
    await expect(offerCloudRun(nonePassed, mode({ startCloudRun: true }), asked.calls)).resolves.toBe('none');
    expect(asked.said[0]).toBe('No entry passed and can be certified, so no cloud run was started.');
    expect(asked.calls.submit).not.toHaveBeenCalled();
  });

  it('reports a refused request with its reason, still sends the others, and ends as failed', async () => {
    const twoVersions = planCloudRequests(
      'T00000000',
      undefined,
      [ran('Feed one', 'M00000000', passed), ran('Feed two', 'M00000001', passed, { version: '2.0.0' })],
      NOW
    );
    const { calls, said } = io();
    const refusing: CloudOfferIo = {
      ...calls,
      submit: vi.fn(async request => {
        if (request.endorsementVersion === '2.1.0') throw new Error('Certification runs cannot be started here yet.');
        return accepted(request.endorsementVersion);
      })
    };

    await expect(offerCloudRun(twoVersions, mode({ startCloudRun: true }), refusing)).resolves.toBe('failed');
    expect(refusing.submit).toHaveBeenCalledTimes(2);
    expect(said).toContain('Error: Certification runs cannot be started here yet.');
    expect(said.join('\n')).toContain('Request: test-T00000000-2.0.0');
  });

  it('prints what was started as JSON with --output json', async () => {
    const { calls, said } = io();
    await offerCloudRun(onePassed, mode({ startCloudRun: true, json: true }), calls);
    expect(JSON.parse(said[0])).toEqual(accepted('2.1.0'));
  });
});

describe('formatAcceptedRun', () => {
  it('names the run, its recipients and how to follow it', () => {
    const text = formatAcceptedRun(
      {
        certificationRequestId: 'test-T00000000-1700000000000',
        providerUoi: 'T00000000',
        endorsementName: 'web-api-core',
        endorsementVersion: '2.1.0',
        recipients: [
          { recipientUoi: 'M00000000', providerUsi: '99999' },
          { recipientUoi: 'M00000001', providerUsi: '' }
        ]
      },
      'Web API Core'
    );
    expect(text.split('\n')).toEqual([
      "Started Web API Core 2.1.0 in RESO's cloud for T00000000.",
      'Request: test-T00000000-1700000000000',
      'Recipients (2):',
      '  M00000000, system 99999',
      '  M00000001, system -',
      'Follow it with: reso-cert cloud status --in-progress'
    ]);
  });
});

describe('formatRunStatusTable', () => {
  const row = {
    certificationRequestId: 'test-T00000000-1700000000000',
    recipientConfigId: 'M00000000-99999',
    endorsementName: 'web-api-core',
    endorsementVersion: '2.1.0',
    statusTimestamp: '2026-10-29T12:00:00.123Z'
  };

  it('says so when there are no runs', () => {
    expect(formatRunStatusTable({ results: [], hasMore: false })).toBe('No cloud runs.');
  });

  it('shows one line per recipient, with the error first, then the step message, then the step', () => {
    const lines = formatRunStatusTable({
      results: [
        { ...row, status: 'error', error: 'Something went wrong with this run.', stepMessage: 'not shown', step: 'not shown' },
        { ...row, status: 'running', stepMessage: 'Checking paging', step: 'paging' },
        { ...row, status: 'running', step: 'metadata' },
        { ...row, status: 'passed', reportId: 'report-0001' }
      ],
      hasMore: false
    }).split('\n');

    expect(lines[0].split(/\s{2,}/)).toEqual(['request', 'recipient', 'endorsement', 'version', 'status', 'updated', 'report', 'detail']);
    expect(lines.slice(2).map(l => l.split(/\s{2,}/).slice(4))).toEqual([
      ['error', '2026-10-29T12:00:00', '-', 'Something went wrong with this run.'],
      ['running', '2026-10-29T12:00:00', '-', 'Checking paging'],
      ['running', '2026-10-29T12:00:00', '-', 'metadata'],
      ['passed', '2026-10-29T12:00:00', 'report-0001', '-']
    ]);
  });

  it('says when more runs match than are shown', () => {
    expect(formatRunStatusTable({ results: [{ ...row, status: 'running' }], hasMore: true })).toMatch(
      /\nMore runs match than are shown\. Narrow with --since\.$/
    );
  });
});
