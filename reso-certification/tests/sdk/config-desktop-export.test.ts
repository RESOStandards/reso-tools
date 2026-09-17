import { describe, it, expect } from 'vitest';
import { normalizeConfigFile, configEntryToCore, configEntryToDD, configEntryToAddEdit, configEntryToEntityEvent } from '../../src/sdk/config.js';

/**
 * A desktop-client v2 export runs through the CLI unmodified (reso-tools #299, "config compatibility").
 * The fixture is the EXACT shape `reso-web-client` writes (config-builder.tsx BatchConfig → RecipientConfig):
 * nested `auth` with `tokenUrl`, an `endorsements` list, and the four per-endorsement option blocks. Every
 * value a block carries that the SDK config types can express must reach the corresponding ComplianceConfig,
 * and OriginatingSystemName/ID must resolve per endorsement (the block wins, then the flat entry-level key).
 */
const desktopExport = (overrides: Record<string, unknown> = {}) => ({
  providerUoi: 'T00000050',
  concurrency: 1,
  recipients: [{
    id: '6b1c4d1e-0000-4000-8000-000000000001',
    description: 'Desktop export',
    serviceRootUri: 'https://api.example.com/odata',
    recipientUoi: 'M00000554',
    providerUsi: '50039',
    auth: { mode: 'client_credentials', clientId: 'cid', clientSecret: 'csec', tokenUrl: 'https://auth.example.com/token', scope: 'api' },
    endorsements: ['dd', 'core', 'add-edit', 'entity-event'],
    ddOptions: { version: '2.1', originatingSystemName: 'RIS', limit: 5000, strictMode: true, batchExpand: true, requestDelay: 250, rateLimitWait: 30000 },
    coreOptions: { version: '2.1.0', enumMode: 'collections', resources: 'Property, Member', fullCoverage: true },
    addEditOptions: { resource: 'Member', specVersion: '2.0.0', payloadsDir: './payloads' },
    entityEventOptions: { mode: 'full', writableResource: 'Property', maxEvents: 250, pollInterval: 2000, pollTimeout: 90000 },
    ...overrides,
  }],
});

const entryOf = (raw: Record<string, unknown>) => { const cf = normalizeConfigFile(raw); return { cf, entry: cf.configs[0] }; };

describe('desktop v2 export → CLI config, unmodified', () => {
  it('normalizes auth, versions and the flat keys (no hand edits needed)', () => {
    const { cf, entry } = entryOf(desktopExport());
    expect(cf.providerUoi).toBe('T00000050');
    expect(entry.clientCredentials).toEqual({ clientId: 'cid', clientSecret: 'csec', tokenUri: 'https://auth.example.com/token', scope: 'api' });
    expect(entry.description).toBe('Desktop export');
  });

  it('Core takes its version, enum mode, resources, coverage and OSN from coreOptions', () => {
    const { cf, entry } = entryOf(desktopExport({ coreOptions: { version: '2.1.0', enumMode: 'collections', resources: 'Property, Member', fullCoverage: true, originatingSystemName: 'CORE-OSN' } }));
    const core = configEntryToCore(entry, cf.providerUoi);
    expect(core.version).toBe('2.1.0');
    expect(core.enumMode).toBe('collections');
    expect(core.resources).toEqual(['Property', 'Member']);
    expect(core.fullCoverage).toBe(true);
    expect(core.originatingSystemName).toBe('CORE-OSN');
  });

  it('Core does NOT inherit the DD version when coreOptions carries its own', () => {
    const { cf, entry } = entryOf(desktopExport({ ddOptions: { version: '1.7' }, coreOptions: { version: '2.0.0' } }));
    expect(configEntryToCore(entry, cf.providerUoi).version).toBe('2.0.0');
    expect(configEntryToDD(entry, cf.providerUoi).version).toBe('1.7');
  });

  it('DD takes version, limit, strictMode, batchExpand, requestDelay, rateLimitWait and OSN from ddOptions', () => {
    const { cf, entry } = entryOf(desktopExport());
    const dd = configEntryToDD(entry, cf.providerUoi);
    expect(dd).toMatchObject({ version: '2.1', limit: 5000, strictMode: true, batchExpand: true, requestDelay: 250, rateLimitWait: 30000, originatingSystemName: 'RIS' });
  });

  it('Add/Edit takes resource, specVersion and payloadsDir from addEditOptions', () => {
    const { cf, entry } = entryOf(desktopExport());
    expect(configEntryToAddEdit(entry, cf.providerUoi)).toMatchObject({ resource: 'Member', specVersion: '2.0.0', payloadsDir: './payloads' });
  });

  it('EntityEvent takes mode, writableResource, maxEvents, pollInterval and pollTimeout from entityEventOptions', () => {
    const { cf, entry } = entryOf(desktopExport());
    expect(configEntryToEntityEvent(entry, cf.providerUoi)).toMatchObject({ mode: 'full', writableResource: 'Property', maxEvents: 250, pollInterval: 2000, pollTimeout: 90000 });
  });
});

describe('OriginatingSystemName / ID resolution per endorsement', () => {
  it('a block value wins over the flat entry-level key; the flat key is the fallback', () => {
    const { cf, entry } = entryOf(desktopExport({ originatingSystemName: 'FLAT', ddOptions: { version: '2.1', originatingSystemName: 'DD-OSN' }, coreOptions: { version: '2.1.0' } }));
    expect(configEntryToDD(entry, cf.providerUoi).originatingSystemName).toBe('DD-OSN');
    expect(configEntryToCore(entry, cf.providerUoi).originatingSystemName).toBe('FLAT');
  });

  it('with no flat key, a Core run falls back to the DD block (one recipient, one scope) and vice versa', () => {
    const { cf, entry } = entryOf(desktopExport({ ddOptions: { version: '2.1', originatingSystemName: 'RIS' }, coreOptions: { version: '2.1.0' } }));
    expect(configEntryToCore(entry, cf.providerUoi).originatingSystemName).toBe('RIS');
    const other = entryOf(desktopExport({ ddOptions: { version: '2.1' }, coreOptions: { version: '2.1.0', originatingSystemId: 'X1' } }));
    expect(configEntryToDD(other.entry, other.cf.providerUoi).originatingSystemId).toBe('X1');
  });

  it('the hand-modified shape from the field (flat configs + clientCredentials + OSN in both places) resolves identically', () => {
    const cf = normalizeConfigFile({
      providerUoi: 'T00000050', concurrency: 1,
      configs: [{
        id: 'x', serviceRootUri: 'https://api.example.com/odata', recipientUoi: 'M00000554', providerUsi: '50039', originatingSystemName: 'RIS',
        clientCredentials: { clientId: 'cid', clientSecret: 'csec', tokenUri: 'https://auth.example.com/token' },
        ddOptions: { version: '2.1' }, coreOptions: { version: '2.1.0', enumMode: 'auto', originatingSystemName: 'RIS' },
        addEditOptions: { resource: 'Property' }, entityEventOptions: { mode: 'observe' },
      }],
    });
    const e = cf.configs[0];
    expect(configEntryToCore(e, cf.providerUoi)).toMatchObject({ version: '2.1.0', enumMode: 'auto', originatingSystemName: 'RIS' });
    expect(configEntryToDD(e, cf.providerUoi)).toMatchObject({ version: '2.1', originatingSystemName: 'RIS' });
    expect(configEntryToAddEdit(e, cf.providerUoi).resource).toBe('Property');
    expect(configEntryToEntityEvent(e, cf.providerUoi).mode).toBe('observe');
  });
});

describe('legacy flat entries keep working exactly as before', () => {
  it('a legacy entry with only flat keys converts as it always did', () => {
    const cf = normalizeConfigFile({ providerUoi: 'P1', configs: [{ serviceRootUri: 'https://api.example.com', recipientUoi: 'R1', providerUsi: 'S1', token: 't', version: '2.0.0', resource: 'Office', mode: 'full', originatingSystemName: 'OSN' }] });
    const e = cf.configs[0];
    expect(configEntryToCore(e, 'P1')).toMatchObject({ version: '2.0.0', originatingSystemName: 'OSN' });
    expect(configEntryToCore(e, 'P1').enumMode).toBeUndefined();
    expect(configEntryToAddEdit(e, 'P1').resource).toBe('Office');
    expect(configEntryToEntityEvent(e, 'P1')).toMatchObject({ mode: 'full', writableResource: 'Office' });
    expect(configEntryToDD(e, 'P1').version).toBe('2.0');
  });
});
