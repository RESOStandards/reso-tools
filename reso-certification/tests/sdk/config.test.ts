import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { CURRENT_DD_VERSION } from '../../src/sdk/dd-versions.js';
import {
  loadConfigFile,
  normalizeConfigFile,
  generateLocalUoi,
  configEntryToAddEdit,
  configEntryToEntityEvent,
  configEntryToCore,
  configEntryToDD,
  resolvePayloadKeys,
} from '../../src/sdk/config.js';

describe('normalizeConfigFile — accept legacy / desktop / single shapes', () => {
  it('passes the legacy { providerUoi, configs } format through', () => {
    const cf = normalizeConfigFile({
      providerUoi: 'P001',
      configs: [{ serviceRootUri: 'https://api.example.com', recipientUoi: 'R1', providerUsi: 'S1', token: 't', version: '2.1.0' }],
    });
    expect(cf.providerUoi).toBe('P001');
    expect(cf.configs).toHaveLength(1);
    expect(cf.configs[0].token).toBe('t');
    expect(cf.configs[0].version).toBe('2.1.0');
  });

  it('normalizes the desktop { providerUoi, recipients } format with nested token auth (OSN carried through)', () => {
    const cf = normalizeConfigFile({
      providerUoi: 'P001',
      recipients: [{
        serviceRootUri: 'https://api.example.com', recipientUoi: 'R1', providerUsi: 'S1',
        auth: { mode: 'token', authToken: 'abc' },
        originatingSystemName: 'MyMLS',
        ddOptions: { version: '2.1.0' },
      }],
    });
    expect(cf.configs).toHaveLength(1);
    expect(cf.configs[0].token).toBe('abc');
    expect(cf.configs[0].originatingSystemName).toBe('MyMLS');
    expect(cf.configs[0].version).toBe('2.1.0'); // from ddOptions.version
  });

  it('maps nested client_credentials auth, tokenUrl → tokenUri', () => {
    const cf = normalizeConfigFile({
      providerUoi: 'P001',
      recipients: [{
        serviceRootUri: 'https://api.example.com', recipientUoi: 'R1', providerUsi: 'S1',
        auth: { mode: 'client_credentials', clientId: 'id', clientSecret: 'secret', tokenUrl: 'https://auth/token', scope: 'sc' },
      }],
    });
    expect(cf.configs[0].clientCredentials).toEqual({ clientId: 'id', clientSecret: 'secret', tokenUri: 'https://auth/token', scope: 'sc' });
    expect(cf.configs[0].token).toBeUndefined();
  });

  it('accepts a single-entry config and supplies a placeholder providerUoi', () => {
    const cf = normalizeConfigFile({ serviceRootUri: 'https://api.example.com', recipientUoi: 'R1', providerUsi: 'S1', auth: { mode: 'token', authToken: 't' } });
    expect(cf.providerUoi).toMatch(/^LOCAL-/);
    expect(cf.configs).toHaveLength(1);
    expect(cf.configs[0].token).toBe('t');
  });

  it('throws on an unrecognized shape', () => {
    expect(() => normalizeConfigFile({ foo: 'bar' })).toThrow(/no entries/);
  });

  it('rejects a serviceRootUri that is not a valid absolute http(s) URL (catch-all)', () => {
    // A desktop placeholder the CLI does not resolve — the exact case that crashed mid-metadata before.
    expect(() => normalizeConfigFile({ providerUoi: 'P001', configs: [{ serviceRootUri: 'LOCAL_SERVER', recipientUoi: 'R1', providerUsi: 'S1', token: 't' }] }))
      .toThrow(/serviceRootUri "LOCAL_SERVER" is not a valid URL/);
    // A missing scheme is caught too.
    expect(() => normalizeConfigFile({ serviceRootUri: 'api.example.com', recipientUoi: 'R1', providerUsi: 'S1', auth: { mode: 'token', authToken: 't' } }))
      .toThrow(/not a valid URL/);
    // A real absolute URL passes.
    expect(() => normalizeConfigFile({ providerUoi: 'P001', configs: [{ serviceRootUri: 'https://api.example.com', recipientUoi: 'R1', providerUsi: 'S1', token: 't' }] }))
      .not.toThrow();
  });
});

describe('loadConfigFile', () => {
  const sampleConfigPath = resolve(import.meta.dirname, '../../sample-configs/add-edit-config.json');

  it('loads and parses a valid config file', async () => {
    const config = await loadConfigFile(sampleConfigPath);

    expect(config.providerUoi).toBe('LOCAL-PROVIDER');
    expect(config.configs).toHaveLength(1);
    expect(config.configs[0].serviceRootUri).toBe('http://localhost:8080');
  });

  it('throws on missing file', async () => {
    await expect(loadConfigFile('/nonexistent.json')).rejects.toThrow();
  });
});

describe('generateLocalUoi', () => {
  it('generates a string starting with LOCAL-', () => {
    const uoi = generateLocalUoi();
    expect(uoi).toMatch(/^LOCAL-\d+$/);
  });

  it('generates values with timestamp component', () => {
    const uoi = generateLocalUoi();
    const timestamp = Number(uoi.replace('LOCAL-', ''));
    expect(timestamp).toBeGreaterThan(0);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });
});

describe('configEntryToAddEdit', () => {
  const entry = {
    serviceRootUri: 'https://api.example.com',
    recipientUoi: 'R001',
    providerUsi: 'S001',
    token: 'test-token',
    resource: 'Property',
  };

  it('converts to AddEditConfig with bearer auth', () => {
    const config = configEntryToAddEdit(entry, 'P001');

    expect(config.endorsement).toBe('add-edit');
    expect(config.server.url).toBe('https://api.example.com');
    expect(config.server.auth).toEqual({ mode: 'token', authToken: 'test-token' });
    expect(config.resource).toBe('Property');
  });

  it('converts client credentials auth', () => {
    const ccEntry = {
      ...entry,
      token: undefined,
      clientCredentials: {
        clientId: 'id',
        clientSecret: 'secret',
        tokenUri: 'https://auth.example.com/token',
      },
    };

    const config = configEntryToAddEdit(ccEntry, 'P001');

    expect(config.server.auth).toEqual({
      mode: 'client_credentials',
      clientId: 'id',
      clientSecret: 'secret',
      tokenUrl: 'https://auth.example.com/token',
    });
  });

  it('sets output dir from provider/recipient/usi', () => {
    const config = configEntryToAddEdit(entry, 'P001');
    expect(config.options?.outputDir).toContain('P001');
    expect(config.options?.outputDir).toContain('R001-S001');
  });

  it('defaults resource to Property', () => {
    const noResource = { ...entry, resource: undefined };
    const config = configEntryToAddEdit(noResource, 'P001');
    expect(config.resource).toBe('Property');
  });
});

describe('configEntryToEntityEvent', () => {
  const entry = {
    serviceRootUri: 'https://api.example.com',
    recipientUoi: 'R001',
    providerUsi: 'S001',
    token: 'test-token',
  };

  it('converts with default observe mode', () => {
    const config = configEntryToEntityEvent(entry, 'P001');

    expect(config.endorsement).toBe('entity-event');
    expect(config.mode).toBe('observe');
    expect(config.writableResource).toBe('Property');
  });

  it('respects full mode', () => {
    const fullEntry = { ...entry, mode: 'full' as const };
    const config = configEntryToEntityEvent(fullEntry, 'P001');
    expect(config.mode).toBe('full');
  });
});

describe('configEntryToCore', () => {
  it('converts with default version', () => {
    const config = configEntryToCore({
      serviceRootUri: 'https://api.example.com',
      recipientUoi: 'R001',
      providerUsi: 'S001',
      token: 'test-token',
    }, 'P001');

    expect(config.endorsement).toBe('core');
    expect(config.version).toBe('2.0.0');
  });

  it('threads OriginatingSystemName/ID from the entry (reso-certification-utils format)', () => {
    const config = configEntryToCore({
      serviceRootUri: 'https://api.example.com',
      recipientUoi: 'R001',
      providerUsi: 'S001',
      token: 'test-token',
      originatingSystemName: 'MyMLS',
      originatingSystemId: 'MLS-42',
    }, 'P001');

    expect(config.originatingSystemName).toBe('MyMLS');
    expect(config.originatingSystemId).toBe('MLS-42');
  });

  it('omits OriginatingSystem fields when the entry carries none', () => {
    const config = configEntryToCore({
      serviceRootUri: 'https://api.example.com',
      recipientUoi: 'R001',
      providerUsi: 'S001',
      token: 'test-token',
    }, 'P001');

    expect(config.originatingSystemName).toBeUndefined();
    expect(config.originatingSystemId).toBeUndefined();
  });
});

describe('configEntryToDD', () => {
  it('converts with default version (the current DD version)', () => {
    const config = configEntryToDD({
      serviceRootUri: 'https://api.example.com',
      recipientUoi: 'R001',
      providerUsi: 'S001',
      token: 'test-token',
    }, 'P001');

    expect(config.endorsement).toBe('dd');
    // An entry with no version coerces to the current DD version.
    expect(config.version).toBe(CURRENT_DD_VERSION);
  });

  it('threads OriginatingSystemName/ID from the entry into the DD replication config', () => {
    const config = configEntryToDD({
      serviceRootUri: 'https://api.example.com',
      recipientUoi: 'R001',
      providerUsi: 'S001',
      token: 'test-token',
      originatingSystemName: 'MyMLS',
      originatingSystemId: 'MLS-42',
    }, 'P001');

    expect(config.originatingSystemName).toBe('MyMLS');
    expect(config.originatingSystemId).toBe('MLS-42');
  });
});

describe('resolvePayloadKeys', () => {
  const keyField = 'ListingKey';

  it('injects createdKey into update payloads missing keys', () => {
    const payloads = {
      createSucceeds: { ListPrice: 350000 },
      updateSucceeds: { ListPrice: 375000 },
      updateFails: { ListPrice: -1 },
    };

    const resolved = resolvePayloadKeys(payloads, keyField, 'KEY-123');

    expect(resolved.updateSucceeds.ListingKey).toBe('KEY-123');
    expect(resolved.updateFails.ListingKey).toBe('KEY-123');
    expect(resolved.keyChained).toBe(true);
  });

  it('injects createdKey into delete payload missing id', () => {
    const payloads = {
      createSucceeds: { ListPrice: 350000 },
      deleteSucceeds: {},
    };

    const resolved = resolvePayloadKeys(payloads, keyField, 'KEY-456');

    expect(resolved.deleteSucceeds.id).toBe('KEY-456');
    expect(resolved.keyChained).toBe(true);
  });

  it('preserves existing keys in payloads', () => {
    const payloads = {
      createSucceeds: { ListPrice: 350000 },
      updateSucceeds: { ListingKey: 'EXISTING-KEY', ListPrice: 375000 },
      updateFails: { ListingKey: 'EXISTING-KEY', ListPrice: -1 },
      deleteSucceeds: { id: 'EXISTING-DELETE-KEY' },
    };

    const resolved = resolvePayloadKeys(payloads, keyField, 'SHOULD-NOT-USE');

    expect(resolved.updateSucceeds.ListingKey).toBe('EXISTING-KEY');
    expect(resolved.updateFails.ListingKey).toBe('EXISTING-KEY');
    expect(resolved.deleteSucceeds.id).toBe('EXISTING-DELETE-KEY');
    expect(resolved.keyChained).toBe(false);
  });

  it('throws when update missing key and no create payload', () => {
    const payloads = {
      updateSucceeds: { ListPrice: 375000 },
    };

    expect(() => resolvePayloadKeys(payloads, keyField)).toThrow('Update payload missing');
  });

  it('throws when delete missing key and no create payload', () => {
    const payloads = {
      updateSucceeds: { ListingKey: 'HAS-KEY', ListPrice: 100 },
      updateFails: { ListingKey: 'HAS-KEY', ListPrice: -1 },
      deleteSucceeds: {},
    };

    expect(() => resolvePayloadKeys(payloads, keyField)).toThrow('Delete payload missing');
  });

  it('provides default deleteFails payload when no payloads given', () => {
    const payloads = { createSucceeds: { ListPrice: 350000 } };
    const resolved = resolvePayloadKeys(payloads, keyField);

    expect(resolved.deleteFails.id).toBe('00000000-0000-0000-0000-000000000000');
  });
});
