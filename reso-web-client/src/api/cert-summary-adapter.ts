/**
 * Adapter: transform a DD cert report summary into the CoverageReport
 * shape the Org Summary page renders.
 *
 * The cert summary endpoint returns per-resource advertised stats
 * (fields and lookups broken down by total/reso/idx/local). This
 * adapter rolls them up into the field-cut tiles and per-resource
 * bars the page expects.
 *
 * Industry averages are not available from the summary endpoint.
 * They are set to 0 here and will be populated from a separate
 * analytics endpoint when it lands. The UI handles 0 gracefully
 * (no comparison bar, no "above/below" pill).
 */

import type {
  CertAdvertisedResource,
  CertReportSummary,
} from './cert-client.js';
import type {
  CoverageReport,
  FieldCut,
  PayloadCoverage,
  ResourceCoverage,
} from './org-summary-fixtures.js';

/** Top resources to show in the per-resource breakdown, in display order. */
const TOP_RESOURCES = ['Property', 'Member', 'Office', 'Media', 'OpenHouse'];

/** Compute a safe percentage (0 when denominator is 0). */
const pct = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 100) : 0;

/**
 * Build a CoverageReport from a DD cert report summary's
 * `advertised` object. Returns null if the report has no
 * advertised data.
 */
export const summaryToCoverageReport = (
  report: CertReportSummary
): CoverageReport | null => {
  if (!report.advertised || report.type !== 'data_dictionary') return null;

  const advertised = report.advertised;

  // ── Roll up field cuts across all resources ────────────────────
  let allFields = 0;
  let allLookups = 0;
  let resoFields = 0;
  let resoLookups = 0;
  let idxFields = 0;
  let idxLookups = 0;
  let localFields = 0;
  let localLookups = 0;

  for (const [, res] of Object.entries(advertised)) {
    allFields += res.fields.total;
    allLookups += res.lookups.total;
    resoFields += res.fields.reso;
    resoLookups += res.lookups.reso;
    idxFields += res.fields.idx;
    idxLookups += res.lookups.idx;
    localFields += res.fields.local;
    localLookups += res.lookups.local;
  }

  const totalStandardFields = resoFields + localFields;
  const totalStandardLookups = resoLookups + localLookups;

  const fieldCuts: ReadonlyArray<FieldCut> = [
    {
      key: 'all',
      label: 'All Fields Advertised',
      providerCount: allFields,
      totalCount: allFields,
      providerPercent: 100,
      industryPercent: 0,
    },
    {
      key: 'reso-fields',
      label: 'RESO Standard Fields',
      providerCount: resoFields,
      totalCount: allFields,
      providerPercent: pct(resoFields, allFields),
      industryPercent: 0,
      motivational: true,
    },
    {
      key: 'reso-enums',
      label: 'RESO Enumerations',
      providerCount: resoLookups,
      totalCount: allLookups,
      providerPercent: pct(resoLookups, allLookups),
      industryPercent: 0,
      motivational: true,
    },
    {
      key: 'local',
      label: 'Local Fields',
      providerCount: localFields,
      industryAvgCount: 0,
      isCount: true as const,
    },
  ];

  // ── IDX payload breakdown ──────────────────────────────────────
  const idxTotalFields = idxFields;
  const idxResourceCoverage: ReadonlyArray<ResourceCoverage> = TOP_RESOURCES
    .filter((name) => advertised[name])
    .map((name) => {
      const res = advertised[name];
      return {
        resource: name,
        providerPercent: pct(res.fields.idx, res.fields.total),
        industryPercent: 0,
      };
    });

  const payloads: ReadonlyArray<PayloadCoverage> = [
    {
      key: 'IDX',
      label: 'IDX Payload',
      providerFields: idxFields,
      totalFields: allFields,
      providerPercent: pct(idxFields, allFields),
      industryPercent: 0,
      resourceCoverage: idxResourceCoverage,
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
