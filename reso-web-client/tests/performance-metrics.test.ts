import { describe, expect, it } from 'vitest';
import { perfMetricsToSummary } from '../src/pages/cert/org-summary-page';
import type { PerformanceMetricsReport, CertReportSummary } from '../src/api/cert-client';

const makeReport = (overrides: Partial<CertReportSummary> = {}): CertReportSummary => ({
  id: 'test-id',
  type: 'data_dictionary',
  version: '2.0',
  status: 'certified',
  description: 'Test Report',
  providerUoi: 'T00000001',
  providerUsi: '50001',
  recipientUoi: 'M00000001',
  generatedOn: '2025-09-22T00:00:00Z',
  statusUpdatedAt: '2025-09-24T00:00:00Z',
  ...overrides,
});

const makePerfData = (
  overrides: Partial<{
    opted_in: boolean;
    averageResponseTimeMillis: number;
    averageBandwidth: number;
    averageResponseBytes: number;
    marketResponseMs: number;
    marketBandwidth: number;
    marketBytes: number;
    propertyResponseMs: number;
    propertyPageSize: number;
  }> = {}
): PerformanceMetricsReport => {
  const optedIn = overrides.opted_in ?? true;
  const base: Record<string, unknown> = {
    reportId: 'test-report',
    type: 'data_availability',
    version: '2.0',
    description: 'RESO Data Availability Report',
    generatedOn: '2025-09-22T19:58:05.000Z',
    recipientUoi: 'M00000001',
    providerUoi: 'T00000001',
    providerUsi: '50001',
    optInStatus: optedIn ? 'opted_in' : 'opted_out',
    opted_in: optedIn,
    averageResponseTimeMillis: overrides.averageResponseTimeMillis ?? 183,
    averageBandwidth: overrides.averageBandwidth ?? 523,
    averageResponseBytes: overrides.averageResponseBytes ?? 73330,
  };

  if (optedIn) {
    base.Property = {
      averageResponseTimeMs: overrides.propertyResponseMs ?? 108,
      averageResponseTimeMillis: overrides.propertyResponseMs ?? 108,
      medianResponseTimeMs: 98,
      averageResponseBytes: 129893,
      medianResponseBytes: 113419,
      stdDevResponseTimeMs: 23.5,
      stdDevResponseBytes: 114704,
      bandwidth: 1174,
      numSamples: 11,
      numRecordsFetched: 252,
      numUniqueRecordsFetched: 84,
      recordCount: 0,
      pageSize: overrides.propertyPageSize ?? 84,
      dateField: 'ModificationTimestamp',
      dateLow: '2025-09-14T03:07:39.000Z',
      dateHigh: '2025-09-18T19:49:03.000Z',
      postalCodes: [],
    };
    base.Lookup = {
      averageResponseTimeMs: 229,
      averageResponseTimeMillis: 229,
      medianResponseTimeMs: 228,
      averageResponseBytes: 55075,
      medianResponseBytes: 57238,
      stdDevResponseTimeMs: 23.7,
      stdDevResponseBytes: 6458,
      bandwidth: 235,
      numSamples: 17,
      numRecordsFetched: 3266,
      numUniqueRecordsFetched: 1533,
      recordCount: 0,
      pageSize: 200,
      dateField: 'ModificationTimestamp',
      dateLow: '2023-09-21T10:12:11.810Z',
      dateHigh: '2025-09-21T10:12:11.810Z',
      postalCodes: [],
    };
  }

  return {
    reportId: 'test-report',
    performanceReport: base as PerformanceMetricsReport['performanceReport'],
    marketAverage: {
      averageResponseTimeMillis: overrides.marketResponseMs ?? 1097,
      averageBandwidth: overrides.marketBandwidth ?? 886,
      averageResponseBytes: overrides.marketBytes ?? 1037396,
    },
  };
};

describe('perfMetricsToSummary', () => {
  it('converts opted-in provider metrics to PerformanceReport shape', () => {
    const result = perfMetricsToSummary(makePerfData(), makeReport());

    expect(result.typeLabel).toBe('Data Dictionary');
    expect(result.version).toBe('2.0');
    expect(result.optedOut).toBe(false);
    expect(result.secPer1k).toBeGreaterThan(0);
    expect(result.industrySecPer1k).toBeGreaterThan(0);
    expect(result.responseS).toBeGreaterThan(0);
    expect(result.industryResponseS).toBeGreaterThan(0);
  });

  it('uses Property resource for headline response time when available', () => {
    const result = perfMetricsToSummary(
      makePerfData({ propertyResponseMs: 100, propertyPageSize: 100 }),
      makeReport()
    );

    // secPer1k = (100ms / 1000) * (1000 / 100) = 1.0s
    expect(result.secPer1k).toBeCloseTo(1.0, 1);
  });

  it('computes delta percentage vs. industry', () => {
    const result = perfMetricsToSummary(
      makePerfData({ propertyResponseMs: 100, propertyPageSize: 100, marketResponseMs: 200 }),
      makeReport()
    );

    // Provider: 1.0s per 1k, Industry: 2.0s per 1k → 50% faster
    expect(result.deltaPercent).toBe(50);
  });

  it('handles opted-out provider gracefully', () => {
    const result = perfMetricsToSummary(
      makePerfData({ opted_in: false }),
      makeReport()
    );

    expect(result.optedOut).toBe(true);
    expect(result.secPer1k).toBe(0);
    expect(result.deltaPercent).toBe(0);
    expect(result.payloadMb).toBe(0);
    expect(result.throughputMbS).toBe(0);
    // Industry averages should still be present
    expect(result.industrySecPer1k).toBeGreaterThan(0);
    expect(result.industryResponseS).toBeGreaterThan(0);
    expect(result.industryPayloadMb).toBeGreaterThan(0);
  });

  it('converts bytes to MB for payload sizes', () => {
    const result = perfMetricsToSummary(
      makePerfData({ averageResponseBytes: 1024 * 1024 * 5, marketBytes: 1024 * 1024 * 10 }),
      makeReport()
    );

    expect(result.payloadMb).toBeCloseTo(5, 0);
    expect(result.industryPayloadMb).toBeCloseTo(10, 0);
  });

  it('converts bandwidth KB/s to MB/s', () => {
    const result = perfMetricsToSummary(
      makePerfData({ averageBandwidth: 1024, marketBandwidth: 2048 }),
      makeReport()
    );

    expect(result.throughputMbS).toBeCloseTo(1.0, 1);
    expect(result.industryThroughputMbS).toBeCloseTo(2.0, 1);
  });

  it('extracts date from DD report statusUpdatedAt', () => {
    const result = perfMetricsToSummary(
      makePerfData(),
      makeReport({ statusUpdatedAt: '2025-09-24T14:02:11.989Z' })
    );

    expect(result.date).toBe('2025-09-24');
  });

  it('falls back to generatedOn when statusUpdatedAt is absent', () => {
    const result = perfMetricsToSummary(
      makePerfData(),
      makeReport({ statusUpdatedAt: '', generatedOn: '2025-09-22T00:00:00Z' })
    );

    expect(result.date).toBe('2025-09-22');
  });

  it('handles null DD report', () => {
    const result = perfMetricsToSummary(makePerfData(), null);

    expect(result.version).toBe('2.0');
    expect(result.date).toBe('2025-09-22');
  });
});
