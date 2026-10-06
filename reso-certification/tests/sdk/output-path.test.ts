import { describe, expect, it } from 'vitest';
import {
  configEntryToAddEdit,
  configEntryToCore,
  configEntryToDD,
  configEntryToEntityEvent,
  normalizeConfigFile
} from '../../src/sdk/config.js';
import { buildOutputPath } from '../../src/sdk/reports.js';
import type { BaseComplianceConfig } from '../../src/sdk/types.js';

const makeConfig = (overrides: Partial<BaseComplianceConfig> = {}): BaseComplianceConfig => ({
  server: { url: 'http://localhost:8080', auth: { mode: 'token', authToken: 'test' } },
  ...overrides
});

describe('buildOutputPath', () => {
  it('builds nested path from endorsement, version, and UOIs', () => {
    const config = makeConfig({
      providerUoi: 'T00000012',
      providerUsi: '50055',
      recipientUoi: 'M00000570'
    });

    const path = buildOutputPath('web-api-core', '2.1.0', config);

    expect(path).toContain('web-api-core-2.1.0');
    expect(path).toContain('T00000012-50055');
    expect(path).toContain('M00000570');
    expect(path).toContain('current');
  });

  it('names the missing parameter when UOIs are not provided', () => {
    const config = makeConfig();

    const path = buildOutputPath('data-dictionary', '2.0', config);

    expect(path).toContain('data-dictionary-2.0');
    expect(path).toContain('providerUoi-providerUsi');
    expect(path).toContain('recipientUoi');
    expect(path).toContain('current');
  });

  it('uses custom outputDir when provided', () => {
    const config = makeConfig({
      providerUoi: 'P1',
      providerUsi: 'S1',
      recipientUoi: 'R1',
      options: { outputDir: '/custom/output' }
    });

    const path = buildOutputPath('web-api-add-edit', '2.0.0', config);

    expect(path).toContain('/custom/output');
    expect(path).toContain('web-api-add-edit-2.0.0');
    expect(path).toContain('P1-S1');
    expect(path).toContain('R1');
  });

  it('produces consistent paths for DD endorsement', () => {
    const config = makeConfig({
      providerUoi: 'PROV',
      providerUsi: 'USI',
      recipientUoi: 'RECIP'
    });

    const path = buildOutputPath('data-dictionary', '2.0', config);

    expect(path).toContain('data-dictionary-2.0/PROV-USI/RECIP/current');
  });

  it('produces consistent paths for EntityEvent endorsement', () => {
    const config = makeConfig({
      providerUoi: 'PROV',
      providerUsi: 'USI',
      recipientUoi: 'RECIP'
    });

    const path = buildOutputPath('entity-event', 'RCP-027', config);

    expect(path).toContain('entity-event-RCP-027/PROV-USI/RECIP/current');
  });
});

// ── The seam: a config mapper feeding buildOutputPath ────────────────
//
// Both halves of this were already covered and both passed, while the joint was
// broken for every real run. `buildOutputPath` was tested with identifiers handed
// to it directly, and the mappers were tested on their own output -- but nothing
// composed a mapper WITH the path builder, which is the only combination a CLI run
// actually executes. The mappers used providerUoi / providerUsi / recipientUoi
// solely to compose `options.outputDir` and never set them on the config, so the
// nested path fell back to LOCAL placeholders even when the config declared all
// three. Observed in a real DD run: `LOCAL-1791138001913-LOCAL-SYSTEM/LOCAL-RECIPIENT`
// from a config that had every identifier.
//
// The LOCAL fallback itself is correct and is kept: it is what a local run without
// identifiers should produce. What was wrong is that it fired when the values existed.

const V1_CONFIG = {
  providerUoi: 'T00000012',
  configs: [
    {
      description: 'Sample Bearer Token Config',
      serviceRootUri: 'https://api.example.org/odata',
      recipientUoi: 'M00000570',
      providerUsi: '50055',
      token: 'test-token'
    }
  ]
};

describe('config mapper to buildOutputPath (the seam)', () => {
  const mappers = [
    ['dd', configEntryToDD, 'data-dictionary', '2.1'],
    ['core', configEntryToCore, 'web-api-core', '2.1.0'],
    ['add-edit', configEntryToAddEdit, 'web-api-add-edit', '2.0.0'],
    ['entity-event', configEntryToEntityEvent, 'entity-event', '1.0.0']
  ] as const;

  for (const [label, mapper, slug, version] of mappers) {
    it(`carries the config's identifiers into the ${label} output path`, () => {
      const file = normalizeConfigFile(V1_CONFIG as unknown as Record<string, unknown>);
      const config = mapper(file.configs[0] as never, file.providerUoi) as BaseComplianceConfig;

      const path = buildOutputPath(slug, version, config);

      expect(path).toContain('T00000012-50055');
      expect(path).toContain('M00000570');
      // The regression: any LOCAL placeholder here means the identifiers were dropped.
      expect(path).not.toContain('providerUoi-providerUsi');
      expect(path).not.toMatch(/\/recipientUoi\//);
    });
  }

  it('still falls back to LOCAL when the config declares no identifiers', () => {
    // `normalizeConfigEntry` fills a missing identifier with '' rather than leaving it
    // undefined, and `buildOutputPath` guards with `??`, which passes '' through and
    // would collapse the path segment. Only a non-empty value is set on the config, so
    // a genuinely absent one stays absent and the intended fallback fires.
    const file = normalizeConfigFile({
      configs: [{ serviceRootUri: 'https://api.example.org/odata', token: 't' }]
    } as unknown as Record<string, unknown>);
    const config = configEntryToDD(file.configs[0] as never, file.providerUoi) as BaseComplianceConfig;

    const path = buildOutputPath('data-dictionary', '2.1', config);

    // providerUoi arrives as a generated LOCAL- identity from normalizeConfigFile, a separate
    // layer with its own tested contract, so only the two fields this builder actually defaults
    // name themselves here.
    expect(path).toContain('providerUsi');
    expect(path).toContain('recipientUoi');
  });

  it('never lets a blank identifier reach the path builder', () => {
    // `buildOutputPath` guards with `??`, which cannot see ''. The invariant that makes that safe
    // lives in the mapper: it sets an identifier only when non-empty, so a blank normalized value
    // arrives as undefined and the fallback fires. Asserted here because this is the seam where a
    // regression would reappear -- a mapper that starts setting '' would silently drop a segment.
    const file = normalizeConfigFile({
      providerUoi: 'T00000012',
      configs: [{ serviceRootUri: 'https://api.example.org/odata', recipientUoi: '', providerUsi: '   ', token: 't' }]
    } as unknown as Record<string, unknown>);
    const config = configEntryToDD(file.configs[0] as never, file.providerUoi) as BaseComplianceConfig;

    expect(config.providerUsi).toBeUndefined();
    expect(config.recipientUoi).toBeUndefined();

    const path = buildOutputPath('data-dictionary', '2.1', config);
    expect(path).toContain('T00000012-providerUsi');
    expect(path).toContain('recipientUoi');
    expect(path).not.toMatch(/\/\//);
    expect(path).not.toMatch(/-\//);
  });
});
