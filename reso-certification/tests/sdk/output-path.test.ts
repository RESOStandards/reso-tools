import { describe, it, expect } from 'vitest';
import { buildOutputPath } from '../../src/sdk/reports.js';
import type { BaseComplianceConfig } from '../../src/sdk/types.js';

const makeConfig = (overrides: Partial<BaseComplianceConfig> = {}): BaseComplianceConfig => ({
  server: { url: 'http://localhost:8080', auth: { mode: 'token', authToken: 'test' } },
  ...overrides,
});

describe('buildOutputPath', () => {
  it('builds nested path from endorsement, version, and UOIs', () => {
    const config = makeConfig({
      providerUoi: 'T00000012',
      providerUsi: '50055',
      recipientUoi: 'M00000570',
    });

    const path = buildOutputPath('web-api-core', '2.1.0', config);

    expect(path).toContain('web-api-core-2.1.0');
    expect(path).toContain('T00000012-50055');
    expect(path).toContain('M00000570');
    expect(path).toContain('current');
  });

  it('uses LOCAL defaults when UOIs are not provided', () => {
    const config = makeConfig();

    const path = buildOutputPath('data-dictionary', '2.0', config);

    expect(path).toContain('data-dictionary-2.0');
    expect(path).toMatch(/LOCAL-\d+/);
    expect(path).toContain('LOCAL-SYSTEM');
    expect(path).toContain('LOCAL-RECIPIENT');
    expect(path).toContain('current');
  });

  it('uses custom outputDir when provided', () => {
    const config = makeConfig({
      providerUoi: 'P1',
      providerUsi: 'S1',
      recipientUoi: 'R1',
      options: { outputDir: '/custom/output' },
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
      recipientUoi: 'RECIP',
    });

    const path = buildOutputPath('data-dictionary', '2.0', config);

    expect(path).toContain('data-dictionary-2.0/PROV-USI/RECIP/current');
  });

  it('produces consistent paths for EntityEvent endorsement', () => {
    const config = makeConfig({
      providerUoi: 'PROV',
      providerUsi: 'USI',
      recipientUoi: 'RECIP',
    });

    const path = buildOutputPath('entity-event', 'RCP-027', config);

    expect(path).toContain('entity-event-RCP-027/PROV-USI/RECIP/current');
  });
});
