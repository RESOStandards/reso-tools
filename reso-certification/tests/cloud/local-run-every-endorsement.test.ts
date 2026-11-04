import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTITY_EVENT_VERSION, cloudEndorsementOf, cloudEntryOf, cloudVersionOf, localRunRecordOf } from '../../src/cloud/local-run.js';
import { INFER_RCF_REPORTS, READ_RCF_INPUT } from '../../src/sdk/step-names.js';
import type { AddEditConfig, DDConfig, EntityEventConfig, PipelineResult, RcfConfig } from '../../src/sdk/types.js';

/**
 * The cloud entry and the local-run record of a Data Dictionary, Add/Edit, EntityEvent and RESO Common Format run,
 * in the shape the service reads for each. Identities and credentials here are synthetic.
 */

const server = { url: 'https://api.example.com/odata', auth: { mode: 'token' as const, authToken: 'server-token-for-tests' } };
const identity = { providerUoi: 'T00000000', providerUsi: '99999', recipientUoi: 'M00000000' };

const passed: PipelineResult = { status: 'passed', endorsement: 'dd', steps: [], context: {}, duration: 1, certification: { valid: true } };
const NOW = new Date('2026-11-03T20:00:00.000Z');

const ddConfig = (over: Partial<DDConfig> = {}): DDConfig => ({ endorsement: 'dd', server, version: '2.1', ...identity, ...over });
const addEditConfig = (over: Partial<AddEditConfig> = {}): AddEditConfig => ({
  endorsement: 'add-edit',
  server,
  resource: 'Property',
  specVersion: '2.0.0',
  actions: ['create'],
  formats: { create: ['minimal'] },
  payloads: { createSucceeds: { ListPrice: 1 }, createFails: {} },
  ...identity,
  ...over
});
const entityEventConfig = (over: Partial<EntityEventConfig> = {}): EntityEventConfig => ({
  endorsement: 'entity-event',
  server,
  mode: 'full',
  writableResource: 'Property',
  maxEvents: 500,
  batchSize: 100,
  ...identity,
  ...over
});

const entryOf = async (config: DDConfig | AddEditConfig | EntityEventConfig | RcfConfig, result = passed, options = {}) => {
  const built = await cloudEntryOf(config, result, options);
  if ('refused' in built) throw new Error(built.refused);
  return built.entry;
};
const refusalOf = async (config: DDConfig | AddEditConfig | EntityEventConfig | RcfConfig, result = passed, options = {}) => {
  const built = await cloudEntryOf(config, result, options);
  return 'refused' in built ? built.refused : undefined;
};

describe('cloudEndorsementOf and cloudVersionOf', () => {
  it('name each endorsement as the request route does, with the version the run certified', () => {
    expect([cloudEndorsementOf(ddConfig()), cloudVersionOf(ddConfig(), passed)]).toEqual(['data-dictionary', '2.1']);
    expect([cloudEndorsementOf(addEditConfig()), cloudVersionOf(addEditConfig(), passed)]).toEqual(['add-edit', '2.0.0']);
    expect([cloudEndorsementOf(entityEventConfig()), cloudVersionOf(entityEventConfig(), passed)]).toEqual([
      'entity-event',
      ENTITY_EVENT_VERSION
    ]);
  });

  it('fills in no Add/Edit version', () => {
    expect(cloudVersionOf(addEditConfig({ specVersion: undefined }), passed)).toBeUndefined();
  });
});

describe('cloudEntryOf for a Data Dictionary run', () => {
  it('carries the server, the credential, the scope and the ddOptions the run used', async () => {
    await expect(
      entryOf(ddConfig({ limit: 500, strictMode: true, batchExpand: true, requestDelay: 0, originatingSystemName: 'OSN' }), passed, {
        description: 'Feed'
      })
    ).resolves.toEqual({
      description: 'Feed',
      serviceRootUri: 'https://api.example.com/odata',
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      token: 'server-token-for-tests',
      originatingSystemName: 'OSN',
      ddOptions: { version: '2.1', limit: 500, strictMode: true, batchExpand: true, requestDelay: 0 }
    });
  });

  it('carries the strict mode as it was set, so the service sees a run that turned it off', async () => {
    const entry = await entryOf(ddConfig({ strictMode: false }));
    expect('ddOptions' in entry ? entry.ddOptions : undefined).toEqual({ version: '2.1', strictMode: false });
  });

  it('refuses a run that is not addressed', async () => {
    await expect(refusalOf(ddConfig({ providerUsi: undefined }))).resolves.toMatch(/provider, system and recipient/);
  });
});

describe('cloudEntryOf for an Add/Edit run', () => {
  it('inlines the configuration payloads with the resource, version, actions and formats', async () => {
    await expect(entryOf(addEditConfig())).resolves.toEqual({
      serviceRootUri: 'https://api.example.com/odata',
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      token: 'server-token-for-tests',
      payloads: { createSucceeds: { ListPrice: 1 }, createFails: {} },
      addEditOptions: { specVersion: '2.0.0', resource: 'Property', actions: ['create'], formats: { create: ['minimal'] } }
    });
  });

  describe('with a payloads folder', () => {
    const dir: { path?: string } = {};
    beforeAll(async () => {
      dir.path = await mkdtemp(join(tmpdir(), 'reso-add-edit-payloads-'));
      await writeFile(join(dir.path, 'create-succeeds.json'), JSON.stringify({ ListPrice: 2 }));
      await writeFile(join(dir.path, 'create-fails.json'), JSON.stringify({ ListPrice: 'no' }));
    });
    afterAll(async () => {
      if (dir.path) await rm(dir.path, { recursive: true, force: true });
    });

    const plan = { actions: ['create'], formats: { create: ['minimal'], update: [] }, scenarios: ['create-minimal', 'create-fails'] };

    it('inlines the files the run read, as its plan names them', async () => {
      const entry = await entryOf(addEditConfig({ payloads: undefined, payloadsDir: dir.path }), { ...passed, context: { plan } });
      expect('payloads' in entry ? entry.payloads : undefined).toEqual({
        createSucceeds: { ListPrice: 2 },
        createFails: { ListPrice: 'no' }
      });
    });

    it('refuses when the run did not record which files it read, rather than guessing', async () => {
      await expect(refusalOf(addEditConfig({ payloads: undefined, payloadsDir: dir.path }), passed)).resolves.toMatch(/did not record/);
    });

    it('refuses when a file it read is gone, naming it', async () => {
      await expect(
        refusalOf(addEditConfig({ payloads: undefined, payloadsDir: dir.path }), {
          ...passed,
          context: { plan: { ...plan, actions: ['delete'] } }
        })
      ).resolves.toMatch(/delete-succeeds\.json/);
    });
  });

  it('refuses auto payloads, no payloads and a missing version or resource', async () => {
    await expect(refusalOf(addEditConfig({ autoPayloads: true }))).resolves.toMatch(/payloads you give/);
    await expect(refusalOf(addEditConfig({ payloads: undefined }))).resolves.toBe('it gives no payloads');
    await expect(refusalOf(addEditConfig({ specVersion: '' }))).resolves.toMatch(/version/);
    await expect(refusalOf(addEditConfig({ resource: '' }))).resolves.toMatch(/resource/);
  });
});

describe('cloudEntryOf for an EntityEvent run', () => {
  it('carries the mode, the canary resource and the waits the run used, and not the fetch size', async () => {
    await expect(entryOf(entityEventConfig({ pollTimeout: 60000 }))).resolves.toEqual({
      serviceRootUri: 'https://api.example.com/odata',
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      token: 'server-token-for-tests',
      entityEventOptions: { mode: 'full', writableResource: 'Property', maxEvents: 500, pollTimeout: 60000 }
    });
  });

  it('refuses a full-mode run that read its canary payloads from a folder', async () => {
    await expect(refusalOf(entityEventConfig({ payloadsDir: '/payloads' }))).resolves.toMatch(/folder/);
    await expect(refusalOf(entityEventConfig({ mode: 'observe', payloadsDir: '/payloads' }))).resolves.toBeUndefined();
  });
});

describe('cloudEntryOf for a RESO Common Format run', () => {
  const rcfConfig: RcfConfig = { endorsement: 'rcf', input: '/data/rcf', ...identity };
  const rcfRun: PipelineResult = {
    ...passed,
    endorsement: 'rcf',
    steps: [
      { name: READ_RCF_INPUT, status: 'passed', duration: 1, params: { fingerprint: 'f'.repeat(64) } },
      { name: INFER_RCF_REPORTS, status: 'passed', duration: 1, params: { version: '2.1' } }
    ]
  };

  it('names the upload and the fingerprint in place of a server', async () => {
    await expect(entryOf(rcfConfig, rcfRun, { upload: { uploadId: 'up-1' } })).resolves.toEqual({
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      upload: { uploadId: 'up-1', fingerprint: 'f'.repeat(64) }
    });
  });

  it('refuses before the files are uploaded', async () => {
    await expect(refusalOf(rcfConfig, rcfRun)).resolves.toMatch(/not been uploaded/);
  });
});

describe('localRunRecordOf for every endorsement', () => {
  it('records a Data Dictionary, Add/Edit and EntityEvent run with its endorsement and version', () => {
    expect(localRunRecordOf(passed, ddConfig(), NOW)).toMatchObject({
      endorsementName: 'data-dictionary',
      endorsementVersion: '2.1',
      outcome: 'passed'
    });
    expect(localRunRecordOf(passed, addEditConfig(), NOW)).toMatchObject({ endorsementName: 'add-edit', endorsementVersion: '2.0.0' });
    expect(localRunRecordOf(passed, entityEventConfig(), NOW)).toMatchObject({
      endorsementName: 'entity-event',
      endorsementVersion: '1.0.0'
    });
  });

  it('is nothing for an Add/Edit run that did not say its version', () => {
    expect(localRunRecordOf(passed, addEditConfig({ specVersion: undefined }), NOW)).toBeUndefined();
  });
});
