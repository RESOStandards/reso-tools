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

type AnyConfig = DDConfig | AddEditConfig | EntityEventConfig | RcfConfig;

/** A passing result of the configuration's own endorsement, with what the run recorded. */
const ran = (config: AnyConfig, context: PipelineResult['context'] = {}): PipelineResult => ({
  ...passed,
  endorsement: config.endorsement,
  context
});

const entryOf = async (config: AnyConfig, result = ran(config), options = {}) => {
  const built = await cloudEntryOf(config, result, options);
  if ('refused' in built) throw new Error(built.refused);
  return built.entry;
};
const refusalOf = async (config: AnyConfig, result = ran(config), options = {}) => {
  const built = await cloudEntryOf(config, result, options);
  return 'refused' in built ? built.refused : undefined;
};

describe('cloudEndorsementOf and cloudVersionOf', () => {
  it('name each endorsement as the request route does, with the version the run certified', () => {
    expect([cloudEndorsementOf(ddConfig()), cloudVersionOf(ddConfig(), ran(ddConfig()))]).toEqual(['data-dictionary', '2.1']);
    expect([cloudEndorsementOf(addEditConfig()), cloudVersionOf(addEditConfig(), ran(addEditConfig()))]).toEqual(['add-edit', '2.0.0']);
    expect([cloudEndorsementOf(entityEventConfig()), cloudVersionOf(entityEventConfig(), ran(entityEventConfig()))]).toEqual([
      'entity-event',
      ENTITY_EVENT_VERSION
    ]);
  });

  it('reads the Add/Edit version the run recorded when the configuration omitted it, as the pipeline resolved it', () => {
    const config = addEditConfig({ specVersion: undefined });
    expect(cloudVersionOf(config, ran(config, { specVersion: '2.0.0' }))).toBe('2.0.0');
  });

  it('fills in no Add/Edit version when neither the run nor the configuration says', () => {
    const config = addEditConfig({ specVersion: undefined });
    expect(cloudVersionOf(config, ran(config))).toBeUndefined();
  });
});

describe('cloudEntryOf and localRunRecordOf with a result of another endorsement', () => {
  const coreResult: PipelineResult = { ...passed, endorsement: 'core' };

  it('refuses the entry, naming both, rather than building one for the configuration', async () => {
    await expect(refusalOf(ddConfig(), coreResult)).resolves.toMatch(/result of a core run.*configuration (is )?for dd/);
    await expect(refusalOf(addEditConfig(), coreResult)).resolves.toMatch(/core run/);
    await expect(refusalOf(entityEventConfig(), coreResult)).resolves.toMatch(/core run/);
  });

  it('records nothing', () => {
    expect(localRunRecordOf(coreResult, ddConfig(), NOW)).toBeUndefined();
    expect(localRunRecordOf(coreResult, addEditConfig(), NOW)).toBeUndefined();
    expect(localRunRecordOf(coreResult, entityEventConfig(), NOW)).toBeUndefined();
  });
});

describe('cloudEntryOf for a Data Dictionary run', () => {
  it('carries the server, the credential, the scope and the ddOptions the run used', async () => {
    await expect(
      entryOf(ddConfig({ strictMode: true, batchExpand: true, requestDelay: 0, originatingSystemName: 'OSN' }), undefined, {
        description: 'Feed'
      })
    ).resolves.toEqual({
      description: 'Feed',
      serviceRootUri: 'https://api.example.com/odata',
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      token: 'server-token-for-tests',
      originatingSystemName: 'OSN',
      ddOptions: { version: '2.1', strictMode: true, batchExpand: true, requestDelay: 0 }
    });
  });

  // The sample limit is for local testing: the run measured part of the feed, so it certifies nothing, and none
  // of the public tools sends one. Refused here in words, so no entry with a limit is built, let alone sent.
  it('refuses a run that set a sample limit, in words, so no entry with one is sent', async () => {
    const why = await refusalOf(ddConfig({ limit: 500 }));
    expect(why).toMatch(/cannot be certified.*sample limit of 500 records per resource/);
    expect(why).toMatch(/local testing/);
    expect(why).toMatch(/Remove the limit/);
  });

  // A limit at or above the default is a larger sample, which certifies. The entry carries it, so the cloud run
  // samples what the local run did rather than falling back to the default.
  it('carries a sample limit at or above the default into the entry', async () => {
    const entry = await entryOf(ddConfig({ limit: 250000 }));
    expect('ddOptions' in entry ? entry.ddOptions : undefined).toEqual({ version: '2.1', limit: 250000 });
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

  it('carries the version the run recorded when the configuration omitted it', async () => {
    const config = addEditConfig({ specVersion: undefined });
    const entry = await entryOf(config, ran(config, { specVersion: '2.0.0' }));
    expect('addEditOptions' in entry ? entry.addEditOptions.specVersion : undefined).toBe('2.0.0');
  });

  it('carries the payloads the run recorded over the configuration inline ones, since the recorded ones are what ran', async () => {
    const recorded = { createSucceeds: { ListPrice: 5 }, createFails: {} };
    const entry = await entryOf(addEditConfig(), ran(addEditConfig(), { payloads: recorded }));
    expect('payloads' in entry ? entry.payloads : undefined).toEqual(recorded);
  });

  it('carries only the payloads the plan used: a create-only entry with a stray deleteFails sends createSucceeds and createFails', async () => {
    // A form with six payload boxes can leave a stray empty one. The local run checks only the plan's payloads, so it
    // passes; the service checks every name it is sent. The entry carries the plan's set, as a folder run records it.
    const stray = { createSucceeds: { ListPrice: 1 }, createFails: {}, deleteFails: {} };
    const planned = { createSucceeds: { ListPrice: 1 }, createFails: {} };
    const payloadsOf = (entry: Awaited<ReturnType<typeof entryOf>>) => ('payloads' in entry ? entry.payloads : undefined);
    expect(payloadsOf(await entryOf(addEditConfig({ payloads: stray })))).toEqual(planned);
    expect(payloadsOf(await entryOf(addEditConfig(), ran(addEditConfig(), { payloads: stray })))).toEqual(planned);
    expect(payloadsOf(await entryOf(addEditConfig(), undefined, { payloads: stray }))).toEqual(planned);
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
    const folderConfig = () => addEditConfig({ payloads: undefined, payloadsDir: dir.path });

    it('inlines the files the run recorded reading, and not the folder as it is at submit time', async () => {
      const recorded = { createSucceeds: { ListPrice: 2 }, createFails: { ListPrice: 'no' } };
      const result = ran(folderConfig(), { plan, payloads: recorded });
      const atThePass = await entryOf(folderConfig(), result);
      expect('payloads' in atThePass ? atThePass.payloads : undefined).toEqual(recorded);
      // The folder changes after the local pass. The entry still carries what ran.
      await writeFile(join(dir.path ?? '', 'create-succeeds.json'), JSON.stringify({ ListPrice: 999999, Edited: 'after the pass' }));
      const atSubmit = await entryOf(folderConfig(), result);
      expect('payloads' in atSubmit ? atSubmit.payloads : undefined).toEqual(recorded);
    });

    it('sends the payloads captured when the run ran, given, for a result that did not record them', async () => {
      const captured = { createSucceeds: { ListPrice: 3 }, createFails: { ListPrice: 'still no' } };
      const config = addEditConfig({ payloads: undefined, payloadsDir: '/no/such/folder' });
      const entry = await entryOf(config, ran(config, { plan }), { payloads: captured });
      expect('payloads' in entry ? entry.payloads : undefined).toEqual(captured);
    });

    it('sends what the run recorded over captured payloads, since the record is what the pipeline read', async () => {
      const recorded = { createSucceeds: { ListPrice: 2 }, createFails: {} };
      const entry = await entryOf(folderConfig(), ran(folderConfig(), { plan, payloads: recorded }), {
        payloads: { createSucceeds: { ListPrice: 3 }, createFails: {} }
      });
      expect('payloads' in entry ? entry.payloads : undefined).toEqual(recorded);
    });

    it("sends the captured payloads over the configuration's inline ones, since the captured ones are what ran", async () => {
      const captured = { createSucceeds: { ListPrice: 4 }, createFails: {} };
      const entry = await entryOf(addEditConfig(), undefined, { payloads: captured });
      expect('payloads' in entry ? entry.payloads : undefined).toEqual(captured);
    });

    it('still refuses auto payloads when payloads were captured or recorded', async () => {
      const config = addEditConfig({ autoPayloads: true, payloads: undefined });
      await expect(refusalOf(config, undefined, { payloads: { createSucceeds: {} } })).resolves.toMatch(/payloads you give/);
      await expect(refusalOf(config, ran(config, { payloads: { createSucceeds: {} } }))).resolves.toMatch(/payloads you give/);
    });

    it('refuses a folder run that did not record the payloads it read, with the files still there, rather than reading them again', async () => {
      await expect(refusalOf(folderConfig(), ran(folderConfig(), { plan }))).resolves.toMatch(/did not record the payloads/);
    });

    it('refuses a record that is not payloads', async () => {
      await expect(refusalOf(folderConfig(), ran(folderConfig(), { plan, payloads: 'later' }))).resolves.toMatch(
        /did not record the payloads/
      );
      await expect(refusalOf(folderConfig(), ran(folderConfig(), { plan, payloads: { createSucceeds: 1 } }))).resolves.toMatch(
        /did not record the payloads/
      );
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

  it('reads the mode and the canary resource the run recorded when the configuration omitted them', async () => {
    const config = entityEventConfig({ mode: undefined, writableResource: undefined, maxEvents: undefined });
    const entry = await entryOf(config, ran(config, { mode: 'observe', writableResource: 'Property' }));
    expect('entityEventOptions' in entry ? entry.entityEventOptions : undefined).toEqual({ mode: 'observe', writableResource: 'Property' });
  });

  it('refuses a run whose mode neither the run nor the configuration says', async () => {
    await expect(refusalOf(entityEventConfig({ mode: undefined }))).resolves.toMatch(/observed or wrote/);
    await expect(refusalOf(entityEventConfig({ writableResource: undefined }))).resolves.toMatch(/canaries/);
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
    expect(localRunRecordOf(ran(ddConfig()), ddConfig(), NOW)).toMatchObject({
      endorsementName: 'data-dictionary',
      endorsementVersion: '2.1',
      outcome: 'passed'
    });
    expect(localRunRecordOf(ran(addEditConfig()), addEditConfig(), NOW)).toMatchObject({
      endorsementName: 'add-edit',
      endorsementVersion: '2.0.0'
    });
    expect(localRunRecordOf(ran(entityEventConfig()), entityEventConfig(), NOW)).toMatchObject({
      endorsementName: 'entity-event',
      endorsementVersion: '1.0.0'
    });
  });

  it('is nothing for an Add/Edit run that did not say its version', () => {
    const config = addEditConfig({ specVersion: undefined });
    expect(localRunRecordOf(ran(config), config, NOW)).toBeUndefined();
  });

  it('records the version an Add/Edit run recorded when the configuration omitted it', () => {
    const config = addEditConfig({ specVersion: undefined });
    expect(localRunRecordOf(ran(config, { specVersion: '2.0.0' }), config, NOW)).toMatchObject({ endorsementVersion: '2.0.0' });
  });
});
