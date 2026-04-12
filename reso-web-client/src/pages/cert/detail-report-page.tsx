/**
 * Detail Report — pluggable report page with a shared shell and
 * type-specific renderers.
 *
 * The shared shell provides breadcrumbs, endorsement metadata, and
 * status. The renderer is selected based on report.type:
 *   - data_dictionary → DDDetailRenderer (rich metadata + availability)
 *   - web_api_server_core → CoreDetailRenderer (params, auth, OData)
 *   - everything else → GenericDetailRenderer (remarks, status, spec link)
 */

import { useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { useCertReportSummary } from '../../hooks/use-cert-report-summary';
import { useOrganizationNames } from '../../hooks/use-organization-names';
import { LoadingSpinner } from '../../components/loading-spinner';
import { StatusPill } from '../../components/cert/status-pill';
import { DDDetailRenderer } from '../../components/cert/dd-detail-renderer';
import type { EndorsementStatus } from '../../api/cert-fixtures';
import { fetchFullCertReport } from '../../api/cert-client';
import type { CertReportSummary } from '../../api/cert-client';

const PAGE_CONTAINER = 'max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8';

/** Spec URLs for each endorsement type. Exported for testing. */
export const SPEC_LINKS: Readonly<Record<string, ReadonlyArray<{ label: string; url: string }>>> = {
  data_dictionary: [
    { label: 'DD Specification', url: 'https://transport.reso.org/proposals/data-dictionary/' },
    { label: 'DD Documentation', url: 'https://dd.reso.org' },
  ],
  web_api_server_core: [
    { label: 'Web API Core Specification', url: 'https://transport.reso.org/proposals/web-api-core/' },
  ],
  add_edit: [
    { label: 'Add/Edit Specification', url: 'https://transport.reso.org/proposals/web-api-add-edit/' },
  ],
  common_format: [
    { label: 'Common Format Specification', url: 'https://transport.reso.org/proposals/reso-common-format/' },
  ],
  webhooks: [
    { label: 'Webhooks Specification', url: 'https://transport.reso.org/proposals/webhooks-push/' },
  ],
  validation_expressions: [
    { label: 'Validation Expressions Specification', url: 'https://transport.reso.org/proposals/validation-expressions/' },
  ],
  upi: [
    { label: 'UPI Specification', url: 'https://upi.reso.org' },
  ],
};

const TWO_YEARS_MS = 2 * 365.25 * 86_400_000;

const isExpiringSoon = (iso: string): boolean => {
  const then = new Date(iso).getTime();
  return !Number.isNaN(then) && Date.now() - then > TWO_YEARS_MS;
};

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** Map raw type strings to RESO display labels. */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  data_dictionary: 'Data Dictionary',
  web_api_server_core: 'Web API Core',
  add_edit: 'Web API Add/Edit',
  common_format: 'Common Format',
  webhooks: 'Webhooks',
  validation_expressions: 'Validation Expressions',
  upi: 'Universal Property Identifier',
};

/** Short label for breadcrumbs and fallback. */
const typeLabel = (type: string): string => TYPE_LABELS[type] ?? type;

/** Full report title: "RESO Data Dictionary 2.0 Report". Exported for testing. */
export const reportTitle = (type: string, version: string): string =>
  `RESO ${typeLabel(type)} ${version} Report`;

// ── Renderers ────────────────────────────────────────────────────────

/** Generic renderer — remarks, status, spec link. Handles all non-DD, non-Core types. */
const GenericDetailRenderer = ({ report }: { readonly report: CertReportSummary }) => {
  const remarks = (report as unknown as Record<string, unknown>).remarks as string | undefined;
  const generatedOn = report.generatedOn ?? report.statusUpdatedAt;

  return (
    <div className="space-y-6">
      {/* Key facts */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Version</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{report.version}</p>
        </div>
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</p>
          <div className="mt-2"><StatusPill status={report.status as EndorsementStatus} /></div>
        </div>
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Report Date</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {generatedOn ? formatDate(generatedOn) : '—'}
          </p>
        </div>
      </div>

      {/* Remarks */}
      {remarks && (
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Summary</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{remarks}</p>
        </div>
      )}
    </div>
  );
};

/** Core renderer — extends generic with parameters table, auth, OData version. */
const CoreDetailRenderer = ({ report }: { readonly report: CertReportSummary }) => {
  const [fullReport, setFullReport] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    fetchFullCertReport(report.type, report.id)
      .then(setFullReport)
      .catch(() => {});
  }, [report.id, report.type]);

  const auth = report.authentication ?? (fullReport?.authentication as string[] | undefined) ?? [];
  const odataVersion = report.odataVersion ?? (fullReport?.odataVersion as string | undefined) ?? '—';
  const parameters = (fullReport?.parameters ?? (report as unknown as Record<string, unknown>).parameters) as
    ReadonlyArray<{ name: string; value: string; wikiPageURL?: string }> | undefined;
  const remarks = (fullReport?.remarks ?? (report as unknown as Record<string, unknown>).remarks) as string | undefined;
  const generatedOn = report.generatedOn ?? report.statusUpdatedAt;

  return (
    <div className="space-y-6">
      {/* Key facts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Version</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{report.version}</p>
        </div>
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">OData Version</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{odataVersion}</p>
        </div>
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Authentication</p>
          <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100 capitalize">
            {auth.length > 0 ? auth.join(', ') : '—'}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Report Date</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
            {generatedOn ? formatDate(generatedOn) : '—'}
          </p>
        </div>
      </div>

      {/* Parameters table */}
      {parameters && parameters.length > 0 && (
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Test Parameters</h3>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {parameters.map((p) => (
              <div key={p.name} className="flex items-baseline justify-between py-2 text-sm">
                <span className="text-gray-500 dark:text-gray-400">{p.name}</span>
                {p.wikiPageURL ? (
                  <a href={p.wikiPageURL} target="_blank" rel="noopener noreferrer"
                    className="font-medium text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs">{p.value}</a>
                ) : (
                  <span className="font-medium text-gray-900 dark:text-gray-100 font-mono text-xs">{p.value}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Remarks */}
      {remarks && (
        <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Summary</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{remarks}</p>
        </div>
      )}
    </div>
  );
};

// DDDetailRenderer is imported from ../../components/cert/dd-detail-renderer

// ── Shared Shell ─────────────────────────────────────────────────────

/** Select the renderer based on report type. Exported for testing. */
export const selectRenderer = (report: CertReportSummary): React.FC<{ report: CertReportSummary }> => {
  if (report.type === 'data_dictionary' && report.advertised) return DDDetailRenderer;
  if (report.type === 'web_api_server_core') return CoreDetailRenderer;
  return GenericDetailRenderer;
};

export const DetailReportPage = () => {
  const { uoi, endorsementId } = useParams<{
    readonly uoi: string;
    readonly endorsementId: string;
  }>();

  const { reports, isLoading, error } = useCertReportSummary(uoi);
  const { lookup: lookupOrgName, lookupSystem } = useOrganizationNames();

  // Find the specific report by endorsement ID
  const report = reports.find((r) => r.id === endorsementId) ?? null;

  // Resolve provider/system names from the org directory
  const providerName = report ? (lookupOrgName(report.providerUoi) ?? report.providerUoi) : '';
  const systemName = report?.providerUsi ? (lookupSystem(report.providerUoi, report.providerUsi) ?? report.providerUsi) : '';

  if (isLoading) return <LoadingSpinner />;

  if (error) {
    return (
      <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
        <div className={`${PAGE_CONTAINER} pt-6`}>
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
        <div className={`${PAGE_CONTAINER} pt-6`}>
          <nav className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-6" aria-label="Breadcrumb">
            <NavLink to="/cert" className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Certification</NavLink>
            <ChevronSep />
            {uoi && (
              <>
                <NavLink to={`/cert/orgs/${uoi}`} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Summary</NavLink>
                <ChevronSep />
              </>
            )}
            <span className="text-gray-700 dark:text-gray-300 font-medium">Detail</span>
          </nav>
          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            Report not found: <span className="font-mono">{endorsementId}</span>
          </div>
        </div>
      </div>
    );
  }

  const Renderer = selectRenderer(report);
  const specLinks = SPEC_LINKS[report.type] ?? [];
  const statusTs = report.statusUpdatedAt ?? report.generatedOn ?? '';
  const expiring = statusTs && report.status === 'certified' && isExpiringSoon(statusTs);

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className={`${PAGE_CONTAINER} pt-6 pb-20`}>
        {/* Breadcrumbs */}
        <nav className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-1" aria-label="Breadcrumb">
          <NavLink to="/cert" className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Certification</NavLink>
          <ChevronSep />
          {uoi && (
            <>
              <NavLink to={`/cert/orgs/${uoi}`} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Summary</NavLink>
              <ChevronSep />
            </>
          )}
          <span className="text-gray-700 dark:text-gray-300 font-medium truncate max-w-xs">
            {typeLabel(report.type)}
          </span>
        </nav>

        {/* Endorsement header */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
                {reportTitle(report.type, report.version)}
              </h1>
              {providerName && (
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Provider: <span className="font-medium text-gray-700 dark:text-gray-300">{providerName}</span>
                  {systemName && (
                    <span className="text-gray-400 dark:text-gray-500"> / {systemName}</span>
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <StatusPill status={report.status as EndorsementStatus} />
              {expiring && (
                <span
                  className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 cursor-help"
                  title="RESO endorsements are valid for two years from the date of certification. Endorsements older than two years will transition to Legacy status and will need to be renewed to remain current. This update is part of RESO's versioning policy, which helps ensure that certified implementations reflect the latest standards."
                >
                  Expiring Soon
                </span>
              )}
            </div>
          </div>

          {/* Spec links */}
          {specLinks.length > 0 && (
            <div className="mt-2 flex items-center gap-3 flex-wrap">
              {specLinks.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M12.232 4.232a2.5 2.5 0 013.536 3.536l-1.225 1.224a.75.75 0 001.061 1.06l1.224-1.224a4 4 0 00-5.656-5.656l-3 3a4 4 0 00.225 5.865.75.75 0 00.977-1.138 2.5 2.5 0 01-.142-3.667l3-3z" />
                    <path d="M11.603 7.963a.75.75 0 00-.977 1.138 2.5 2.5 0 01.142 3.667l-3 3a2.5 2.5 0 01-3.536-3.536l1.225-1.224a.75.75 0 00-1.061-1.06l-1.224 1.224a4 4 0 105.656 5.656l3-3a4 4 0 00-.225-5.865z" />
                  </svg>
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Type-specific renderer */}
        <Renderer report={report} />
      </div>
    </div>
  );
};

/** Breadcrumb chevron separator. */
const ChevronSep = () => (
  <svg className="w-3 h-3 text-gray-400 dark:text-gray-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 010-1.06l3.71-3.71-3.71-3.71a.75.75 0 111.06-1.06l4.24 4.24a.75.75 0 010 1.06l-4.24 4.24a.75.75 0 01-1.06 0z" clipRule="evenodd" />
  </svg>
);
