import { describe, expect, it, vi } from 'vitest';
import {
  type CloudLocalRun,
  type StartCloudRunDeps,
  type StartCloudRunInput,
  reserveForLocalRun,
  startCloudRun
} from '../../src/cloud/start.js';
import { INFER_RCF_REPORTS, READ_RCF_INPUT } from '../../src/sdk/step-names.js';
import type { CoreConfig, PipelineResult, RcfConfig } from '../../src/sdk/types.js';

/**
 * The one path a cloud run starts through: every run checked before anything is sent, RESO Common Format files
 * packed, uploaded and cleaned up however it ends, one request per reservation. Identities and credentials here
 * are synthetic.
 */

const FINGERPRINT = 'f'.repeat(64);
const passed: PipelineResult = {
  status: 'passed',
  endorsement: 'core',
  steps: [],
  context: {},
  duration: 1,
  certification: { valid: true }
};

const coreConfig = (recipientUoi = 'M00000000', over: Partial<CoreConfig> = {}): CoreConfig => ({
  endorsement: 'core',
  server: { url: 'https://api.example.com/odata', auth: { mode: 'token', authToken: 'server-token-for-tests' } },
  version: '2.1.0',
  providerUoi: 'T00000000',
  providerUsi: '99999',
  recipientUoi,
  ...over
});
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
    { name: READ_RCF_INPUT, status: 'passed', duration: 1, params: { fingerprint: FINGERPRINT } },
    { name: INFER_RCF_REPORTS, status: 'passed', duration: 1, params: { version: '2.1' } }
  ]
};

const run = (over: Partial<CloudLocalRun> = {}): CloudLocalRun => ({
  config: coreConfig(),
  result: passed,
  certificationRequestId: 'test-T00000000-1',
  ...over
});

const deps = (over: Partial<StartCloudRunDeps> = {}) => {
  const order: string[] = [];
  const calls: StartCloudRunDeps = {
    submit: vi.fn(async input => {
      order.push('submit');
      return {
        certificationRequestId: String((input.config as { certificationRequestId: string }).certificationRequestId),
        providerUoi: 'T00000000',
        endorsementName: input.endorsementName,
        endorsementVersion: input.endorsementVersion,
        recipients: []
      };
    }),
    requestSlot: vi.fn(async () => {
      order.push('slot');
      return { uploadId: 'up-1', url: 'https://u', fields: {}, expiresAt: 'x', maxBytes: 4096 };
    }),
    upload: vi.fn(async () => {
      order.push('upload');
    }),
    pack: vi.fn(async (_input, zipPath, fingerprint) => {
      order.push('pack');
      return { packed: { path: zipPath, bytes: 2048, fingerprint, files: 3 } };
    }),
    makeTempDir: vi.fn(async () => {
      order.push('mkdtemp');
      return '/tmp/reso-rcf-upload-test';
    }),
    removeTempDir: vi.fn(async () => {
      order.push('rm');
    }),
    resolveCliToken: vi.fn(async () => 'cli-token-for-tests'),
    ...over
  };
  return { calls, order };
};

const core: StartCloudRunInput = {
  endorsementName: 'web-api-core',
  endorsementVersion: '2.1.0',
  providerUoi: 'T00000000',
  localRuns: [run()]
};

describe('startCloudRun', () => {
  it('submits the entries and records under the reservation, with the explicit bearer', async () => {
    const { calls } = deps();
    const accepted = await startCloudRun({ ...core, servicesAuthToken: 'session-token-for-tests', concurrency: 2 }, calls);
    expect(accepted.map(a => a.certificationRequestId)).toEqual(['test-T00000000-1']);
    const sent = vi.mocked(calls.submit).mock.calls[0]?.[0];
    expect(sent?.bearerToken).toBe('session-token-for-tests');
    expect(calls.resolveCliToken).not.toHaveBeenCalled();
    expect(sent?.config).toMatchObject({
      certificationRequestId: 'test-T00000000-1',
      providerUoi: 'T00000000',
      concurrency: 2,
      configs: [{ recipientUoi: 'M00000000', token: 'server-token-for-tests', coreOptions: { version: '2.1.0' } }],
      localRuns: [{ recipientUoi: 'M00000000', endorsementName: 'web-api-core', endorsementVersion: '2.1.0', outcome: 'passed' }]
    });
  });

  it("falls back to the CLI's own token when none is given", async () => {
    const { calls } = deps();
    await startCloudRun({ ...core, fromCli: true }, calls);
    expect(vi.mocked(calls.submit).mock.calls[0]?.[0]).toMatchObject({ bearerToken: 'cli-token-for-tests', fromCli: true });
  });

  it('sends one request per reservation, in the order given', async () => {
    const { calls } = deps();
    const accepted = await startCloudRun(
      {
        ...core,
        localRuns: [
          run(),
          run({ config: coreConfig('M00000001'), certificationRequestId: 'test-T00000000-2' }),
          run({ config: coreConfig('M00000002') })
        ]
      },
      calls
    );
    expect(accepted.map(a => a.certificationRequestId)).toEqual(['test-T00000000-1', 'test-T00000000-2']);
    const bodies = vi.mocked(calls.submit).mock.calls.map(c => c[0].config as { configs: ReadonlyArray<{ recipientUoi: string }> });
    expect(bodies.map(b => b.configs.map(e => e.recipientUoi))).toEqual([['M00000000', 'M00000002'], ['M00000001']]);
  });

  it('refuses before sending anything: no reservation, a run that did not pass, another endorsement, version or provider', async () => {
    const { calls } = deps();
    const refuses = async (input: StartCloudRunInput, pattern: RegExp) => {
      await expect(startCloudRun(input, calls)).rejects.toThrow(pattern);
    };
    await refuses({ ...core, localRuns: [] }, /No local run was given/);
    await refuses({ ...core, localRuns: [run({ certificationRequestId: ' ' })] }, /no reservation/);
    await refuses({ ...core, localRuns: [run({ result: { ...passed, status: 'failed' } })] }, /it failed/);
    await refuses(
      { ...core, localRuns: [run({ result: { ...passed, certification: { valid: false, reasons: ['x'] } } })] },
      /cannot be certified: x/
    );
    await refuses(
      { ...core, endorsementName: 'data-dictionary', endorsementVersion: '2.1' },
      /is a web-api-core run, and this start is for data-dictionary/
    );
    await refuses({ ...core, endorsementVersion: '2.0.0' }, /ran web-api-core 2.1.0, and this start is for 2.0.0/);
    await refuses({ ...core, providerUoi: 'T00000001' }, /not addressed from provider T00000001/);
    await refuses(
      { ...core, localRuns: [run({ config: coreConfig('M00000000', { recipientUoi: undefined }) })] },
      /provider, system and recipient/
    );
    expect(calls.submit).not.toHaveBeenCalled();
    expect(calls.requestSlot).not.toHaveBeenCalled();
  });

  it('refuses the whole start when one of several runs cannot go, and sends nothing', async () => {
    const { calls } = deps();
    await expect(
      startCloudRun(
        { ...core, localRuns: [run(), run({ config: coreConfig('M00000001'), result: { ...passed, status: 'incomplete' } })] },
        calls
      )
    ).rejects.toThrow(/M00000001, system 99999: it did not finish/);
    expect(calls.submit).not.toHaveBeenCalled();
  });

  describe('a RESO Common Format run', () => {
    const rcf: StartCloudRunInput = {
      endorsementName: 'reso-common-format',
      endorsementVersion: '2.1',
      providerUoi: 'T00000000',
      localRuns: [run({ config: rcfConfig, result: rcfRun })]
    };

    it('packs with the local fingerprint, asks for a slot, uploads, removes the folder, then submits the upload entry', async () => {
      const { calls, order } = deps();
      await startCloudRun({ ...rcf, servicesAuthToken: 'session-token-for-tests' }, calls);
      expect(order).toEqual(['mkdtemp', 'pack', 'slot', 'upload', 'rm', 'submit']);
      expect(vi.mocked(calls.pack).mock.calls[0]).toEqual(['/data/rcf', '/tmp/reso-rcf-upload-test/upload.zip', FINGERPRINT]);
      expect(vi.mocked(calls.requestSlot).mock.calls[0]?.[0]).toMatchObject({
        bearerToken: 'session-token-for-tests',
        certificationRequestId: 'test-T00000000-1',
        endorsementName: 'reso-common-format',
        endorsementVersion: '2.1',
        recipientUoi: 'M00000000',
        providerUsi: '99999',
        fingerprint: FINGERPRINT,
        bytes: 2048
      });
      expect(vi.mocked(calls.removeTempDir).mock.calls[0]?.[0]).toBe('/tmp/reso-rcf-upload-test');
      expect(vi.mocked(calls.submit).mock.calls[0]?.[0].config).toMatchObject({
        configs: [{ recipientUoi: 'M00000000', providerUsi: '99999', upload: { uploadId: 'up-1', fingerprint: FINGERPRINT } }],
        localRuns: [{ fingerprint: FINGERPRINT, endorsementName: 'reso-common-format', endorsementVersion: '2.1' }]
      });
    });

    it('removes the folder and submits nothing when the pack is refused or the upload fails', async () => {
      const refusedPack = deps({ pack: vi.fn(async () => ({ refused: 'The data packs to 6.0 GB, over the 5.0 GB a cloud run takes.' })) });
      await expect(startCloudRun(rcf, refusedPack.calls)).rejects.toThrow(/6.0 GB/);
      expect(refusedPack.calls.removeTempDir).toHaveBeenCalledTimes(1);
      expect(refusedPack.calls.requestSlot).not.toHaveBeenCalled();

      const failedUpload = deps({
        upload: vi.fn(async () => {
          throw new Error('Uploading the files failed: 403 Forbidden');
        })
      });
      await expect(startCloudRun(rcf, failedUpload.calls)).rejects.toThrow(/403 Forbidden/);
      expect(failedUpload.calls.removeTempDir).toHaveBeenCalledTimes(1);
      expect(failedUpload.calls.submit).not.toHaveBeenCalled();
    });
  });
});

describe('reserveForLocalRun', () => {
  it('reserves the target of a run that passed, with the server for a Core run and none for a RESO Common Format run', async () => {
    const reserve = vi.fn(async () => ({ certificationRequestId: 'test-T00000000-9', expiresAt: 'x', recipients: [] }));
    const resolveCliToken = vi.fn(async () => 'cli-token-for-tests');
    await reserveForLocalRun({ config: coreConfig(), result: passed, fromCli: true }, { reserve, resolveCliToken });
    expect(reserve.mock.calls[0]?.[0]).toEqual({
      fromCli: true,
      bearerToken: 'cli-token-for-tests',
      endorsementName: 'web-api-core',
      endorsementVersion: '2.1.0',
      providerUoi: 'T00000000',
      targets: [{ recipientUoi: 'M00000000', providerUsi: '99999', serviceRootUri: 'https://api.example.com/odata' }]
    });
    await reserveForLocalRun(
      { config: rcfConfig, result: rcfRun, servicesAuthToken: 'session-token-for-tests' },
      { reserve, resolveCliToken }
    );
    expect(reserve.mock.calls[1]?.[0]).toMatchObject({
      bearerToken: 'session-token-for-tests',
      endorsementName: 'reso-common-format',
      endorsementVersion: '2.1',
      targets: [{ recipientUoi: 'M00000000', providerUsi: '99999' }]
    });
  });

  it('reserves nothing for a run that did not pass or is not addressed', async () => {
    const reserve = vi.fn(async () => ({ certificationRequestId: 'x', expiresAt: 'x', recipients: [] }));
    await expect(reserveForLocalRun({ config: coreConfig(), result: { ...passed, status: 'failed' } }, { reserve })).rejects.toThrow(
      /it failed/
    );
    await expect(
      reserveForLocalRun({ config: coreConfig('M00000000', { providerUoi: undefined }), result: passed }, { reserve })
    ).rejects.toThrow(/provider, system and recipient/);
    expect(reserve).not.toHaveBeenCalled();
  });
});
