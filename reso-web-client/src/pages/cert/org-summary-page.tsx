/**
 * Public Org Summary page.
 *
 * Reached from the Organizations directory ("View Summary") and from
 * the Endorsements list (org header click). The page's job is the
 * exec-readable answer to "is this org healthy and how do they
 * compare to peers" — synthesized health, coverage section, performance
 * section, then the org's endorsement portfolio, then identity.
 *
 * Data sources:
 *   - Identity + endorsement portfolio: services.reso.org/orgs via
 *     useOrganizations() (already cached).
 *   - Coverage + performance analytics: fixture lookup keyed by UOI
 *     (org-summary-fixtures.ts) until the cert API exposes a per-org
 *     analytics endpoint. Orgs without an entry render an empty-state
 *     placeholder so the page is always honest about what it knows.
 *
 * Header chrome is duplicated from CertHomePage. When the third
 * public Cert page lands, extract a CertLayout.
 */

import { useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router';
// NavLink is still used in the NotFoundState component below
import {
  type CoverageReport,
  type FieldCut,
  type OrgSummaryData,
  type PayloadCoverage,
  type PerformanceReport,
  type ResourceCoverage
} from '../../api/org-summary-fixtures';
import { summaryToCoverageReport } from '../../api/cert-summary-adapter';
import { useCertReportSummary } from '../../hooks/use-cert-report-summary';
import { useMarketAverages } from '../../hooks/use-market-averages';
import { useDAMarketAverage } from '../../hooks/use-da-market-average';
import type { CertReportSummary, MarketAverages, PerformanceMetricsReport, ResourcePerformanceStats } from '../../api/cert-client';
import { usePerformanceMetrics } from '../../hooks/use-performance-metrics';
import type { Endorsement, EndorsementStatus, EndorsementType } from '../../api/cert-fixtures';
import { EndorsementSubRow } from '../../components/cert/endorsement-sub-row';
import { useCertOrgDetail } from '../../hooks/use-cert-org-detail';
import { useEndorsements } from '../../hooks/use-endorsements';
import { useOrganizationNames } from '../../hooks/use-organization-names';
import type { ResoEndorsement, ResoOrganization } from '../../types';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

// ── Adapters ─────────────────────────────────────────────────────────────

/** Map the services.reso.org endorsement type label to our enum. */
const TYPE_KEY: Record<string, EndorsementType> = {
  'Data Dictionary': 'data_dictionary',
  'Web API Server Core': 'web_api_server_core',
  'Web API Core': 'web_api_server_core',
  'Add/Edit': 'add_edit',
  'Entity Event': 'entity_event',
  'RESO Common Format': 'reso_common_format',
  Webhooks: 'webhooks'
};

/** Map the services.reso.org status label to our enum. Falls back to
 *  'certified' for the common case where Status is "Certified Current" or
 *  similar — we treat any unmatched-but-non-empty value as certified to
 *  avoid showing rows as broken. */
const STATUS_KEY: Record<string, EndorsementStatus> = {
  'Certified Current': 'certified',
  Certified: 'certified',
  'In Progress': 'in_progress',
  'In Review': 'in_review',
  'Recipient Notified': 'recipient_notified',
  Passed: 'passed',
  Failed: 'failed',
  Canceled: 'canceled',
  Withdrawn: 'withdrawn',
  Revoked: 'revoked',
  Legacy: 'legacy'
};

/** Known resource keys to skip when extracting per-resource perf stats. */
const PERF_META_KEYS = new Set([
  'reportId', 'type', 'version', 'description', 'generatedOn',
  'recipientUoi', 'providerUoi', 'providerUsi', 'optInStatus', 'opted_in',
  'averageResponseTimeMillis', 'averageBandwidth', 'averageResponseBytes',
]);

/** Convert API performance metrics to the PerformanceReport shape the summary page renders. Exported for testing. */
export const perfMetricsToSummary = (
  data: PerformanceMetricsReport,
  ddReport: CertReportSummary | null
): PerformanceReport => {
  const perf = data.performanceReport;
  const market = data.marketAverage;
  const optedIn = perf.opted_in;

  // Find the Property resource stats for the headline number
  const propertyStats = optedIn
    ? Object.entries(perf).find(
        ([key, val]) => !PERF_META_KEYS.has(key) && key === 'Property' && typeof val === 'object' && val !== null
      )?.[1] as ResourcePerformanceStats | undefined
    : undefined;

  // Compute seconds per 1,000 records from Property resource (or overall avg)
  const avgResponseMs = propertyStats?.averageResponseTimeMs ?? perf.averageResponseTimeMillis;
  const pageSize = propertyStats?.pageSize ?? 200;
  const secPer1k = (avgResponseMs / 1000) * (1000 / pageSize);
  const industrySecPer1k = (market.averageResponseTimeMillis / 1000) * (1000 / pageSize);
  const delta = industrySecPer1k > 0 ? Math.round(((industrySecPer1k - secPer1k) / industrySecPer1k) * 100) : 0;

  const avgBytes = optedIn ? perf.averageResponseBytes : 0;
  const avgBw = optedIn ? perf.averageBandwidth : 0;

  const date = (ddReport?.statusUpdatedAt || ddReport?.generatedOn || perf.generatedOn) ?? '';

  return {
    typeLabel: 'Data Dictionary',
    version: ddReport?.version ?? perf.version,
    date: date ? date.split('T')[0] : '',
    secPer1k: optedIn ? secPer1k : 0,
    industrySecPer1k,
    deltaPercent: optedIn ? delta : 0,
    payloadMb: avgBytes / (1024 * 1024),
    industryPayloadMb: market.averageResponseBytes / (1024 * 1024),
    responseS: avgResponseMs / 1000,
    industryResponseS: market.averageResponseTimeMillis / 1000,
    throughputMbS: avgBw / 1024,
    industryThroughputMbS: market.averageBandwidth / 1024,
    optedOut: !optedIn,
  };
};

const adaptEndorsement = (
  e: ResoEndorsement,
  org: ResoOrganization
): Endorsement => ({
  id: `${org.OrganizationUniqueId}-${e.Endorsement}-${e.Version}-${e.ProviderUoi}`,
  type: TYPE_KEY[e.Endorsement] ?? 'data_dictionary',
  typeLabel: e.Endorsement,
  version: e.Version,
  status: STATUS_KEY[e.Status] ?? 'certified',
  providerUoi: e.ProviderUoi,
  providerName: e.ProviderUoi,
  recipientUoi: org.OrganizationUniqueId,
  recipientName: org.OrganizationName,
  statusTimestamp: e.StatusUpdatedAt,
  local: false
});

// ── Page ─────────────────────────────────────────────────────────────────

export const OrgSummaryPage = () => {
  const { uoi } = useParams<{ readonly uoi: string }>();
  const { org, isLoading, error } = useCertOrgDetail(uoi);
  const { reports: certReports, isLoading: isLoadingReports } = useCertReportSummary(uoi);
  const { averages: marketAverages } = useMarketAverages();

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className={`${PAGE_CONTAINER} pt-4 pb-20`}>
        {isLoading && !org && <LoadingState />}
        {!isLoading && error && <ErrorState message={error} />}
        {!isLoading && !error && !org && <NotFoundState uoi={uoi ?? ''} />}
        {org && (
          <OrgSummaryBody
            org={org}
            certReports={certReports}
            isLoadingReports={isLoadingReports}
            marketAverages={marketAverages}
          />
        )}
      </div>
    </div>
  );
};

// ── Body ─────────────────────────────────────────────────────────────────

interface OrgSummaryBodyProps {
  readonly org: ResoOrganization;
  readonly certReports: ReadonlyArray<CertReportSummary>;
  readonly isLoadingReports?: boolean;
  readonly marketAverages?: MarketAverages | null;
}

const OrgSummaryBody = ({ org, certReports, isLoadingReports, marketAverages }: OrgSummaryBodyProps) => {
  // Load endorsements from the cert reports API, scoped to this org
  // by searching on the org name. This gives us the provider/system
  // info on each endorsement that powers the Shape A switcher.
  const { endorsements: rawEndorsements, isLoadingInitial } = useEndorsements({
    searchKey: org.OrganizationName,
    sortByTimestamp: false,
    sortBy: 'asc'
  });

  // Resolve human-readable provider and system names
  const { lookup: lookupOrgName, lookupSystem } = useOrganizationNames();

  const endorsements = useMemo<ReadonlyArray<Endorsement>>(
    () =>
      rawEndorsements
        .filter((e) => e.recipientUoi === org.OrganizationUniqueId)
        .map((e) => ({
          ...e,
          recipientName: lookupOrgName(e.recipientUoi) ?? e.recipientName ?? e.recipientUoi,
          providerName: lookupOrgName(e.providerUoi) ?? e.providerName ?? e.providerUoi,
          systemName: lookupSystem(e.providerUoi, e.providerUsi) ?? e.systemName
        }))
        .sort((a, b) =>
          a.typeLabel.localeCompare(b.typeLabel)
          || a.version.localeCompare(b.version)
          || a.providerName.localeCompare(b.providerName)
          || (a.systemName ?? '').localeCompare(b.systemName ?? '')
        ),
    [rawEndorsements, org.OrganizationUniqueId, lookupOrgName, lookupSystem]
  );

  // ── Shape A: group by provider ──────────────────────────────────
  //
  // A "provider" is a unique providerUoi + system name pair. Most
  // orgs have one provider; ~30% have two or more. The switcher
  // only renders when there are multiple providers.

  interface ProviderGroup {
    readonly key: string;
    readonly providerUoi: string;
    readonly providerName: string;
    readonly systemName: string;
    readonly endorsements: ReadonlyArray<Endorsement>;
  }

  const providerGroups = useMemo<ReadonlyArray<ProviderGroup>>(() => {
    const groups = new Map<string, ProviderGroup & { endorsements: Endorsement[] }>();
    for (const e of endorsements) {
      const key = `${e.providerUoi}:${e.providerUsi ?? ''}`;
      const existing = groups.get(key);
      if (existing) {
        existing.endorsements.push(e);
      } else {
        groups.set(key, {
          key,
          providerUoi: e.providerUoi,
          providerName: e.providerName ?? e.providerUoi,
          systemName: e.systemName ?? '',
          endorsements: [e]
        });
      }
    }
    return Array.from(groups.values());
  }, [endorsements]);

  const hasMultipleProviders = providerGroups.length > 1;

  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(null);

  // Auto-select the first provider when data loads
  const activeProviderKey =
    selectedProviderKey ??
    (providerGroups.length > 0 ? providerGroups[0].key : null);

  const activeGroup = providerGroups.find((g) => g.key === activeProviderKey) ?? null;

  // The selected provider's DD cert report drives the coverage and
  // performance sections. Find the most recent DD summary report
  // for the active provider, then convert its `advertised` data
  // into the CoverageReport shape the page renders.
  const activeDdSummary = useMemo<CertReportSummary | null>(() => {
    if (!activeGroup) return null;
    const ddSummaries = certReports
      .filter(
        (r) =>
          r.type === 'data_dictionary' &&
          r.providerUoi === activeGroup.providerUoi &&
          (r.providerUsi === activeGroup.endorsements[0]?.providerUsi || !r.providerUsi)
      )
      .sort((a, b) =>
        new Date(b.statusUpdatedAt ?? b.generatedOn).getTime() -
        new Date(a.statusUpdatedAt ?? a.generatedOn).getTime()
      );
    return ddSummaries[0] ?? null;
  }, [activeGroup, certReports]);

  // Fetch per-resource DA market averages using the active DD report ID
  const daReportIds = useMemo(
    () => (activeDdSummary ? [activeDdSummary.id] : undefined),
    [activeDdSummary?.id]
  );
  const { data: daMarketAvg, isLoading: isLoadingDA } = useDAMarketAverage(daReportIds);

  const activeCoverage = useMemo<CoverageReport | null>(
    () => (activeDdSummary ? summaryToCoverageReport(activeDdSummary, marketAverages, daMarketAvg) : null),
    [activeDdSummary, marketAverages, daMarketAvg]
  );

  // Fetch performance metrics for the active DD report
  const { data: perfMetrics, isLoading: isLoadingPerf } = usePerformanceMetrics(activeDdSummary?.id);

  const activePerformance = useMemo<PerformanceReport | null>(() => {
    if (!perfMetrics) return null;
    try {
      return perfMetricsToSummary(perfMetrics, activeDdSummary);
    } catch {
      return null;
    }
  }, [perfMetrics, activeDdSummary]);

  const cityState = [
    org.OrganizationCity,
    org.OrganizationStateOrProvince
  ]
    .filter(Boolean)
    .join(', ');

  const fullAddress = [
    org.OrganizationAddress1,
    org.OrganizationCity,
    [org.OrganizationStateOrProvince, org.OrganizationPostalCode]
      .filter(Boolean)
      .join(' ')
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <>
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-1" aria-label="Breadcrumb">
        <NavLink to="/cert" className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Certification</NavLink>
        <svg className="w-3 h-3 text-gray-400 dark:text-gray-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 010-1.06l3.71-3.71-3.71-3.71a.75.75 0 111.06-1.06l4.24 4.24a.75.75 0 010 1.06l-4.24 4.24a.75.75 0 01-1.06 0z" clipRule="evenodd" />
        </svg>
        <span className="text-gray-700 dark:text-gray-300 font-medium truncate max-w-xs">{org.OrganizationName}</span>
      </nav>

      {/* Compact identity header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          <span>Organization</span>
          <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
          <span>{org.OrganizationType}</span>
          {cityState && (
            <>
              <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
              <span>{cityState}</span>
            </>
          )}
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-gray-50 leading-tight">
          {org.OrganizationName}
        </h1>
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <CopyableUoi uoi={org.OrganizationUniqueId} />
          {org.OrganizationWebsite && (
            <a
              href={
                org.OrganizationWebsite.startsWith('http')
                  ? org.OrganizationWebsite
                  : `https://${org.OrganizationWebsite}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              {org.OrganizationWebsite.replace(/^https?:\/\//, '')}
            </a>
          )}
        </div>
      </div>

      {/* Provider switcher — sits above coverage and performance
          because it controls which DD report drives those sections.
          Only renders when there are 2+ providers for this org. */}
      {hasMultipleProviders && (
        <div className="mt-8 mb-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
            Provider
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {providerGroups.map((g) => {
              const isActive = g.key === activeProviderKey;
              return (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setSelectedProviderKey(g.key)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                  }`}
                >
                  <span>{g.providerName}</span>
                  {g.systemName && (
                    <span className={isActive ? 'text-blue-200' : 'text-gray-400 dark:text-gray-500'}>
                      / {g.systemName}
                    </span>
                  )}
                  <span
                    className={`ml-1 inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold ${
                      isActive
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    }`}
                  >
                    {g.endorsements.length}
                  </span>
                </button>
              );
            })}
            {activeDdSummary && (
              <NavLink
                to={`/cert/orgs/${encodeURIComponent(org.OrganizationUniqueId)}/detail/${encodeURIComponent(activeDdSummary.id)}`}
                className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors cursor-pointer"
              >
                View Details
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638l-3.96-4.158a.75.75 0 011.08-1.04l5.25 5.5a.75.75 0 010 1.04l-5.25 5.5a.75.75 0 11-1.08-1.04l3.96-4.158H3.75A.75.75 0 013 10z" clipRule="evenodd" />
                </svg>
              </NavLink>
            )}
          </div>
        </div>
      )}
      {/* View Details link for single-provider orgs (no switcher) */}
      {!hasMultipleProviders && activeDdSummary && (
        <div className="mt-8 mb-2 flex justify-end">
          <NavLink
            to={`/cert/orgs/${encodeURIComponent(org.OrganizationUniqueId)}/detail/${encodeURIComponent(activeDdSummary.id)}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors cursor-pointer"
          >
            View Details
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638l-3.96-4.158a.75.75 0 011.08-1.04l5.25 5.5a.75.75 0 010 1.04l-5.25 5.5a.75.75 0 11-1.08-1.04l3.96-4.158H3.75A.75.75 0 013 10z" clipRule="evenodd" />
            </svg>
          </NavLink>
        </div>
      )}

      {/* Provider context moved into Coverage section header */}

      {/* Coverage — driven by the selected provider's DD report,
          now from real cert API data via the summary endpoint. */}
      <CoverageSectionView
        coverage={activeCoverage}
        isLoading={isLoadingReports || isLoadingDA}
        providerName={activeGroup?.providerName}
        systemName={activeGroup?.systemName}
      />

      {/* Performance — from DD report's performance metrics endpoint */}
      <PerformanceSectionView performance={activePerformance} />

      {/* Endorsements — ALL endorsements for this org, ALL providers,
          always visible. The provider switcher above does NOT filter
          this list. */}
      <section className="mt-14">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Endorsements
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {endorsements.length}{' '}
            {endorsements.length === 1 ? 'endorsement' : 'endorsements'}
          </p>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Click any endorsement for the full report.
        </p>

        {isLoadingInitial ? (
          <div className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            Loading endorsements…
          </div>
        ) : endorsements.length > 0 ? (
          <article className="bg-white dark:bg-gray-800/70 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden divide-y divide-gray-200 dark:divide-gray-700">
            {endorsements.map((e) => (
              <EndorsementSubRow key={e.id} endorsement={e} />
            ))}
          </article>
        ) : (
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No endorsements recorded for this organization.
          </div>
        )}
      </section>

      {/* About */}
      <section className="mt-16 pt-10 border-t border-gray-200 dark:border-gray-800">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-5">
          About this organization
        </h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-5">
          <AboutCell label="Type" value={org.OrganizationType} />
          {/* Member count removed — cert API value is stale for some orgs
              (reso-certification#2540). Available on the Organizations page
              via the services.reso.org feed which is authoritative. */}
          <AboutCell
            label="Address"
            value={fullAddress || '—'}
            wide
          />
          <AboutCell
            label="Website"
            value={
              org.OrganizationWebsite ? (
                <a
                  href={
                    org.OrganizationWebsite.startsWith('http')
                      ? org.OrganizationWebsite
                      : `https://${org.OrganizationWebsite}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  View Website
                </a>
              ) : (
                '—'
              )
            }
          />
          <AboutCell
            label="UOI"
            value={
              <span className="font-mono">{org.OrganizationUniqueId}</span>
            }
          />
        </dl>
      </section>
    </>
  );
};

// ── Synthesis line ───────────────────────────────────────────────────────

const SynthesisLine = ({ summary }: { readonly summary: OrgSummaryData }) => (
  <p className="mt-7 text-lg sm:text-xl leading-snug text-gray-700 dark:text-gray-300 max-w-4xl">
    <span className="inline-flex items-center gap-1.5 align-middle">
      <svg
        className="w-5 h-5 text-emerald-600 dark:text-emerald-400 inline"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.414 0z"
          clipRule="evenodd"
        />
      </svg>
      <span className="font-semibold text-emerald-700 dark:text-emerald-400">
        {summary.synthesisLabel}
      </span>
    </span>{' '}
    in{' '}
    <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">
      {summary.certifiedActive} of {summary.totalActive}
    </span>{' '}
    active endorsements · most recent run{' '}
    <span className="font-semibold text-gray-900 dark:text-gray-100">
      {summary.lastRunLabel}
    </span>
    .
  </p>
);

// ── Coverage section ─────────────────────────────────────────────────────

const CoverageSectionView = ({
  coverage,
  isLoading,
  providerName,
  systemName
}: {
  readonly coverage: CoverageReport | null;
  readonly isLoading?: boolean;
  readonly providerName?: string;
  readonly systemName?: string;
}) => (
  <section className="mt-4">
    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
        Coverage
      </h2>
      {coverage && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {coverage.typeLabel} {coverage.version}
            {providerName && ` · ${providerName}`}
            {systemName && ` / ${systemName}`}
            {coverage.date && ` · ${coverage.date}`}
          </p>
          {coverage.date && new Date(coverage.date).getTime() < Date.now() - 2 * 365.25 * 86_400_000 && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-b border-dashed border-amber-400 dark:border-amber-500 cursor-help"
              title="RESO endorsements are valid for two years from the date of certification. Endorsements older than two years will transition to Legacy status and will need to be renewed to remain current. This update is part of RESO's versioning policy, which helps ensure that certified implementations reflect the latest standards."
            >
              Expiring Soon
            </span>
          )}
        </div>
      )}
    </div>
    <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
      How much of the standard data dictionary is actually populated in this
      provider's payloads, compared to the industry average. Higher means more
      fields and enumerations carry data that consumers can rely on.
    </p>

    {isLoading && !coverage ? (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5 animate-pulse">
            <div className="h-3 w-24 bg-gray-200 dark:bg-gray-700 rounded mb-4" />
            <div className="h-10 w-20 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
            <div className="h-2 w-32 bg-gray-100 dark:bg-gray-800 rounded" />
          </div>
        ))}
      </div>
    ) : coverage ? (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
          {coverage.fieldCuts.map((c) => (
            <FieldCutTile key={c.key} cut={c} />
          ))}
        </div>
        <div className="space-y-6">
          {coverage.payloads.map((p) => (
            <PayloadCard key={p.key} payload={p} />
          ))}
        </div>
      </>
    ) : (
      <EmptyAnalyticsState section="coverage" />
    )}
  </section>
);

const FieldCutTile = ({ cut }: { readonly cut: FieldCut }) => {
  if (cut.isCount) {
    const above = cut.providerCount >= cut.industryAvgCount;
    const hasIndustry = cut.industryAvgCount > 0;
    const numberColor = hasIndustry && above
      ? 'text-emerald-700 dark:text-emerald-400'
      : hasIndustry
        ? 'text-gray-900 dark:text-gray-50'
        : 'text-gray-900 dark:text-gray-50';
    const ringClass = hasIndustry && above
      ? 'ring-1 ring-emerald-200 dark:ring-emerald-900/50'
      : '';
    return (
      <div className={`bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5 ${ringClass}`}>
        <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {cut.label}
        </p>
        <p className="mt-2 flex items-baseline gap-1.5">
          <span className={`text-4xl font-bold tabular-nums ${numberColor}`}>
            {cut.providerCount.toLocaleString()}
          </span>
          {hasIndustry && (above ? <AboveIndustryPill /> : <BelowIndustryPill />)}
        </p>
        {cut.subtitle && (
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{cut.subtitle}</p>
        )}
        {hasIndustry && (() => {
          const maxVal = Math.max(cut.providerCount, cut.industryAvgCount, 1);
          return (
          <>
            <ComparisonBar
              providerPercent={Math.round((cut.providerCount / maxVal) * 100)}
              industryPercent={Math.round((cut.industryAvgCount / maxVal) * 100)}
              above={above}
            />
            <p className="mt-2 text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
              Industry avg: {cut.industryAvgCount.toLocaleString()}
            </p>
          </>
          );
        })()}
      </div>
    );
  }
  const delta = cut.providerPercent - cut.industryPercent;
  const above = delta >= 0;
  const ringClass =
    cut.motivational && above
      ? 'ring-1 ring-emerald-200 dark:ring-emerald-900/50'
      : '';
  const numberColor =
    cut.motivational && above
      ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-gray-900 dark:text-gray-50';
  const sign = above ? '+' : '';
  return (
    <div
      className={`bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5 ${ringClass}`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {cut.label}
      </p>
      <p className="mt-2 flex items-baseline gap-1.5">
        <span className={`text-4xl font-bold tabular-nums ${numberColor}`}>
          {cut.providerPercent}
          <span className="text-xl text-gray-400 dark:text-gray-500 font-semibold">
            %
          </span>
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
          {cut.providerCount.toLocaleString()} /{' '}
          {cut.totalCount.toLocaleString()}
        </span>
        {above ? <AboveIndustryPill /> : <BelowIndustryPill />}
      </p>
      <ComparisonBar
        providerPercent={cut.providerPercent}
        industryPercent={cut.industryPercent}
        above={above}
      />
      <p className="mt-2 text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
        {sign}
        {delta}{' '}
        <span className="border-b border-dashed border-gray-400 dark:border-gray-500 cursor-help" title="Percentage points above or below the industry average">
          pts
        </span>{' '}
        vs industry avg ({cut.industryPercent}%)
      </p>
    </div>
  );
};

const PayloadCard = ({ payload }: { readonly payload: PayloadCoverage }) => {
  const delta = payload.providerPercent - payload.industryPercent;
  const above = delta >= 0;
  const sign = above ? '+' : '';
  const deltaColor = above
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-amber-600 dark:text-amber-400';
  return (
    <article className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <header className="px-6 py-5 flex items-end justify-between gap-6 flex-wrap border-b border-gray-100 dark:border-gray-700/60">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {payload.label}
          </p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-5xl font-bold tabular-nums text-gray-900 dark:text-gray-50">
              {payload.providerPercent}
              <span className="text-2xl text-gray-400 dark:text-gray-500 font-semibold">
                %
              </span>
            </span>
            <span className="text-sm text-gray-500 dark:text-gray-400 tabular-nums">
              {payload.providerFields.toLocaleString()} of {payload.totalFields.toLocaleString()} fields
            </span>
          </p>
          <p className={`mt-1 text-xs font-medium tabular-nums ${deltaColor}`}>
            {sign}
            {delta}{' '}
            <span className="border-b border-dashed border-gray-400 dark:border-gray-500 cursor-help" title="Percentage points above or below the industry average">
              pts
            </span>{' '}
            vs industry average ({payload.industryPercent}%)
          </p>
        </div>
        <div className="w-full sm:w-72">
          <ComparisonBar
            providerPercent={payload.providerPercent}
            industryPercent={payload.industryPercent}
            above={above}
            tall
          />
          <div className="mt-1.5 flex justify-between text-[10px] text-gray-400 dark:text-gray-500 tabular-nums">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>
      </header>
      <div className="px-6 py-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
          Key resources
        </p>
        <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
          {payload.resourceCoverage.map((r) => (
            <ResourceRow key={r.resource} row={r} />
          ))}
        </ul>
      </div>
    </article>
  );
};

const ResourceRow = ({ row }: { readonly row: ResourceCoverage }) => {
  const hasIndustry = row.industryPercent > 0;
  const maxVal = Math.max(row.providerPercent, row.industryPercent, row.providerAdvertised ?? 0, 1);
  const provBarWidth = Math.round((row.providerPercent / maxVal) * 100);
  const advBarWidth = row.providerAdvertised ? Math.round((row.providerAdvertised / maxVal) * 100) : 0;
  const above = !hasIndustry || row.providerPercent >= row.industryPercent;
  const barColor = above
    ? 'bg-emerald-500 dark:bg-emerald-400'
    : 'bg-amber-500 dark:bg-amber-400';
  return (
    <li className="flex items-center gap-4 py-3">
      <div className="w-32 shrink-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {row.resource}
        </p>
      </div>
      <div className="flex-1 min-w-0">
        <div className="relative h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-visible">
          {/* Advertised bar (track) */}
          {advBarWidth > 0 && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gray-300 dark:bg-gray-600"
              style={{ width: `${advBarWidth}%` }}
            />
          )}
          {/* Available bar (fill) */}
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${barColor}`}
            style={{ width: `${provBarWidth}%` }}
          />
          {/* Industry average marker */}
          {hasIndustry && (
            <div
              className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-gray-500 dark:bg-gray-300 cursor-help"
              style={{ left: `${Math.round((row.industryPercent / maxVal) * 100)}%` }}
              title={`Industry average: ${Math.round(row.industryPercent).toLocaleString()} fields with data`}
            />
          )}
        </div>
      </div>
      <div className="w-36 shrink-0 text-right">
        <p className="text-sm tabular-nums text-gray-900 dark:text-gray-100">
          <span className="font-semibold">{Math.round(row.providerPercent).toLocaleString()}</span>
          {row.providerAdvertised !== undefined && (
            <span className="text-gray-400 dark:text-gray-500"> / {Math.round(row.providerAdvertised).toLocaleString()}</span>
          )}
        </p>
        {hasIndustry && (
          <p className="text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
            Industry avg: {Math.round(row.industryPercent).toLocaleString()}
          </p>
        )}
      </div>
    </li>
  );
};

// ── Performance section ──────────────────────────────────────────────────

const PerformanceSectionView = ({
  performance
}: {
  readonly performance: PerformanceReport | null;
}) => (
  <section className="mt-14">
    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
        Performance
      </h2>
      {performance && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          From {performance.typeLabel} {performance.version} report ·{' '}
          {performance.date}
        </p>
      )}
    </div>
    <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
      How fast this provider delivers data, compared to the industry average.
    </p>

    {performance ? (
      performance.optedOut ? (
        <PerformanceOptedOut perf={performance} />
      ) : (
        <PerformanceVisible perf={performance} />
      )
    ) : (
      <EmptyAnalyticsState section="performance" />
    )}
  </section>
);

const PerformanceVisible = ({ perf }: { readonly perf: PerformanceReport }) => {
  const payloadDelta = perf.industryPayloadMb - perf.payloadMb;
  const responseDelta = perf.industryResponseS - perf.responseS;
  const throughputDelta = perf.throughputMbS - perf.industryThroughputMbS;

  return (
    <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
      <div className="flex items-end justify-between gap-6 flex-wrap">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Replication speed (per 1,000 records)
          </p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-5xl font-bold tabular-nums text-gray-900 dark:text-gray-50">
              {perf.secPer1k.toFixed(2)}
              <span className="text-2xl text-gray-400 dark:text-gray-500 font-semibold">
                s
              </span>
            </span>
          </p>
          <p className={`mt-1 text-xs font-medium tabular-nums ${perf.deltaPercent >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
            {perf.deltaPercent >= 0
              ? `${perf.deltaPercent}% faster than industry average (${perf.industrySecPer1k.toFixed(2)}s)`
              : `${Math.abs(perf.deltaPercent)}% slower than industry average (${perf.industrySecPer1k.toFixed(2)}s)`}
          </p>
        </div>
        <div className="border-l border-gray-200 dark:border-gray-700 pl-6">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Industry average
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-gray-700 dark:text-gray-300">
            {perf.industrySecPer1k.toFixed(2)}
            <span className="text-base text-gray-400 dark:text-gray-500 font-medium ml-0.5">
              s
            </span>
          </p>
        </div>
      </div>
      <div className="mt-6 pt-5 border-t border-gray-100 dark:border-gray-700/60 grid grid-cols-1 sm:grid-cols-3 gap-6">
        <PerfMetric
          label="Avg payload"
          value={perf.payloadMb.toFixed(2)}
          unit="MB"
          industry={`${perf.industryPayloadMb.toFixed(2)} MB`}
          delta={payloadDelta > 0 ? `${payloadDelta.toFixed(2)} MB smaller` : payloadDelta < 0 ? `${Math.abs(payloadDelta).toFixed(2)} MB larger` : undefined}
          deltaPositive={payloadDelta < 0}
        />
        <PerfMetric
          label="Avg response"
          value={perf.responseS.toFixed(2)}
          unit="s"
          industry={`${perf.industryResponseS.toFixed(2)} s`}
          delta={responseDelta > 0 ? `${responseDelta.toFixed(2)}s faster` : responseDelta < 0 ? `${Math.abs(responseDelta).toFixed(2)}s slower` : undefined}
          deltaPositive={responseDelta > 0}
        />
        <PerfMetric
          label="Throughput"
          value={perf.throughputMbS.toFixed(2)}
          unit="MB/s"
          industry={`${perf.industryThroughputMbS.toFixed(2)} MB/s`}
          delta={throughputDelta > 0 ? `${throughputDelta.toFixed(2)} MB/s faster` : throughputDelta < 0 ? `${Math.abs(throughputDelta).toFixed(2)} MB/s slower` : undefined}
          deltaPositive={throughputDelta > 0}
        />
      </div>
    </div>
  );
};

const PerformanceOptedOut = ({
  perf
}: {
  readonly perf: PerformanceReport;
}) => (
  <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
    <div className="flex items-end justify-between gap-6 flex-wrap">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Replication speed (per 1,000 records)
        </p>
        <p className="mt-1 flex items-baseline gap-2">
          <span className="text-5xl font-bold tabular-nums text-gray-300 dark:text-gray-600">
            N/A
          </span>
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Provider has opted out of publishing performance metrics
        </p>
      </div>
      <div className="border-l border-gray-200 dark:border-gray-700 pl-6">
        <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Industry average
        </p>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {perf.industrySecPer1k.toFixed(2)}
          <span className="text-base text-gray-400 dark:text-gray-500 font-medium ml-0.5">
            s
          </span>
        </p>
      </div>
    </div>
    <div className="mt-6 pt-5 border-t border-gray-100 dark:border-gray-700/60 grid grid-cols-1 sm:grid-cols-3 gap-6">
      <PerfMetric
        label="Avg payload"
        value="N/A"
        unit=""
        industry={`${perf.industryPayloadMb.toFixed(2)} MB`}
      />
      <PerfMetric
        label="Avg response"
        value="N/A"
        unit=""
        industry={`${perf.industryResponseS.toFixed(2)} s`}
      />
      <PerfMetric
        label="Throughput"
        value="N/A"
        unit=""
        industry={`${perf.industryThroughputMbS.toFixed(2)} MB/s`}
      />
    </div>
  </div>
);

const PerfMetric = ({
  label,
  value,
  unit,
  industry,
  delta,
  deltaPositive,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly industry: string;
  readonly delta?: string;
  readonly deltaPositive?: boolean;
}) => (
  <div>
    <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
      {label}
    </p>
    <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
      {value}
      {unit && (
        <span className="text-sm text-gray-400 dark:text-gray-500 font-medium ml-0.5">
          {' '}{unit}
        </span>
      )}
    </p>
    <p className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
      Industry: {industry}
    </p>
    {delta && (
      <p className={`text-[11px] font-medium tabular-nums mt-0.5 ${deltaPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
        {delta}
      </p>
    )}
  </div>
);

// ── Atoms ────────────────────────────────────────────────────────────────

const ComparisonBar = ({
  providerPercent,
  industryPercent,
  above,
  tall
}: {
  readonly providerPercent: number;
  readonly industryPercent: number;
  readonly above: boolean;
  readonly tall?: boolean;
}) => {
  const fillColor = above
    ? 'bg-emerald-500 dark:bg-emerald-400'
    : 'bg-amber-500 dark:bg-amber-400';
  const heightClass = tall ? 'h-2.5' : 'h-1.5';
  return (
    <div
      className={`mt-3 relative ${heightClass} bg-gray-100 dark:bg-gray-700 rounded-full overflow-visible`}
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-full ${fillColor}`}
        style={{ width: `${providerPercent}%` }}
      />
      <div
        className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-gray-500 dark:bg-gray-300"
        style={{ left: `${industryPercent}%` }}
        title={`Industry avg ${industryPercent}%`}
      />
    </div>
  );
};

const AboveIndustryPill = () => (
  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
    <svg className="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
    Above industry
  </span>
);

const BelowIndustryPill = () => (
  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
    Below industry
  </span>
);

const CopyableUoi = ({ uoi }: { readonly uoi: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(uoi).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={copied ? 'Copied!' : `Copy ${uoi}`}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-mono text-[11px] uppercase tracking-wider bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
    >
      {uoi}
      {copied ? (
        <svg className="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3 h-3 opacity-60" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M7 3a1 1 0 011-1h7a1 1 0 011 1v10a1 1 0 01-1 1h-2v2a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h2V3zm2 4h4v6H9V7z" />
        </svg>
      )}
    </button>
  );
};

const AboutCell = ({
  label,
  value,
  wide
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly wide?: boolean;
}) => (
  <div className={wide ? 'sm:col-span-2' : ''}>
    <dt className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
      {label}
    </dt>
    <dd className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
      {value}
    </dd>
  </div>
);

// ── States ───────────────────────────────────────────────────────────────

const LoadingState = () => (
  <div className="py-24 text-center text-sm text-gray-400 dark:text-gray-500">
    Loading organization…
  </div>
);

const ErrorState = ({ message }: { readonly message: string }) => (
  <div className="py-16 text-center">
    <p className="text-sm text-rose-600 dark:text-rose-400">{message}</p>
  </div>
);

const NotFoundState = ({ uoi }: { readonly uoi: string }) => (
  <div className="py-24 text-center">
    <p className="text-sm text-gray-500 dark:text-gray-400">
      No organization found with UOI{' '}
      <span className="font-mono">{uoi}</span>.
    </p>
    <NavLink
      to="/organizations"
      className="mt-3 inline-block text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
    >
      Browse all organizations →
    </NavLink>
  </div>
);

const EmptyAnalyticsState = ({
  section
}: {
  readonly section: 'coverage' | 'performance';
}) => (
  <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center">
    <p className="text-sm text-gray-500 dark:text-gray-400">
      {section === 'coverage' ? 'Coverage' : 'Performance'} analytics are not
      yet available for this organization.
    </p>
    <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
      Aggregated reports will appear here once this org's most recent
      certification run has been processed.
    </p>
  </div>
);
