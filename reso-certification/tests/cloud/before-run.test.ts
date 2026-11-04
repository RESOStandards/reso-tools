import { describe, expect, it } from 'vitest';
import { whyNoCloudRunBeforeRun } from '../../src/cloud/local-run.js';
import type { AddEditConfig, CoreConfig, DDConfig, EntityEventConfig, RcfConfig } from '../../src/sdk/types.js';

/**
 * What `--start-cloud-run` refuses before a run, read from each configuration: an entry that could never start a
 * cloud run, because it is not addressed or asks for a run that cannot be certified or sent, is refused before a
 * long run is spent on it. What only the run can tell is left to the run. Identities and credentials here are
 * synthetic.
 */

const server = { url: 'https://api.example.com/odata', auth: { mode: 'token' as const, authToken: 'server-token-for-tests' } };
const identity = { providerUoi: 'T00000000', providerUsi: '99999', recipientUoi: 'M00000000' };

const core = (over: Partial<CoreConfig> = {}): CoreConfig => ({ endorsement: 'core', server, version: '2.1.0', ...identity, ...over });
const dd = (over: Partial<DDConfig> = {}): DDConfig => ({ endorsement: 'dd', server, version: '2.1', ...identity, ...over });
const addEdit = (over: Partial<AddEditConfig> = {}): AddEditConfig => ({
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
const entityEvent = (over: Partial<EntityEventConfig> = {}): EntityEventConfig => ({
  endorsement: 'entity-event',
  server,
  mode: 'full',
  writableResource: 'Property',
  ...identity,
  ...over
});
const rcf = (over: Partial<RcfConfig> = {}): RcfConfig => ({ endorsement: 'rcf', input: '/data/feed', ...identity, ...over });

describe('whyNoCloudRunBeforeRun', () => {
  it('lets every entry that may start a cloud run go on', () => {
    for (const config of [core(), dd(), addEdit(), addEdit({ payloads: undefined, payloadsDir: '/payloads' }), entityEvent(), rcf()]) {
      expect(whyNoCloudRunBeforeRun(config)).toBeUndefined();
    }
  });

  it('refuses an entry of any endorsement that is not addressed to a provider, system and recipient', () => {
    for (const config of [
      core({ recipientUoi: undefined }),
      dd({ providerUsi: '' }),
      addEdit({ providerUoi: undefined }),
      rcf({ recipientUoi: '' })
    ]) {
      expect(whyNoCloudRunBeforeRun(config)).toMatch(/provider, system and recipient/);
    }
  });

  it('refuses a Data Dictionary entry that is not strict or skips variations, as the run could not be certified', () => {
    expect(whyNoCloudRunBeforeRun(dd({ strictMode: false }))).toMatch(/cannot be certified.*strict/);
    expect(whyNoCloudRunBeforeRun(dd({ runVariations: false }))).toMatch(/cannot be certified.*variations/);
    expect(whyNoCloudRunBeforeRun(dd({ strictMode: true }))).toBeUndefined();
  });

  it('refuses a version RESO does not certify, for the endorsements that have one', () => {
    expect(whyNoCloudRunBeforeRun(dd({ version: '1.7' }))).toMatch(/cannot be certified/);
    // Core 2.0.0 is supported and runs as a retest: certification is on the latest 2.x.
    expect(whyNoCloudRunBeforeRun(core({ version: '2.0.0' }))).toMatch(/cannot be certified.*retest/);
    expect(whyNoCloudRunBeforeRun(addEdit({ specVersion: '1.0.0' }))).toMatch(/cannot be certified/);
  });

  it('refuses an Add/Edit entry the cloud could not run: auto payloads, no payloads or no resource', () => {
    expect(whyNoCloudRunBeforeRun(addEdit({ autoPayloads: true, payloads: undefined }))).toMatch(/payloads you give/);
    expect(whyNoCloudRunBeforeRun(addEdit({ payloads: undefined }))).toBe('it gives no payloads');
    expect(whyNoCloudRunBeforeRun(addEdit({ resource: '' }))).toMatch(/resource/);
  });

  it('refuses an EntityEvent entry that only observes, or writes from a payloads folder', () => {
    expect(whyNoCloudRunBeforeRun(entityEvent({ mode: 'observe' }))).toMatch(/cannot be certified.*observe/);
    expect(whyNoCloudRunBeforeRun(entityEvent({ mode: undefined }))).toMatch(/cannot be certified.*observe/);
    expect(whyNoCloudRunBeforeRun(entityEvent({ payloadsDir: '/canaries' }))).toMatch(/folder/);
  });

  it('refuses a RESO Common Format entry that skips schema validation or variations', () => {
    expect(whyNoCloudRunBeforeRun(rcf({ schemaValidate: false }))).toMatch(/cannot be certified.*schema/);
    expect(whyNoCloudRunBeforeRun(rcf({ runVariations: false }))).toMatch(/cannot be certified.*variations/);
    expect(whyNoCloudRunBeforeRun(rcf({ schemaValidate: true, runVariations: true }))).toBeUndefined();
  });

  it('names every reason at once, so the file is fixed once', () => {
    const why = whyNoCloudRunBeforeRun(dd({ strictMode: false, runVariations: false }));
    expect(why).toMatch(/strict/);
    expect(why).toMatch(/variations/);
  });
});
