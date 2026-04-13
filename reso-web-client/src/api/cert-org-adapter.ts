/**
 * Adapter: cert API organization detail → canonical RESO OUID shape.
 *
 * The cert API at certqa.reso.org returns organizations with shortened
 * field names (`uoi`, `city`, `state`, `zip`, etc.). The rest of the
 * app consumes the canonical RESO OUID Resource shape defined in
 * types.ts (`OrganizationUniqueId`, `OrganizationCity`, etc.).
 *
 * This adapter maps one to the other in a single pure function so the
 * data source switch is invisible to consumers. When the long-term
 * DynamoDB feed lands, this adapter is the only file that changes.
 */

import type { CertOrganizationDetail } from './cert-client.js';
import type { ResoOrganization } from '../types.js';

/**
 * Derive a certification status string from the DD and Core statuses
 * the cert API returns. The canonical shape has a single
 * `CertificationStatus` field; the cert API returns them separately.
 */
const deriveCertificationStatus = (
  ddStatus: string,
  coreStatus: string
): string => {
  if (ddStatus === 'Certified Current' && coreStatus === 'Certified Current') {
    return 'Certified Current';
  }
  if (ddStatus === 'Certified Current' || coreStatus === 'Certified Current') {
    return 'Partially Certified';
  }
  return ddStatus || coreStatus || '';
};

/** Map a cert API organization detail to the canonical RESO OUID shape. */
export const certOrgToResoOrganization = (
  detail: CertOrganizationDetail
): ResoOrganization => ({
  OrganizationUniqueId: detail.uoi,
  OrganizationType: detail.type,
  OrganizationName: detail.name,
  OrganizationAddress1: detail.address,
  OrganizationCity: detail.city,
  OrganizationStateOrProvince: detail.state,
  OrganizationPostalCode: detail.zip,
  OrganizationWebsite: detail.url,
  OrganizationCountry: detail.country,
  ModificationTimestamp: detail.updated || detail.lastSyncedAt,
  OrganizationLatitude: Number(detail.latitude) || 0,
  OrganizationLongitude: Number(detail.longitude) || 0,
  OrganizationMemberCount: detail.memberCount,
  OrganizationCertName: detail.organizationCertName,
  AssnToMls: detail.assnToMls,
  CertificationStatus: deriveCertificationStatus(
    detail.organizationDdStatus,
    detail.organizationWebApiStatus
  ),
  CertificationSummaryUrl: `/cert/orgs/${encodeURIComponent(detail.uoi)}`,
  // Endorsements are not inline on the cert detail endpoint.
  // They come from the /certification_reports/filter endpoint and
  // are loaded separately by the Org Summary page. An empty array
  // here means "not loaded yet," not "no endorsements."
  Endorsements: [],
});
