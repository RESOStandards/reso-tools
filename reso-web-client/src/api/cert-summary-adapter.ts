/**
 * Adapter: transform a DD cert report summary into the CoverageReport
 * shape the Org Summary page renders.
 *
 * The cert summary endpoint returns per-resource advertised stats
 * (fields and lookups broken down by total/reso/idx/local). This
 * adapter rolls them up into the field-cut tiles and per-resource
 * bars the page expects.
 *
 * Industry averages come from the market-average endpoint and are
 * passed as an optional second argument.
 */

import type {
  CertAdvertisedResource,
  CertReportSummary,
  DAMarketAverageResponse,
  MarketAverages,
} from './cert-client.js';
import type {
  CoverageReport,
  FieldCut,
  PayloadCoverage,
  ResourceCoverage,
} from './org-summary-fixtures.js';

/** Compute a safe percentage (0 when denominator is 0). */
const pct = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 100) : 0;

/**
 * Build a CoverageReport from a DD cert report summary's
 * `advertised` object. Returns null if the report has no
 * advertised data.
 */
export const summaryToCoverageReport = (
  report: CertReportSummary,
  marketAvg?: MarketAverages | null,
  daMarketAvg?: DAMarketAverageResponse | null
): CoverageReport | null => {
  if (!report.advertised || report.type !== 'data_dictionary') return null;

  const advertised = report.advertised;

  // ── Use report-level counts (include expansions, match old cert site) ─
  const allFields = report.totalFieldsCount ?? 0;
  const resoFields = report.standardFieldsCount ?? 0;
  const localFields = report.localFieldsCount ?? 0;
  const allLookups = report.totalLookupsCount ?? 0;
  const resoLookups = report.standardLookupsCount ?? 0;
  const localLookups = report.localLookupsCount ?? 0;
  const idxFields = report.iDXFieldsCount ?? 0;

  // ── Available counts from DA report (fields/lookups with data) ─
  // The provider's available data is in resourcesBinary, aggregated
  // across all resources (matching the old cert app's approach).
  const providerResourcesBinary = daMarketAvg?.availabilityReports?.[0]?.availability?.resourcesBinary ?? {};
  const providerAgg = Object.values(providerResourcesBinary).reduce(
    (acc, res) => {
      const f = res?.fields;
      const l = res?.lookups;
      if (f) {
        for (const cat of ['total', 'reso', 'idx', 'local'] as const) {
          const src = f[cat];
          if (src) for (const [k, v] of Object.entries(src)) {
            (acc.fields[cat] as Record<string, number>)[k] = ((acc.fields[cat] as Record<string, number>)[k] ?? 0) + (v as number);
          }
        }
      }
      if (l) {
        for (const cat of ['total', 'reso', 'idx', 'local'] as const) {
          const src = l[cat];
          if (src) for (const [k, v] of Object.entries(src)) {
            (acc.lookups[cat] as Record<string, number>)[k] = ((acc.lookups[cat] as Record<string, number>)[k] ?? 0) + (v as number);
          }
        }
      }
      return acc;
    },
    {
      fields: { total: {} as Record<string, number>, reso: {} as Record<string, number>, idx: {} as Record<string, number>, local: {} as Record<string, number> },
      lookups: { total: {} as Record<string, number>, reso: {} as Record<string, number>, idx: {} as Record<string, number>, local: {} as Record<string, number> },
    }
  );

  // ── Industry averages ─────────────────────────────────────────
  const avgAllFields = marketAvg ? Math.round(marketAvg.fields.total) : 0;
  const avgResoFields = marketAvg ? Math.round(marketAvg.fields.reso) : 0;
  const avgResoLookups = marketAvg ? Math.round(marketAvg.lookups.reso) : 0;
  const avgLocalFields = marketAvg ? Math.round(marketAvg.fields.local) : 0;
  const avgIdxFields = marketAvg ? Math.round(marketAvg.fields.idx) : 0;
  const avgAllLookups = marketAvg ? Math.round(marketAvg.lookups.total) : 0;

  // Industry available averages from DA market average
  const indAvailFields = daMarketAvg
    ? Math.round(daMarketAvg.marketAverage?.fields?.total?.gtZero ?? 0)
    : 0;
  const indAvailLookups = daMarketAvg
    ? Math.round(daMarketAvg.marketAverage?.lookups?.total?.gtZero ?? 0)
    : 0;

  // Available counts from DA report (aggregated from resourcesBinary)
  const resoAvailFields = providerAgg.fields.reso.gtZero ?? 0;
  const resoAvailLookups = providerAgg.lookups.reso.gtZero ?? 0;
  const allAvailFields = providerAgg.fields.total.gtZero ?? 0;
  const allAvailLookups = providerAgg.lookups.total.gtZero ?? 0;

  // Standardization rates — based on fields/lookups WITH DATA (available),
  // not advertised. "What % of fields that actually have data are RESO standard?"
  const fieldStdRate = allAvailFields > 0 ? pct(resoAvailFields, allAvailFields) : (allFields > 0 ? pct(resoFields, allFields) : 0);
  const lookupStdRate = allAvailLookups > 0 ? pct(resoAvailLookups, allAvailLookups) : (allLookups > 0 ? pct(resoLookups, allLookups) : 0);

  // Industry standardization rates from DA market average
  const indResoAvailFieldsAll = daMarketAvg ? Math.round(daMarketAvg.marketAverage?.fields?.total?.gtZero ?? 0) : 0;
  const indResoAvailLookupsAll = daMarketAvg ? Math.round(daMarketAvg.marketAverage?.lookups?.total?.gtZero ?? 0) : 0;
  const indResoAvailFieldsReso = daMarketAvg ? Math.round(daMarketAvg.marketAverage?.fields?.reso?.gtZero ?? 0) : 0;
  const indResoAvailLookupsReso = daMarketAvg ? Math.round(daMarketAvg.marketAverage?.lookups?.reso?.gtZero ?? 0) : 0;
  const avgFieldStdRate = indResoAvailFieldsAll > 0 ? pct(indResoAvailFieldsReso, indResoAvailFieldsAll) : (avgAllFields > 0 ? pct(avgResoFields, avgAllFields) : 0);
  const avgLookupStdRate = indResoAvailLookupsAll > 0 ? pct(indResoAvailLookupsReso, indResoAvailLookupsAll) : (avgAllLookups > 0 ? pct(avgResoLookups, avgAllLookups) : 0);
  const indResoAvailFields = daMarketAvg
    ? Math.round(daMarketAvg.marketAverage?.fields?.reso?.gtZero ?? 0)
    : 0;
  const indResoAvailLookups = daMarketAvg
    ? Math.round(daMarketAvg.marketAverage?.lookups?.reso?.gtZero ?? 0)
    : 0;

  const fieldCuts: ReadonlyArray<FieldCut> = [
    {
      key: 'reso-fields-available',
      label: 'RESO Fields with Data',
      providerCount: resoAvailFields || resoFields,
      industryAvgCount: indResoAvailFields || avgResoFields,
      isCount: true as const,
      subtitle: `out of ${resoFields.toLocaleString()} advertised`,
    },
    {
      key: 'reso-lookups-available',
      label: 'RESO Lookups with Data',
      providerCount: resoAvailLookups || resoLookups,
      industryAvgCount: indResoAvailLookups || avgResoLookups,
      isCount: true as const,
      subtitle: `out of ${resoLookups.toLocaleString()} advertised`,
    },
    {
      key: 'field-standardization',
      label: 'Field Standardization',
      providerCount: resoAvailFields || resoFields,
      totalCount: allAvailFields || allFields,
      providerPercent: fieldStdRate,
      industryPercent: avgFieldStdRate,
      motivational: true,
    },
    {
      key: 'lookup-standardization',
      label: 'Lookup Standardization',
      providerCount: resoAvailLookups || resoLookups,
      totalCount: allAvailLookups || allLookups,
      providerPercent: lookupStdRate,
      industryPercent: avgLookupStdRate,
      motivational: true,
    },
    {
      key: 'local',
      label: 'Local Fields',
      providerCount: localFields,
      industryAvgCount: Math.round(avgLocalFields),
      isCount: true as const,
    },
  ];

  // ── Per-resource breakdown (top 5 by field count, dynamic) ────
  const industryResources = daMarketAvg?.marketAverage?.resourcesBinary;
  const providerResources = daMarketAvg?.availabilityReports?.[0]?.availability?.resourcesBinary;

  const sortedResources = Object.keys(advertised)
    .filter((name) => advertised[name].fields.reso > 0)
    .sort((a, b) => advertised[b].fields.total - advertised[a].fields.total)
    .slice(0, 5);

  const resourceCoverage: ReadonlyArray<ResourceCoverage> = sortedResources
    .map((name) => {
      const res = advertised[name];
      const provRes = providerResources?.[name];
      const indRes = industryResources?.[name];

      const provAvailable = provRes?.fields?.reso?.gtZero ?? 0;
      const provAdvertised = res.fields.reso;
      const indAvailable = indRes?.fields?.reso?.gtZero ?? 0;

      return {
        resource: name,
        providerPercent: provAvailable,
        industryPercent: indAvailable,
        providerAdvertised: provAdvertised,
      };
    });

  // IDX total from the standard metadata (fixed set of 251 fields)
  const idxStandardTotal = marketAvg?.standardMeta?.iDXFieldsCount ?? 251;

  const payloads: ReadonlyArray<PayloadCoverage> = [
    {
      key: 'IDX',
      label: 'IDX Payload',
      providerFields: idxFields,
      totalFields: idxStandardTotal,
      providerPercent: pct(idxFields, idxStandardTotal),
      industryPercent: pct(avgIdxFields, idxStandardTotal),
      resourceCoverage,
    },
  ];

  return {
    typeLabel: 'Data Dictionary',
    version: report.version,
    date: report.statusUpdatedAt
      ? report.statusUpdatedAt.split('T')[0]
      : report.generatedOn?.split('T')[0] ?? '',
    fieldCuts,
    payloads,
  };
};
