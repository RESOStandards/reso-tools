import { describe, expect, it, vi } from 'vitest';
import {
  type CloudOfferIo,
  type CloudOfferMode,
  type RanEntry,
  cloudRunHint,
  cloudRunPrerequisite,
  entriesRefusedBeforeRun,
  formatAcceptedRun,
  formatRunStatusTable,
  offerCloudRuns,
  planCloudRuns
} from '../../src/cli/cloud-command.js';
import type { AcceptedCloudRun } from '../../src/cloud/runs.js';
import { INFER_RCF_REPORTS, READ_RCF_INPUT } from '../../src/sdk/step-names.js';
import type { CoreConfig, PipelineResult, RcfConfig } from '../../src/sdk/types.js';

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

describe('planCloudRuns', () => {
  it('offers only the entries that passed and can be certified, and names the rest with why', () => {
    const plan = planCloudRuns(
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
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].entries.map(e => e.label)).toEqual(['Feed one']);
    expect(plan.groups[0].entries.map(e => e.record.recipientUoi)).toEqual(['M00000000']);
    expect(plan.notOffered).toEqual([
      { label: 'Feed two', reason: 'it failed' },
      { label: 'Feed three', reason: 'it cannot be certified: a required step did not run' },
      { label: 'Feed four', reason: 'it stopped before producing a result' },
      {
        label: 'Feed five',
        reason: 'it does not name the provider, system and recipient a cloud run is addressed to, or did not record what it certified'
      }
    ]);
  });

  it('groups entries that ran at different versions as separate requests', () => {
    const plan = planCloudRuns(
      [
        ran('Feed one', 'M00000000', passed),
        ran('Feed two', 'M00000001', passed, { version: '2.0.0' }),
        ran('Feed three', 'M00000002', passed)
      ],
      NOW
    );

    expect(plan.groups.map(g => [g.endorsementName, g.endorsementVersion, g.entries.map(e => e.label)])).toEqual([
      ['web-api-core', '2.1.0', ['Feed one', 'Feed three']],
      ['web-api-core', '2.0.0', ['Feed two']]
    ]);
  });

  it('plans any endorsement: a RESO Common Format run goes by the version its run inferred', () => {
    const rcfConfig: RcfConfig = {
      endorsement: 'rcf',
      input: '/data/rcf',
      providerUoi: 'T00000000',
      providerUsi: '99999',
      recipientUoi: 'M00000000'
    };
    const rcfRun: PipelineResult = {
      ...passed,
      endorsement: 'rcf',
      steps: [
        { name: READ_RCF_INPUT, status: 'passed', duration: 1, params: { fingerprint: 'f'.repeat(64) } },
        { name: INFER_RCF_REPORTS, status: 'passed', duration: 1, params: { version: '2.1' } }
      ]
    };
    const plan = planCloudRuns([{ label: 'rcf', config: rcfConfig, outcome: { label: 'rcf', result: rcfRun } }], NOW);
    expect(plan.groups.map(g => [g.endorsementName, g.endorsementVersion])).toEqual([['reso-common-format', '2.1']]);
  });
});

describe('offerCloudRuns', () => {
  const accepted = (version: string): AcceptedCloudRun => ({
    certificationRequestId: `test-T00000000-${version}`,
    providerUoi: 'T00000000',
    endorsementName: 'web-api-core',
    endorsementVersion: version,
    recipients: [{ recipientUoi: 'M00000000', providerUsi: '99999' }]
  });

  const offer = { providerUoi: 'T00000000', endorsementLabel: 'Web API Core' };

  const io = () => {
    const said: Array<string> = [];
    const order: Array<string> = [];
    const calls: CloudOfferIo = {
      say: text => {
        said.push(text);
      },
      reserve: vi.fn(async request => {
        order.push(`reserve ${request.endorsementVersion}`);
        return {
          certificationRequestId: `test-T00000000-reserved-${request.endorsementVersion}`,
          reservedAt: '2026-10-29T20:00:00.000Z',
          expiresAt: '2026-10-30T20:00:00.000Z',
          recipients: []
        };
      }),
      start: vi.fn(async input => {
        order.push(`start ${input.endorsementVersion}`);
        return [accepted(input.endorsementVersion)];
      })
    };
    return { calls, said, order };
  };

  const mode = (over: Partial<CloudOfferMode> = {}): CloudOfferMode => ({ startCloudRun: false, json: false, ...over });

  const onePassed = planCloudRuns([ran('Feed one', 'M00000000', passed)], NOW);

  it('with --start-cloud-run, reserves the entries that passed and starts from that reservation, through the shared path', async () => {
    const { calls, said, order } = io();
    await expect(offerCloudRuns({ ...offer, concurrency: 4 }, onePassed, mode({ startCloudRun: true }), calls)).resolves.toBe('started');
    expect(order).toEqual(['reserve 2.1.0', 'start 2.1.0']);
    expect(vi.mocked(calls.reserve).mock.calls[0]?.[0].targets).toEqual([
      { recipientUoi: 'M00000000', providerUsi: '99999', serviceRootUri: 'https://api.example.com/odata' }
    ]);
    const started = vi.mocked(calls.start).mock.calls[0]?.[0];
    expect(started?.concurrency).toBe(4);
    expect(started?.localRuns.map(r => [r.description, r.certificationRequestId])).toEqual([['Feed one', 'test-T00000000-reserved-2.1.0']]);
    expect(said.join('\n')).toContain('Request: test-T00000000-2.1.0');
  });

  it('starts nothing for a group whose reservation was refused, and still sends the others', async () => {
    const twoVersions = planCloudRuns(
      [ran('Feed one', 'M00000000', passed), ran('Feed two', 'M00000001', passed, { version: '2.0.0' })],
      NOW
    );
    const { calls, said } = io();
    const refusing: CloudOfferIo = {
      ...calls,
      reserve: vi.fn(async request => {
        if (request.endorsementVersion === '2.1.0') throw new Error('Reserving the web-api-core 2.1.0 run was refused: not allowed.');
        return {
          certificationRequestId: 'test-T00000000-reserved-2.0.0',
          reservedAt: '2026-10-29T20:00:00.000Z',
          expiresAt: '2026-10-30T20:00:00.000Z',
          recipients: []
        };
      })
    };

    await expect(offerCloudRuns(offer, twoVersions, mode({ startCloudRun: true }), refusing)).resolves.toBe('failed');
    expect(vi.mocked(refusing.start).mock.calls.map(c => c[0].endorsementVersion)).toEqual(['2.0.0']);
    expect(said).toContain('Error: Reserving the web-api-core 2.1.0 run was refused: not allowed.');
  });

  it('without --start-cloud-run, says how to choose it next time and reserves and starts nothing', async () => {
    const { calls, said } = io();
    await expect(offerCloudRuns(offer, onePassed, mode(), calls)).resolves.toBe('hinted');
    expect(calls.reserve).not.toHaveBeenCalled();
    expect(calls.start).not.toHaveBeenCalled();
    expect(said).toEqual([cloudRunHint(1)]);
  });

  it('offers nothing when no entry passed, and says so only when a start was asked for', async () => {
    const nonePassed = planCloudRuns([ran('Feed one', 'M00000000', { ...passed, status: 'failed' })], NOW);

    const quiet = io();
    await expect(offerCloudRuns(offer, nonePassed, mode(), quiet.calls)).resolves.toBe('none');
    expect(quiet.said).toEqual([]);

    const asked = io();
    await expect(offerCloudRuns(offer, nonePassed, mode({ startCloudRun: true }), asked.calls)).resolves.toBe('none');
    expect(asked.said[0]).toBe('No entry passed and can be certified, so no cloud run was started.');
    expect(asked.calls.reserve).not.toHaveBeenCalled();
    expect(asked.calls.start).not.toHaveBeenCalled();
  });

  it('reports a refused start with its reason, still sends the others, and ends as failed', async () => {
    const twoVersions = planCloudRuns(
      [ran('Feed one', 'M00000000', passed), ran('Feed two', 'M00000001', passed, { version: '2.0.0' })],
      NOW
    );
    const { calls, said } = io();
    const refusing: CloudOfferIo = {
      ...calls,
      start: vi.fn(async input => {
        if (input.endorsementVersion === '2.1.0') throw new Error('Certification runs cannot be started here yet.');
        return [accepted(input.endorsementVersion)];
      })
    };

    await expect(offerCloudRuns(offer, twoVersions, mode({ startCloudRun: true }), refusing)).resolves.toBe('failed');
    expect(refusing.start).toHaveBeenCalledTimes(2);
    expect(said).toContain('Error: Certification runs cannot be started here yet.');
    expect(said.join('\n')).toContain('Request: test-T00000000-2.0.0');
  });

  it('prints what was started as JSON with --output json', async () => {
    const { calls, said } = io();
    await offerCloudRuns(offer, onePassed, mode({ startCloudRun: true, json: true }), calls);
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

describe('cloudRunPrerequisite', () => {
  const services = { RESO_SERVICES_URL: 'https://services.example.org' };

  it('is met by the service address and either set of credentials', () => {
    expect(
      cloudRunPrerequisite({ ...services, TOKEN_URI: 'https://auth.example.org', CLIENT_ID: 'id', CLIENT_SECRET: 'secret' })
    ).toBeUndefined();
    expect(
      cloudRunPrerequisite({
        ...services,
        CERT_AUTH_API_BASE_URL: 'https://cert.example.org',
        CERT_AUTH_API_USERNAME: 'u',
        CERTIFICATION_API_KEY: 'k'
      })
    ).toBeUndefined();
  });

  it('names what is missing, and never a value', () => {
    const reason = cloudRunPrerequisite({ TOKEN_URI: 'https://auth.example.org', CLIENT_ID: 'id', CLIENT_SECRET: 'secret-for-tests' });
    expect(reason).toContain('RESO_SERVICES_URL');
    expect(reason).not.toContain('secret-for-tests');
    expect(cloudRunPrerequisite({ ...services, TOKEN_URI: 'https://auth.example.org', CLIENT_ID: 'id' })).toContain('CLIENT_SECRET');
    expect(cloudRunPrerequisite({ ...services, CLIENT_SECRET: ' ' })).toBeDefined();
  });
});

describe('entriesRefusedBeforeRun', () => {
  const entries = [
    { label: 'Feed one', config: coreConfig('M00000000') },
    { label: 'Feed two', config: coreConfig('M00000001', { recipientUoi: undefined }) },
    { label: 'Feed three', config: coreConfig('M00000002', { version: '2.0.0' }) }
  ];

  it('is nothing when every entry may start a cloud run', () => {
    expect(entriesRefusedBeforeRun([entries[0]])).toBeUndefined();
  });

  it('names every entry that could never start one, with why, and names no credential', () => {
    const refusal = entriesRefusedBeforeRun(entries);
    expect(refusal).toContain('--start-cloud-run');
    expect(refusal).toContain('Feed two: it does not name the provider, system and recipient');
    expect(refusal).toMatch(/Feed three: it cannot be certified/);
    expect(refusal).not.toContain('Feed one');
    expect(refusal).not.toContain('server-token-for-tests');
  });
});
