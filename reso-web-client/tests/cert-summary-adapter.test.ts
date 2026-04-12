import { describe, expect, it } from 'vitest';
import { summaryToCoverageReport } from '../src/api/cert-summary-adapter';
import type { CertReportSummary, DAMarketAverageResponse, MarketAverages } from '../src/api/cert-client';

/** Minimal advertised resource for testing. */
const makeResource = (reso: number, local: number, idx: number) => ({
  fields: { total: reso + local, reso, idx, local },
  lookups: { total: reso * 2 + local * 3, reso: reso * 2, idx: idx * 2, local: local * 3 },
});

/** Minimal CertReportSummary for DD reports. */
const makeReport = (overrides: Partial<CertReportSummary> = {}): CertReportSummary => ({
  id: 'test-report-id',
  type: 'data_dictionary',
  version: '2.0',
  status: 'certified',
  description: 'RESO Data Dictionary Metadata Report',
  providerUoi: 'T00000001',
  providerUsi: '50001',
  recipientUoi: 'M00000001',
  generatedOn: '2025-01-01T00:00:00Z',
  statusUpdatedAt: '2025-01-01T00:00:00Z',
  totalFieldsCount: 949,
  standardFieldsCount: 600,
  localFieldsCount: 349,
  totalLookupsCount: 5000,
  standardLookupsCount: 2000,
  localLookupsCount: 3000,
  iDXFieldsCount: 150,
  advertised: {
    Property: makeResource(400, 200, 100),
    Member: makeResource(100, 50, 30),
    Office: makeResource(80, 30, 15),
    Media: makeResource(10, 20, 3),
    OpenHouse: makeResource(10, 5, 2),
    CustomLocal: makeResource(0, 44, 0),
  },
  ...overrides,
});

/** Minimal MarketAverages. */
const makeMarketAvg = (): MarketAverages => ({
  docCount: 100,
  standardMeta: { iDXFieldsCount: 251, iDXResourcesCount: 6, iDXLookupsCount: 1542 },
  fields: { total: 981, reso: 444, idx: 200, local: 537 },
  lookups: { total: 13685, reso: 1153, idx: 800, local: 12532 },
});

/** Minimal DA market average response with resourcesBinary. */
const makeDAMarketAvg = (): DAMarketAverageResponse => ({
  marketAverage: {
    fields: {
      total: { eqZero: 0, gtZero: 1068, gte25: 500, gte50: 400, gte75: 300, eq100: 186 },
      reso: { eqZero: 0, gtZero: 605, gte25: 350, gte50: 300, gte75: 250, eq100: 129 },
      idx: { eqZero: 0, gtZero: 286, gte25: 200, gte50: 180, gte75: 156, eq100: 87 },
      local: { eqZero: 0, gtZero: 463, gte25: 138, gte50: 114, gte75: 96, eq100: 57 },
    },
    lookups: {
      total: { eqZero: 0, gtZero: 6600, gte25: 145, gte50: 70, gte75: 36, eq100: 7 },
      reso: { eqZero: 0, gtZero: 1092, gte25: 84, gte50: 37, gte75: 18, eq100: 5 },
      idx: { eqZero: 0, gtZero: 751, gte25: 61, gte50: 26, gte75: 11, eq100: 3 },
      local: { eqZero: 0, gtZero: 5508, gte25: 61, gte50: 32, gte75: 19, eq100: 2 },
    },
    resourcesBinary: {
      Property: {
        fields: {
          total: { eqZero: 0, gtZero: 604, gte25: 350, gte50: 300, gte75: 200, eq100: 100 },
          reso: { eqZero: 0, gtZero: 238, gte25: 180, gte50: 160, gte75: 130, eq100: 80 },
          idx: { eqZero: 0, gtZero: 180, gte25: 140, gte50: 120, gte75: 100, eq100: 60 },
          local: { eqZero: 0, gtZero: 366, gte25: 170, gte50: 140, gte75: 70, eq100: 20 },
        },
        lookups: {
          total: { eqZero: 0, gtZero: 5000, gte25: 100, gte50: 50, gte75: 25, eq100: 5 },
          reso: { eqZero: 0, gtZero: 800, gte25: 60, gte50: 25, gte75: 12, eq100: 3 },
          idx: { eqZero: 0, gtZero: 600, gte25: 45, gte50: 20, gte75: 8, eq100: 2 },
          local: { eqZero: 0, gtZero: 4200, gte25: 40, gte50: 25, gte75: 13, eq100: 2 },
        },
      },
      Member: {
        fields: {
          total: { eqZero: 0, gtZero: 41, gte25: 30, gte50: 25, gte75: 20, eq100: 15 },
          reso: { eqZero: 0, gtZero: 33, gte25: 25, gte50: 20, gte75: 16, eq100: 12 },
          idx: { eqZero: 0, gtZero: 20, gte25: 15, gte50: 12, gte75: 10, eq100: 8 },
          local: { eqZero: 0, gtZero: 8, gte25: 5, gte50: 5, gte75: 4, eq100: 3 },
        },
        lookups: {
          total: { eqZero: 0, gtZero: 100, gte25: 10, gte50: 5, gte75: 3, eq100: 1 },
          reso: { eqZero: 0, gtZero: 80, gte25: 8, gte50: 4, gte75: 2, eq100: 1 },
          idx: { eqZero: 0, gtZero: 60, gte25: 6, gte50: 3, gte75: 2, eq100: 1 },
          local: { eqZero: 0, gtZero: 20, gte25: 2, gte50: 1, gte75: 1, eq100: 0 },
        },
      },
    },
  },
  availabilityReports: [
    {
      reportId: 'test-report-id',
      providerUoi: 'T00000001',
      providerUsi: '50001',
      version: '2.0',
      availability: {
        fields: {
          total: { eqZero: 50, gtZero: 2714, gte25: 400, gte50: 350, gte75: 280, eq100: 145 },
          reso: { eqZero: 30, gtZero: 2237, gte25: 300, gte50: 270, gte75: 220, eq100: 108 },
          idx: { eqZero: 5, gtZero: 169, gte25: 130, gte50: 120, gte75: 100, eq100: 69 },
          local: { eqZero: 20, gtZero: 477, gte25: 100, gte50: 80, gte75: 60, eq100: 37 },
        },
        lookups: {
          total: { eqZero: 0, gtZero: 698, gte25: 57, gte50: 33, gte75: 13, eq100: 2 },
          reso: { eqZero: 0, gtZero: 141, gte25: 30, gte50: 21, gte75: 10, eq100: 2 },
          idx: { eqZero: 0, gtZero: 94, gte25: 24, gte50: 16, gte75: 7, eq100: 2 },
          local: { eqZero: 0, gtZero: 557, gte25: 27, gte50: 12, gte75: 3, eq100: 0 },
        },
        resources: [],
        resourcesBinary: {
          Property: {
            fields: {
              total: { eqZero: 40, gtZero: 476, gte25: 300, gte50: 270, gte75: 200, eq100: 100 },
              reso: { eqZero: 20, gtZero: 350, gte25: 220, gte50: 200, gte75: 160, eq100: 80 },
              idx: { eqZero: 3, gtZero: 120, gte25: 100, gte50: 90, gte75: 75, eq100: 50 },
              local: { eqZero: 20, gtZero: 126, gte25: 80, gte50: 70, gte75: 40, eq100: 20 },
            },
            lookups: {
              total: { eqZero: 0, gtZero: 500, gte25: 40, gte50: 25, gte75: 10, eq100: 2 },
              reso: { eqZero: 0, gtZero: 100, gte25: 20, gte50: 15, gte75: 7, eq100: 2 },
              idx: { eqZero: 0, gtZero: 70, gte25: 15, gte50: 10, gte75: 5, eq100: 2 },
              local: { eqZero: 0, gtZero: 400, gte25: 20, gte50: 10, gte75: 3, eq100: 0 },
            },
          },
          Member: {
            fields: {
              total: { eqZero: 5, gtZero: 45, gte25: 30, gte50: 25, gte75: 20, eq100: 12 },
              reso: { eqZero: 3, gtZero: 40, gte25: 28, gte50: 23, gte75: 18, eq100: 10 },
              idx: { eqZero: 1, gtZero: 25, gte25: 18, gte50: 15, gte75: 12, eq100: 8 },
              local: { eqZero: 2, gtZero: 5, gte25: 2, gte50: 2, gte75: 2, eq100: 2 },
            },
            lookups: {
              total: { eqZero: 0, gtZero: 50, gte25: 5, gte50: 3, gte75: 1, eq100: 0 },
              reso: { eqZero: 0, gtZero: 30, gte25: 4, gte50: 2, gte75: 1, eq100: 0 },
              idx: { eqZero: 0, gtZero: 20, gte25: 3, gte50: 2, gte75: 1, eq100: 0 },
              local: { eqZero: 0, gtZero: 20, gte25: 1, gte50: 1, gte75: 0, eq100: 0 },
            },
          },
          Office: {
            fields: {
              total: { eqZero: 5, gtZero: 46, gte25: 25, gte50: 20, gte75: 15, eq100: 10 },
              reso: { eqZero: 3, gtZero: 27, gte25: 15, gte50: 12, gte75: 10, eq100: 8 },
              idx: { eqZero: 1, gtZero: 24, gte25: 12, gte50: 15, gte75: 13, eq100: 11 },
              local: { eqZero: 2, gtZero: 346, gte25: 100, gte50: 80, gte75: 60, eq100: 37 },
            },
            lookups: {
              total: { eqZero: 0, gtZero: 148, gte25: 12, gte50: 5, gte75: 2, eq100: 0 },
              reso: { eqZero: 0, gtZero: 11, gte25: 6, gte50: 4, gte75: 2, eq100: 0 },
              idx: { eqZero: 0, gtZero: 4, gte25: 6, gte50: 4, gte75: 1, eq100: 0 },
              local: { eqZero: 0, gtZero: 137, gte25: 6, gte50: 1, gte75: 0, eq100: 0 },
            },
          },
        },
      },
    },
  ],
});

describe('summaryToCoverageReport', () => {
  it('returns null for non-DD reports', () => {
    const report = makeReport({ type: 'web_api_server_core' });
    expect(summaryToCoverageReport(report)).toBeNull();
  });

  it('returns null when advertised is missing', () => {
    const report = makeReport({ advertised: undefined });
    expect(summaryToCoverageReport(report)).toBeNull();
  });

  it('produces 5 field cut tiles', () => {
    const report = makeReport();
    const result = summaryToCoverageReport(report, makeMarketAvg(), makeDAMarketAvg());
    expect(result).not.toBeNull();
    expect(result!.fieldCuts).toHaveLength(5);
    expect(result!.fieldCuts.map(c => c.key)).toEqual([
      'reso-fields-available',
      'reso-lookups-available',
      'field-standardization',
      'lookup-standardization',
      'local',
    ]);
  });

  it('uses report-level counts for advertised (includes expansions)', () => {
    const report = makeReport();
    const result = summaryToCoverageReport(report, makeMarketAvg());
    const fieldTile = result!.fieldCuts[0];
    // subtitle should reference standardFieldsCount (600 RESO), not sum of advertised.fields.reso
    expect(fieldTile.isCount && fieldTile.subtitle).toContain('600');
  });

  it('uses resourcesBinary aggregation for available counts (not top-level availability)', () => {
    const report = makeReport();
    const daMarketAvg = makeDAMarketAvg();
    const result = summaryToCoverageReport(report, makeMarketAvg(), daMarketAvg);

    const fieldTile = result!.fieldCuts[0];
    // Provider RESO fields with data = sum of resourcesBinary[*].fields.reso.gtZero
    // Property: 350 + Member: 40 + Office: 27 = 417
    expect(fieldTile.isCount && fieldTile.providerCount).toBe(417);
    // NOT the non-aggregated availability.fields.reso.gtZero (2237)
  });

  it('uses non-aggregated DA market average for industry averages', () => {
    const report = makeReport();
    const daMarketAvg = makeDAMarketAvg();
    const result = summaryToCoverageReport(report, makeMarketAvg(), daMarketAvg);

    const fieldTile = result!.fieldCuts[0];
    // Industry avg from marketAverage.fields.reso.gtZero = 605
    expect(fieldTile.isCount && fieldTile.industryAvgCount).toBe(605);
  });

  it('computes standardization rates from available data', () => {
    const report = makeReport();
    const daMarketAvg = makeDAMarketAvg();
    const result = summaryToCoverageReport(report, makeMarketAvg(), daMarketAvg);

    const fieldStd = result!.fieldCuts[2];
    expect(fieldStd.key).toBe('field-standardization');
    if (!fieldStd.isCount) {
      // RESO available / all available
      // Property: 350 + Member: 40 + Office: 27 = 417 RESO
      // Property: 476 + Member: 45 + Office: 46 = 567 total
      expect(fieldStd.providerPercent).toBe(Math.round((417 / 567) * 100));
    }
  });

  it('shows local fields count from report-level data', () => {
    const report = makeReport();
    const result = summaryToCoverageReport(report, makeMarketAvg());

    const localTile = result!.fieldCuts[4];
    expect(localTile.key).toBe('local');
    expect(localTile.isCount && localTile.providerCount).toBe(349);
  });

  it('uses standardMeta.iDXFieldsCount as IDX denominator', () => {
    const report = makeReport();
    const marketAvg = makeMarketAvg();
    const result = summaryToCoverageReport(report, marketAvg);

    const payload = result!.payloads[0];
    expect(payload.totalFields).toBe(251);
    expect(payload.providerPercent).toBe(Math.round((150 / 251) * 100));
  });

  it('filters local-only resources from key resources', () => {
    const report = makeReport();
    const result = summaryToCoverageReport(report, makeMarketAvg(), makeDAMarketAvg());

    const resourceNames = result!.payloads[0].resourceCoverage.map(r => r.resource);
    // CustomLocal has 0 RESO fields, should be excluded
    expect(resourceNames).not.toContain('CustomLocal');
    expect(resourceNames.length).toBeLessThanOrEqual(5);
  });

  it('sorts key resources by total field count descending', () => {
    const report = makeReport();
    const result = summaryToCoverageReport(report, makeMarketAvg(), makeDAMarketAvg());

    const resources = result!.payloads[0].resourceCoverage;
    // Property (600 total) > Member (150) > Office (110) > Media (30) > OpenHouse (15)
    expect(resources[0].resource).toBe('Property');
    expect(resources[1].resource).toBe('Member');
  });

  it('falls back to advertised counts when DA data is missing', () => {
    const report = makeReport();
    const result = summaryToCoverageReport(report, makeMarketAvg());

    const fieldTile = result!.fieldCuts[0];
    // Without DA data, falls back to standardFieldsCount
    expect(fieldTile.isCount && fieldTile.providerCount).toBe(600);
  });

  it('falls back to market-average endpoint when DA market average is missing', () => {
    const report = makeReport();
    const result = summaryToCoverageReport(report, makeMarketAvg());

    const fieldTile = result!.fieldCuts[0];
    // Without DA market avg, falls back to marketAvg.fields.reso = 444
    expect(fieldTile.isCount && fieldTile.industryAvgCount).toBe(444);
  });

  it('computes standardization from advertised when DA data is missing', () => {
    const report = makeReport();
    const result = summaryToCoverageReport(report, makeMarketAvg());

    const fieldStd = result!.fieldCuts[2];
    if (!fieldStd.isCount) {
      // Without DA: resoFields / allFields = 600 / 949
      expect(fieldStd.providerPercent).toBe(Math.round((600 / 949) * 100));
    }
  });

  it('returns correct date from statusUpdatedAt', () => {
    const report = makeReport({ statusUpdatedAt: '2025-06-15T12:00:00Z' });
    const result = summaryToCoverageReport(report);
    expect(result!.date).toBe('2025-06-15');
  });

  it('returns correct version and typeLabel', () => {
    const report = makeReport({ version: '1.7' });
    const result = summaryToCoverageReport(report);
    expect(result!.version).toBe('1.7');
    expect(result!.typeLabel).toBe('Data Dictionary');
  });
});
