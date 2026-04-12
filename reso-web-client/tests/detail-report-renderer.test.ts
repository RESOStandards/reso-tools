import { describe, expect, it } from 'vitest';
import { selectRenderer, SPEC_LINKS } from '../src/pages/cert/detail-report-page';
import type { CertReportSummary } from '../src/api/cert-client';

const makeReport = (overrides: Partial<CertReportSummary> = {}): CertReportSummary => ({
  id: 'test-id',
  type: 'data_dictionary',
  version: '2.0',
  status: 'certified',
  description: 'Test Report',
  providerUoi: 'T00000001',
  providerUsi: '50001',
  recipientUoi: 'M00000001',
  generatedOn: '2025-01-01T00:00:00Z',
  statusUpdatedAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('selectRenderer', () => {
  it('selects DD renderer for data_dictionary with advertised data', () => {
    const report = makeReport({
      type: 'data_dictionary',
      advertised: {
        Property: {
          fields: { total: 100, reso: 80, idx: 50, local: 20 },
          lookups: { total: 200, reso: 150, idx: 100, local: 50 },
        },
      },
    });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('DDDetailRenderer');
  });

  it('selects Generic renderer for data_dictionary without advertised data', () => {
    const report = makeReport({
      type: 'data_dictionary',
      advertised: undefined,
    });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('GenericDetailRenderer');
  });

  it('selects Core renderer for web_api_server_core', () => {
    const report = makeReport({ type: 'web_api_server_core' });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('CoreDetailRenderer');
  });

  it('selects Generic renderer for add_edit', () => {
    const report = makeReport({ type: 'add_edit' });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('GenericDetailRenderer');
  });

  it('selects Generic renderer for common_format', () => {
    const report = makeReport({ type: 'common_format' });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('GenericDetailRenderer');
  });

  it('selects Generic renderer for webhooks', () => {
    const report = makeReport({ type: 'webhooks' });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('GenericDetailRenderer');
  });

  it('selects Generic renderer for validation_expressions', () => {
    const report = makeReport({ type: 'validation_expressions' });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('GenericDetailRenderer');
  });

  it('selects Generic renderer for upi', () => {
    const report = makeReport({ type: 'upi' });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('GenericDetailRenderer');
  });

  it('selects Generic renderer for unknown types', () => {
    const report = makeReport({ type: 'something_new' });
    const renderer = selectRenderer(report);
    expect(renderer.name).toBe('GenericDetailRenderer');
  });
});

describe('SPEC_LINKS', () => {
  it('has links for data_dictionary (spec + docs)', () => {
    const links = SPEC_LINKS.data_dictionary;
    expect(links).toHaveLength(2);
    expect(links[0].url).toContain('transport.reso.org');
    expect(links[1].url).toContain('dd.reso.org');
  });

  it('has link for web_api_server_core', () => {
    const links = SPEC_LINKS.web_api_server_core;
    expect(links).toHaveLength(1);
    expect(links[0].url).toContain('web-api-core');
  });

  it('has link for add_edit', () => {
    expect(SPEC_LINKS.add_edit).toHaveLength(1);
    expect(SPEC_LINKS.add_edit[0].url).toContain('web-api-add-edit');
  });

  it('has link for common_format', () => {
    expect(SPEC_LINKS.common_format).toHaveLength(1);
    expect(SPEC_LINKS.common_format[0].url).toContain('reso-common-format');
  });

  it('has link for webhooks', () => {
    expect(SPEC_LINKS.webhooks).toHaveLength(1);
    expect(SPEC_LINKS.webhooks[0].url).toContain('webhooks-push');
  });

  it('has link for validation_expressions', () => {
    expect(SPEC_LINKS.validation_expressions).toHaveLength(1);
    expect(SPEC_LINKS.validation_expressions[0].url).toContain('validation-expressions');
  });

  it('has link for upi', () => {
    expect(SPEC_LINKS.upi).toHaveLength(1);
    expect(SPEC_LINKS.upi[0].url).toContain('upi.reso.org');
  });

  it('covers all 7 endorsement types', () => {
    expect(Object.keys(SPEC_LINKS)).toHaveLength(7);
  });
});
