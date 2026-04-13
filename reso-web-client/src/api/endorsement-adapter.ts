/**
 * Adapter that maps a `CertReport` from the live Cert API to the
 * `Endorsement` shape the UI components consume.
 *
 * Lives in its own module to avoid creating a circular dependency
 * between cert-client.ts (which doesn't need to know about UI types)
 * and cert-fixtures.ts (which doesn't need to know about the API).
 */

import type { CertReport, FetchReportsResponse } from './cert-client';
import type {
  Endorsement,
  EndorsementStatus,
  EndorsementType
} from './cert-fixtures';

/** Human labels keyed by the canonical endorsement type slug. */
const TYPE_LABELS: Record<string, string> = {
  data_dictionary: 'Data Dictionary',
  web_api_server_core: 'Web API Server Core',
  add_edit: 'Add/Edit',
  entity_event: 'Entity Event',
  reso_common_format: 'RESO Common Format',
  webhooks: 'Webhooks'
};

const KNOWN_TYPES = new Set<EndorsementType>([
  'data_dictionary',
  'web_api_server_core',
  'add_edit',
  'entity_event',
  'reso_common_format',
  'webhooks'
]);

const KNOWN_STATUSES = new Set<EndorsementStatus>([
  'certified',
  'recipient_notified',
  'passed',
  'in_progress',
  'in_review',
  'failed',
  'canceled',
  'withdrawn',
  'revoked',
  'legacy'
]);

/** Standard IDX field counts per DD version. The wire response only
 *  carries the *present* count (`iDXFieldsCount`); the denominator
 *  comes from the published RESO IDX standard for each DD version.
 *  Used to compute "X / Y (Z%)" coverage. TODO(idx-totals): confirm
 *  exact spec denominators with the certification team — values below
 *  are best-effort from observed prod displays. */
const STANDARD_IDX_FIELD_COUNT_BY_DD_VERSION: Readonly<Record<string, number>> = {
  '1.7': 251,
  '2.0': 251,
  '2.1': 251
};

/** Coerce an arbitrary type string to our `EndorsementType` union; defaults
 *  to `data_dictionary` for unknown values so the UI never crashes on a
 *  surprise from the wire. */
const coerceType = (raw: string): EndorsementType => {
  const slug = raw?.toLowerCase().replace(/-/g, '_');
  return KNOWN_TYPES.has(slug as EndorsementType)
    ? (slug as EndorsementType)
    : 'data_dictionary';
};

/** Coerce an arbitrary status string to our `EndorsementStatus` union;
 *  unknown values fall through to `active` so we render something. */
const coerceStatus = (raw: string): EndorsementStatus => {
  const slug = raw?.toLowerCase().replace(/[-\s]/g, '_');
  return KNOWN_STATUSES.has(slug as EndorsementStatus)
    ? (slug as EndorsementStatus)
    : 'certified';
};

/**
 * Map one CertReport row to one Endorsement. The recipient and provider
 * org names are passed in separately because the API response only carries
 * UOI keys; the consuming hook resolves names from a separate lookup
 * (typically from /api/v1/organization or embedded in the response).
 */
export const reportToEndorsement = (
  report: CertReport,
  context: {
    readonly providerName?: string;
    readonly recipientName?: string;
    readonly systemName?: string;
  } = {}
): Endorsement => {
  const type = coerceType(report.type);
  const typeLabel = TYPE_LABELS[type] ?? report.type;
  const status = coerceStatus(report.status);

  return {
    id: report.id,
    type,
    typeLabel,
    version: report.version,
    status,
    providerUoi: report.providerUoi,
    providerName: context.providerName ?? report.providerUoi,
    systemName: context.systemName,
    providerUsi: report.providerUsi,
    recipientUoi: report.recipientUoi,
    recipientName: context.recipientName,
    statusTimestamp:
      report.statusUpdatedAt ??
      report.statusTimestamp ??
      report.modificationTimestamp ??
      report.createdTimestamp ??
      report.generatedOn ??
      new Date(0).toISOString(),
    local: Boolean(report.local),
    ...(report.failedStep ? { failedStep: report.failedStep } : {}),
    ...(type === 'data_dictionary'
      ? {
          standardResourcesCount: report.standardResourcesCount,
          localResourcesCount: report.localResourcesCount,
          standardFieldsCount: report.standardFieldsCount,
          localFieldsCount: report.localFieldsCount,
          standardLookupsCount: report.standardLookupsCount,
          localLookupsCount: report.localLookupsCount,
          // Wire field is `iDXFieldsCount` (capital X). Both the cert
          // API and the variants on the wire use this casing — keep
          // the lookup explicit so a future rename doesn't silently
          // drop the IDX coverage display.
          idxFieldsCount:
            (report.iDXFieldsCount as number | undefined) ??
            (report['idxFieldsCount'] as number | undefined),
          totalStandardIdxFieldsCount:
            report.totalStandardIdxFieldsCount ??
            STANDARD_IDX_FIELD_COUNT_BY_DD_VERSION[report.version]
        }
      : {})
  };
};

/**
 * Flatten a `FetchReportsResponse` into a single `Endorsement[]`.
 * Iterates the recipient-keyed map and adapts each report row.
 */
export const responseToEndorsements = (
  response: FetchReportsResponse
): ReadonlyArray<Endorsement> => {
  const out: Array<Endorsement> = [];
  for (const [recipientUoi, reports] of Object.entries(response.reportsByOrgs)) {
    for (const report of reports) {
      // The API doesn't return display names in the filter response —
      // they're resolved separately via /api/v1/organization. For now
      // we fall back to the UOI itself so the UI shows *something*.
      out.push(
        reportToEndorsement(report, {
          recipientName: recipientUoi
        })
      );
    }
  }
  return out;
};
