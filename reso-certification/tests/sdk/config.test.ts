import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configEntryToAddEdit,
  configEntryToCore,
  configEntryToDD,
  configEntryToEntityEvent,
  generateLocalUoi,
  isGeneratedLocalUoi,
  loadConfigFile,
  normalizeConfigFile,
  parseConfigText
} from '../../src/sdk/config.js';
import { CURRENT_CORE_VERSION } from '../../src/sdk/core-versions.js';
import { CURRENT_DD_VERSION } from '../../src/sdk/dd-versions.js';

describe('normalizeConfigFile — accept legacy / desktop / single shapes', () => {
  it('passes the legacy { providerUoi, configs } format through', () => {
    const cf = normalizeConfigFile({
      providerUoi: 'P001',
      configs: [{ serviceRootUri: 'https://api.example.com', recipientUoi: 'R1', providerUsi: 'S1', token: 't', version: '2.1.0' }]
    });
    expect(cf.providerUoi).toBe('P001');
    expect(cf.configs).toHaveLength(1);
    expect(cf.configs[0].token).toBe('t');
    expect(cf.configs[0].version).toBe('2.1.0');
  });

  it('normalizes the desktop { providerUoi, recipients } format with nested token auth (OSN carried through)', () => {
    const cf = normalizeConfigFile({
      providerUoi: 'P001',
      recipients: [
        {
          serviceRootUri: 'https://api.example.com',
          recipientUoi: 'R1',
          providerUsi: 'S1',
          auth: { mode: 'token', authToken: 'abc' },
          originatingSystemName: 'MyMLS',
          ddOptions: { version: '2.1.0' }
        }
      ]
    });
    expect(cf.configs).toHaveLength(1);
    expect(cf.configs[0].token).toBe('abc');
    expect(cf.configs[0].originatingSystemName).toBe('MyMLS');
    expect(cf.configs[0].version).toBe('2.1.0'); // from ddOptions.version
  });

  it('maps nested client_credentials auth, tokenUrl → tokenUri', () => {
    const cf = normalizeConfigFile({
      providerUoi: 'P001',
      recipients: [
        {
          serviceRootUri: 'https://api.example.com',
          recipientUoi: 'R1',
          providerUsi: 'S1',
          auth: { mode: 'client_credentials', clientId: 'id', clientSecret: 'secret', tokenUrl: 'https://auth/token', scope: 'sc' }
        }
      ]
    });
    expect(cf.configs[0].clientCredentials).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      tokenUri: 'https://auth/token',
      scope: 'sc'
    });
    expect(cf.configs[0].token).toBeUndefined();
  });

  it('accepts a single-entry config and supplies a placeholder providerUoi', () => {
    const cf = normalizeConfigFile({
      serviceRootUri: 'https://api.example.com',
      recipientUoi: 'R1',
      providerUsi: 'S1',
      auth: { mode: 'token', authToken: 't' }
    });
    expect(cf.providerUoi).toMatch(/^LOCAL-/);
    expect(cf.configs).toHaveLength(1);
    expect(cf.configs[0].token).toBe('t');
  });

  it('throws on an unrecognized shape', () => {
    expect(() => normalizeConfigFile({ foo: 'bar' })).toThrow(/no entries/);
  });

  it('rejects a serviceRootUri that is not a valid absolute http(s) URL (catch-all)', () => {
    // A desktop placeholder the CLI does not resolve — the exact case that crashed mid-metadata before.
    expect(() =>
      normalizeConfigFile({
        providerUoi: 'P001',
        configs: [{ serviceRootUri: 'LOCAL_SERVER', recipientUoi: 'R1', providerUsi: 'S1', token: 't' }]
      })
    ).toThrow(/serviceRootUri "LOCAL_SERVER" is not a valid URL/);
    // A missing scheme is caught too.
    expect(() =>
      normalizeConfigFile({
        serviceRootUri: 'api.example.com',
        recipientUoi: 'R1',
        providerUsi: 'S1',
        auth: { mode: 'token', authToken: 't' }
      })
    ).toThrow(/not a valid URL/);
    // A real absolute URL passes.
    expect(() =>
      normalizeConfigFile({
        providerUoi: 'P001',
        configs: [{ serviceRootUri: 'https://api.example.com', recipientUoi: 'R1', providerUsi: 'S1', token: 't' }]
      })
    ).not.toThrow();
  });
});

describe('isGeneratedLocalUoi', () => {
  it('recognizes the placeholder a config without a providerUoi gets, and no real UOI', () => {
    expect(isGeneratedLocalUoi(generateLocalUoi())).toBe(true);
    expect(isGeneratedLocalUoi('T00000000')).toBe(false);
    expect(isGeneratedLocalUoi('LOCAL-PROVIDER')).toBe(false);
  });
});

describe('normalizeConfigFile — concurrency', () => {
  const entry = { serviceRootUri: 'https://api.example.com', recipientUoi: 'M00000000', providerUsi: '99999', token: 't' };

  it("keeps how many recipients the provider's API takes at once", () => {
    expect(normalizeConfigFile({ providerUoi: 'T00000000', concurrency: 100, configs: [entry] }).concurrency).toBe(100);
  });

  it('leaves it out when the file does not say', () => {
    expect('concurrency' in normalizeConfigFile({ providerUoi: 'T00000000', configs: [entry] })).toBe(false);
  });

  it('refuses anything but a positive whole number', () => {
    for (const concurrency of [0, -1, 2.5, '4', null]) {
      expect(() => normalizeConfigFile({ providerUoi: 'T00000000', concurrency, configs: [entry] })).toThrow(
        'Config file "concurrency" must be a positive whole number'
      );
    }
  });
});

describe('loadConfigFile', () => {
  const sampleConfigPath = resolve(import.meta.dirname, '../../sample-configs/add-edit-config.json');

  it('loads and parses a valid config file', async () => {
    const config = await loadConfigFile(sampleConfigPath);

    expect(config.providerUoi).toBe('LOCAL-PROVIDER');
    expect(config.configs).toHaveLength(2);
    expect(config.configs[0].serviceRootUri).toBe('http://localhost:8080');
  });

  it('reads the sample that tests only some actions and formats into a run of just those', async () => {
    const config = await loadConfigFile(sampleConfigPath);
    const subset = configEntryToAddEdit(config.configs[1], config.providerUoi);
    expect(subset.actions).toEqual(['create', 'update']);
    expect(subset.formats).toEqual({ create: ['minimal'], update: ['representation', 'minimal'] });
    expect(Object.keys(subset.payloads ?? {})).toEqual(['createSucceeds', 'createFails', 'updateSucceeds', 'updateFails']);
  });

  it('throws on missing file', async () => {
    await expect(loadConfigFile('/nonexistent.json')).rejects.toThrow();
  });
});

describe('parseConfigText', () => {
  // Synthetic. A config file carries credentials, and the parser's own message quotes the text near a fault.
  const TOKEN = 'provider-server-token-0001';

  it('refuses a file that is not JSON without quoting it', () => {
    // An unquoted value: the parser's message would quote from here, the credential's start.
    const text = `{"providerUoi": "T00000000", "configs": [{"token": ${TOKEN}}]}`;
    const refusal = (() => {
      try {
        parseConfigText(text, 'config.json');
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return undefined;
    })();
    expect(refusal).toBe('Config file config.json is not valid JSON.');
    expect(refusal).not.toContain(TOKEN.slice(0, 8));
  });

  it('says where the fault is when the parser does, still without the text', () => {
    expect(() => parseConfigText(`{"token": "${TOKEN}" ]`, 'config.json')).toThrow(
      /^Config file config\.json is not valid JSON \(line 1 column \d+\)\.$/
    );
  });

  it('refuses JSON that is not an object', () => {
    for (const text of ['null', '[]', '"text"', '7']) {
      expect(() => parseConfigText(text, 'config.json')).toThrow('Config file config.json must hold a JSON object.');
    }
  });

  it('returns the object as written', () => {
    expect(parseConfigText('{"providerUoi": "T00000000", "configs": []}', 'config.json')).toEqual({
      providerUoi: 'T00000000',
      configs: []
    });
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
    resource: 'Property'
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
        tokenUri: 'https://auth.example.com/token'
      }
    };

    const config = configEntryToAddEdit(ccEntry, 'P001');

    expect(config.server.auth).toEqual({
      mode: 'client_credentials',
      clientId: 'id',
      clientSecret: 'secret',
      tokenUrl: 'https://auth.example.com/token'
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

  it('carries the inline payloads and what the entry chooses to test', () => {
    const payloads = { createSucceeds: { ListPrice: 1 }, createFails: { ListPrice: -1 } };
    const config = configEntryToAddEdit(
      { ...entry, payloads, addEditOptions: { actions: ['create'], formats: { create: ['minimal'] } } },
      'P001'
    );
    expect(config.payloads).toEqual(payloads);
    expect(config.actions).toEqual(['create']);
    expect(config.formats).toEqual({ create: ['minimal'] });
    expect(config.autoPayloads).toBeUndefined();
  });

  it('carries auto payloads only when the entry asks for them', () => {
    expect(configEntryToAddEdit({ ...entry, addEditOptions: { autoPayloads: true } }, 'P001').autoPayloads).toBe(true);
    expect(configEntryToAddEdit({ ...entry, addEditOptions: { autoPayloads: false } }, 'P001')).not.toHaveProperty('autoPayloads');
  });
});

describe('configEntryToEntityEvent', () => {
  const entry = {
    serviceRootUri: 'https://api.example.com',
    recipientUoi: 'R001',
    providerUsi: 'S001',
    token: 'test-token'
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
  it('converts an entry with no version to the current Core minor', () => {
    // An absent version resolves to CURRENT_CORE_VERSION (the current minor), not the 2.0.0 baseline — an
    // unknown version certifies under the strictest known profile rather than silently downgrading.
    const config = configEntryToCore(
      {
        serviceRootUri: 'https://api.example.com',
        recipientUoi: 'R001',
        providerUsi: 'S001',
        token: 'test-token'
      },
      'P001'
    );

    expect(config.endorsement).toBe('core');
    expect(config.version).toBe(CURRENT_CORE_VERSION);
  });

  it('normalizes a two-part config version ("2.1") to the canonical Core literal ("2.1.0")', () => {
    // The config-mode bug: reso-certification-utils supplies the Core version as "2.1", and the old bare
    // `as CoreVersion` cast passed it straight through — so `version === '2.1.0'` gates (the $expand schema
    // validator) never fired. The entry must resolve to the exact canonical literal.
    const config = configEntryToCore(
      {
        serviceRootUri: 'https://api.example.com',
        recipientUoi: 'R001',
        providerUsi: 'S001',
        token: 'test-token',
        version: '2.1'
      },
      'P001'
    );

    expect(config.version).toBe('2.1.0');
  });

  it('passes an already-canonical config version through unchanged', () => {
    const config = configEntryToCore(
      {
        serviceRootUri: 'https://api.example.com',
        recipientUoi: 'R001',
        providerUsi: 'S001',
        token: 'test-token',
        version: '2.1.0'
      },
      'P001'
    );

    expect(config.version).toBe('2.1.0');
  });

  it('threads OriginatingSystemName/ID from the entry (reso-certification-utils format)', () => {
    const config = configEntryToCore(
      {
        serviceRootUri: 'https://api.example.com',
        recipientUoi: 'R001',
        providerUsi: 'S001',
        token: 'test-token',
        originatingSystemName: 'MyMLS',
        originatingSystemId: 'MLS-42'
      },
      'P001'
    );

    expect(config.originatingSystemName).toBe('MyMLS');
    expect(config.originatingSystemId).toBe('MLS-42');
  });

  it('omits OriginatingSystem fields when the entry carries none', () => {
    const config = configEntryToCore(
      {
        serviceRootUri: 'https://api.example.com',
        recipientUoi: 'R001',
        providerUsi: 'S001',
        token: 'test-token'
      },
      'P001'
    );

    expect(config.originatingSystemName).toBeUndefined();
    expect(config.originatingSystemId).toBeUndefined();
  });
});

describe('configEntryToDD', () => {
  it('converts with default version (the current DD version)', () => {
    const config = configEntryToDD(
      {
        serviceRootUri: 'https://api.example.com',
        recipientUoi: 'R001',
        providerUsi: 'S001',
        token: 'test-token'
      },
      'P001'
    );

    expect(config.endorsement).toBe('dd');
    // An entry with no version coerces to the current DD version.
    expect(config.version).toBe(CURRENT_DD_VERSION);
  });

  it('threads OriginatingSystemName/ID from the entry into the DD replication config', () => {
    const config = configEntryToDD(
      {
        serviceRootUri: 'https://api.example.com',
        recipientUoi: 'R001',
        providerUsi: 'S001',
        token: 'test-token',
        originatingSystemName: 'MyMLS',
        originatingSystemId: 'MLS-42'
      },
      'P001'
    );

    expect(config.originatingSystemName).toBe('MyMLS');
    expect(config.originatingSystemId).toBe('MLS-42');
  });

  // strictMode is the one option where the three states differ in meaning, because absent now means
  // strict. A truthiness test here erased an explicit `false` to absent, which silently ran the
  // opposite of what the config asked for — and left the value undefined, so the gate that explains
  // why the run is not certifiable could not fire either. All three states are pinned.
  const entry = (strictMode?: boolean) => ({
    serviceRootUri: 'https://api.example.com',
    recipientUoi: 'R001',
    providerUsi: 'S001',
    token: 'test-token',
    ...(strictMode === undefined ? {} : { ddOptions: { strictMode } })
  });

  it('carries an explicit strictMode: false through instead of erasing it to absent', () => {
    expect(configEntryToDD(entry(false), 'P001').strictMode).toBe(false);
  });

  it('carries an explicit strictMode: true through', () => {
    expect(configEntryToDD(entry(true), 'P001').strictMode).toBe(true);
  });

  it('leaves strictMode absent when the entry does not mention it, so the SDK default applies', () => {
    expect(configEntryToDD(entry(), 'P001').strictMode).toBeUndefined();
  });
});
