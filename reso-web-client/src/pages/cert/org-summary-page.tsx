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
import type { CertReportSummary } from '../../api/cert-client';
import type { Endorsement, EndorsementStatus, EndorsementType } from '../../api/cert-fixtures';
import { AuthPill } from '../../components/cert/auth-pill';
import { EndorsementSubRow } from '../../components/cert/endorsement-sub-row';
import { useDarkMode } from '../../hooks/use-dark-mode';
import { useCertOrgDetail } from '../../hooks/use-cert-org-detail';
import { useEndorsements } from '../../hooks/use-endorsements';
import { useOrganizationNames } from '../../hooks/use-organization-names';
import type { ResoEndorsement, ResoOrganization } from '../../types';

const LOGO_LIGHT =
  'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_Blue.png';
const LOGO_DARK =
  'https://www.reso.org/wp-content/uploads/2020/06/RESO-Logo_Horizontal_White.png';

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
  const { isDark, toggle } = useDarkMode();
  const { org, isLoading, error } = useCertOrgDetail(uoi);
  const { reports: certReports } = useCertReportSummary(uoi);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors">
      {/* Top header — duplicated from CertHomePage. Extract to a
          CertLayout when the third public Cert page lands. */}
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-gray-800/95 backdrop-blur border-b border-gray-200 dark:border-gray-700">
        <div className={`${PAGE_CONTAINER} py-3 flex items-center justify-between`}>
          <div className="flex items-center gap-4 min-w-0">
            <NavLink to="/" className="shrink-0" aria-label="Back to RESO Tools">
              <img
                src={isDark ? LOGO_DARK : LOGO_LIGHT}
                alt="RESO"
                className="h-8"
              />
            </NavLink>
            <div className="hidden sm:block w-px h-7 bg-gray-200 dark:bg-gray-700" />
            <nav className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 min-w-0">
              <NavLink to="/cert" className="hover:text-gray-900 dark:hover:text-gray-200">
                Endorsements
              </NavLink>
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M7.21 14.77a.75.75 0 010-1.06l3.71-3.71-3.71-3.71a.75.75 0 111.06-1.06l4.24 4.24a.75.75 0 010 1.06l-4.24 4.24a.75.75 0 01-1.06 0z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-gray-700 dark:text-gray-200 font-medium truncate">
                {org?.OrganizationName ?? 'Organization'}
              </span>
            </nav>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={toggle}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
            >
              {isDark ? (
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M10 2a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 2zM10 15a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 15zM10 7a3 3 0 100 6 3 3 0 000-6zM15.657 5.404a.75.75 0 10-1.06-1.06l-1.061 1.06a.75.75 0 001.06 1.06l1.06-1.06zM6.464 14.596a.75.75 0 10-1.06-1.06l-1.06 1.06a.75.75 0 001.06 1.06l1.06-1.06zM18 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0118 10zM5 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 015 10zM14.596 15.657a.75.75 0 001.06-1.06l-1.06-1.061a.75.75 0 10-1.06 1.06l1.06 1.06zM5.404 6.464a.75.75 0 001.06-1.06l-1.06-1.06a.75.75 0 10-1.06 1.06l1.06 1.06z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>
            <AuthPill />
          </div>
        </div>
      </header>

      <main className={`${PAGE_CONTAINER} pt-10 pb-20`}>
        {isLoading && !org && <LoadingState />}
        {!isLoading && error && <ErrorState message={error} />}
        {!isLoading && !error && !org && <NotFoundState uoi={uoi ?? ''} />}
        {org && (
          <OrgSummaryBody
            org={org}
            certReports={certReports}
          />
        )}
      </main>
    </div>
  );
};

// ── Body ─────────────────────────────────────────────────────────────────

interface OrgSummaryBodyProps {
  readonly org: ResoOrganization;
  readonly certReports: ReadonlyArray<CertReportSummary>;
}

const OrgSummaryBody = ({ org, certReports }: OrgSummaryBodyProps) => {
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
        })),
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

  const activeCoverage = useMemo<CoverageReport | null>(
    () => (activeDdSummary ? summaryToCoverageReport(activeDdSummary) : null),
    [activeDdSummary]
  );

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
          </div>
        </div>
      )}

      {/* Active DD report context — shows which DD report is
          driving the coverage and performance sections below. */}
      {activeDdSummary && (
        <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
          Showing coverage from{' '}
          <span className="font-medium text-gray-700 dark:text-gray-300">
            Data Dictionary {activeDdSummary.version}
          </span>
          {activeGroup && (
            <span>
              {' '}by {activeGroup.providerName}
              {activeGroup.systemName && ` / ${activeGroup.systemName}`}
            </span>
          )}
        </p>
      )}

      {/* Coverage — driven by the selected provider's DD report,
          now from real cert API data via the summary endpoint. */}
      <CoverageSectionView coverage={activeCoverage} />

      {/* Performance — TODO: wire from DD report or separate
          endpoint. Placeholder for now. */}
      <PerformanceSectionView performance={null} />

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
          <AboutCell
            label="Members"
            value={
              org.OrganizationMemberCount != null
                ? org.OrganizationMemberCount.toLocaleString()
                : '—'
            }
          />
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
                  {org.OrganizationWebsite.replace(/^https?:\/\//, '')}
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
  coverage
}: {
  readonly coverage: CoverageReport | null;
}) => (
  <section className="mt-12">
    <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
        Coverage
      </h2>
      {coverage && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          From {coverage.typeLabel} {coverage.version} report · {coverage.date}
        </p>
      )}
    </div>
    <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
      How much of the standard data dictionary is actually populated in this
      provider's payloads, compared to the industry average. Higher means more
      fields and enumerations carry data that consumers can rely on.
    </p>

    {coverage ? (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
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
    return (
      <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {cut.label}
        </p>
        <p className="mt-2 flex items-baseline gap-1.5">
          <span className="text-4xl font-bold tabular-nums text-gray-900 dark:text-gray-50">
            {cut.providerCount}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">fields</span>
        </p>
        <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
          Industry avg: {cut.industryAvgCount}
        </p>
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
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {cut.label}
        </p>
        {above ? <AboveIndustryPill /> : <BelowIndustryPill />}
      </div>
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
      </p>
      <ComparisonBar
        providerPercent={cut.providerPercent}
        industryPercent={cut.industryPercent}
        above={above}
      />
      <p className="mt-2 text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
        {sign}
        {delta} pts vs industry avg ({cut.industryPercent}%)
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
              {payload.providerFields} of {payload.totalFields} fields
            </span>
          </p>
          <p className={`mt-1 text-xs font-medium tabular-nums ${deltaColor}`}>
            {sign}
            {delta} pts vs industry average ({payload.industryPercent}%)
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
  const delta = row.providerPercent - row.industryPercent;
  const above = delta >= 0;
  const barColor = above
    ? 'bg-emerald-500 dark:bg-emerald-400'
    : 'bg-amber-500 dark:bg-amber-400';
  const deltaColor = above
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-amber-600 dark:text-amber-400';
  const sign = above ? '+' : '';
  return (
    <li className="flex items-center gap-4 py-3">
      <div className="w-32 shrink-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {row.resource}
        </p>
      </div>
      <div className="flex-1 min-w-0">
        <div className="relative h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-visible">
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${barColor}`}
            style={{ width: `${row.providerPercent}%` }}
          />
          <div
            className="absolute -top-1 -bottom-1 w-0.5 bg-gray-500 dark:bg-gray-300"
            style={{ left: `${row.industryPercent}%` }}
            title={`Industry avg ${row.industryPercent}%`}
          />
        </div>
      </div>
      <div className="w-28 shrink-0 text-right">
        <p className="text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {row.providerPercent}%
        </p>
        <p className={`text-[11px] tabular-nums ${deltaColor}`}>
          {sign}
          {delta} vs {row.industryPercent}%
        </p>
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

const PerformanceVisible = ({ perf }: { readonly perf: PerformanceReport }) => (
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
        <p className="mt-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 tabular-nums">
          {perf.deltaPercent}% faster than industry average (
          {perf.industrySecPer1k.toFixed(2)}s)
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
      />
      <PerfMetric
        label="Avg response"
        value={perf.responseS.toFixed(2)}
        unit="s"
        industry={`${perf.industryResponseS.toFixed(2)} s`}
      />
      <PerfMetric
        label="Throughput"
        value={perf.throughputMbS.toFixed(2)}
        unit="MB/s"
        industry={`${perf.industryThroughputMbS.toFixed(2)} MB/s`}
      />
    </div>
  </div>
);

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
            — <span className="text-2xl">s</span>
          </span>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06l-1.745-1.745a10.029 10.029 0 003.3-4.38 1.651 1.651 0 000-1.185A10.004 10.004 0 009.999 3a9.956 9.956 0 00-4.744 1.194L3.28 2.22zM7.752 6.69l1.092 1.092a2.5 2.5 0 013.374 3.373l1.091 1.092a4 4 0 00-5.557-5.557z"
                clipRule="evenodd"
              />
            </svg>
            Not publicly available
          </span>
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          This provider has opted out of publishing performance metrics.
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
  </div>
);

const PerfMetric = ({
  label,
  value,
  unit,
  industry
}: {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly industry: string;
}) => (
  <div>
    <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
      {label}
    </p>
    <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
      {value}
      <span className="text-sm text-gray-400 dark:text-gray-500 font-medium ml-0.5">
        {' '}
        {unit}
      </span>
    </p>
    <p className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
      Industry: {industry}
    </p>
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

const CopyableUoi = ({ uoi }: { readonly uoi: string }) => (
  <button
    type="button"
    onClick={() => {
      void navigator.clipboard.writeText(uoi);
    }}
    title={`Copy ${uoi}`}
    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-mono text-[11px] uppercase tracking-wider bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
  >
    {uoi}
    <svg className="w-3 h-3 opacity-60" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M7 3a1 1 0 011-1h7a1 1 0 011 1v10a1 1 0 01-1 1h-2v2a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h2V3zm2 4h4v6H9V7z" />
    </svg>
  </button>
);

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
