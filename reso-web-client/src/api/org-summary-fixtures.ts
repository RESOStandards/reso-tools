/**
 * Fixture data for the public Org Summary page's coverage and
 * performance sections.
 *
 * The endorsements list at the bottom of the page comes from real
 * data (services.reso.org/orgs via useOrganizations), so this fixture
 * only covers the *analytics* the page renders above the list — the
 * field cuts, payloads, and performance metrics. Once the cert API
 * exposes a per-org analytics endpoint these shapes get adapted from
 * the wire response and this file is replaced.
 *
 * Keyed by OrganizationUniqueId. Orgs without an entry render the
 * empty-state placeholder defined in the page.
 */

export interface FieldCutPercent {
  readonly key: string;
  readonly label: string;
  readonly providerCount: number;
  readonly totalCount: number;
  readonly providerPercent: number;
  readonly industryPercent: number;
  /** Motivational tiles get the celebrated treatment when above industry. */
  readonly motivational?: boolean;
  readonly isCount?: false;
}

export interface FieldCutCount {
  readonly key: string;
  readonly label: string;
  readonly providerCount: number;
  readonly industryAvgCount: number;
  readonly isCount: true;
  /** Optional subtitle shown below the hero count (e.g., "out of 811 advertised"). */
  readonly subtitle?: string;
  /** When true, a lower count is the good outcome (e.g., Local Fields — fewer means more standardization). */
  readonly lowerIsBetter?: boolean;
}

export type FieldCut = FieldCutPercent | FieldCutCount;

export interface ResourceCoverage {
  readonly resource: string;
  /** Available count (fields with data) or provider percentage. */
  readonly providerPercent: number;
  /** Industry average available count or percentage. */
  readonly industryPercent: number;
  /** Advertised count (total fields in metadata). */
  readonly providerAdvertised?: number;
}

export interface PayloadCoverage {
  readonly key: string;
  readonly label: string;
  readonly providerFields: number;
  readonly totalFields: number;
  readonly providerPercent: number;
  readonly industryPercent: number;
  /** Per-resource breakdown for the resources this payload includes. */
  readonly resourceCoverage: ReadonlyArray<ResourceCoverage>;
}

export interface CoverageReport {
  /** Source label for the section header (e.g. "Data Dictionary 2.0"). */
  readonly typeLabel: string;
  readonly version: string;
  readonly date: string;
  readonly fieldCuts: ReadonlyArray<FieldCut>;
  readonly payloads: ReadonlyArray<PayloadCoverage>;
}

export interface PerformanceReport {
  readonly typeLabel: string;
  readonly version: string;
  readonly date: string;
  readonly secPer1k: number;
  readonly industrySecPer1k: number;
  readonly deltaPercent: number;
  readonly payloadMb: number;
  readonly industryPayloadMb: number;
  readonly responseS: number;
  readonly industryResponseS: number;
  readonly throughputMbS: number;
  readonly industryThroughputMbS: number;
  /** Provider has opted out of publishing perf metrics publicly. */
  readonly optedOut: boolean;
}

export interface OrgSummaryData {
  readonly synthesisLabel: 'Certified Current' | 'In Progress' | 'Not Certified';
  readonly certifiedActive: number;
  readonly totalActive: number;
  readonly lastRunLabel: string;
  readonly coverage: CoverageReport | null;
  readonly performance: PerformanceReport | null;
}

/**
 * Top resources used by every payload's resourceCoverage list.
 * Derived from industry aggregates: the 5 most-used resources across
 * the cohort. In the real system this is computed by analytics, not
 * hand-authored.
 */
export const TOP_RESOURCES: ReadonlyArray<string> = [
  'Property',
  'Member',
  'Office',
  'Media',
  'OpenHouse'
];

const ABERDEEN_M00000570: OrgSummaryData = {
  synthesisLabel: 'Certified Current',
  certifiedActive: 3,
  totalActive: 3,
  lastRunLabel: '6 months ago',
  coverage: {
    typeLabel: 'Data Dictionary',
    version: '2.0',
    date: '2025-09-24',
    fieldCuts: [
      {
        key: 'all',
        label: 'All fields available',
        providerCount: 525,
        totalCount: 700,
        providerPercent: 75,
        industryPercent: 64
      },
      {
        key: 'reso-fields',
        label: 'RESO standard fields',
        providerCount: 487,
        totalCount: 625,
        providerPercent: 78,
        industryPercent: 67,
        motivational: true
      },
      {
        key: 'reso-enums',
        label: 'RESO enumerations',
        providerCount: 96,
        totalCount: 142,
        providerPercent: 68,
        industryPercent: 71,
        motivational: true
      },
      {
        key: 'local',
        label: 'Local fields',
        providerCount: 38,
        industryAvgCount: 22,
        isCount: true
      }
    ],
    payloads: [
      {
        key: 'IDX',
        label: 'IDX Payload',
        providerFields: 130,
        totalFields: 251,
        providerPercent: 61,
        industryPercent: 52,
        // Office is intentionally below industry to demo the
        // call-out treatment alongside the reward treatment.
        resourceCoverage: [
          { resource: 'Property',  providerPercent: 87, industryPercent: 78 },
          { resource: 'Member',    providerPercent: 72, industryPercent: 65 },
          { resource: 'Office',    providerPercent: 56, industryPercent: 64 },
          { resource: 'Media',     providerPercent: 91, industryPercent: 80 },
          { resource: 'OpenHouse', providerPercent: 45, industryPercent: 38 }
        ]
      }
    ]
  },
  performance: {
    typeLabel: 'Web API Server Core',
    version: '2.0.0',
    date: '2025-09-24',
    secPer1k: 0.88,
    industrySecPer1k: 1.10,
    deltaPercent: 20,
    payloadMb: 0.34,
    industryPayloadMb: 3.40,
    responseS: 0.88,
    industryResponseS: 2.95,
    throughputMbS: 0.30,
    industryThroughputMbS: 2.00,
    optedOut: false
  }
};

const SUMMARY_FIXTURES: Readonly<Record<string, OrgSummaryData>> = {
  M00000570: ABERDEEN_M00000570
};

/**
 * Look up the coverage / performance fixture for an org. Returns null
 * for orgs we have not authored fixture data for — the page renders
 * an empty-state placeholder in that case.
 */
export const getOrgSummaryFixture = (uoi: string): OrgSummaryData | null =>
  SUMMARY_FIXTURES[uoi] ?? null;
