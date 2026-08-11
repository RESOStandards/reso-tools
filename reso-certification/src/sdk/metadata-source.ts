/**
 * Metadata source helpers — resolve a RESO Format metadata report from a live
 * OData endpoint.
 *
 * The `--from-server` metadata source shared by the per-step CLI commands:
 * fetch the CSDL/EDMX `$metadata` from a service root and serialize it to a
 * metadata report, so a provider can run a single cert step (e.g. variations)
 * straight against their server without first generating a report file. The
 * `$metadata` fetch (and its OData-version detection) reuses the same wrapper
 * the DD pipeline uses; serialization is `generateMetadataReport`.
 */

import { generateMetadataReport } from '@reso-standards/reso-metadata-utils';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import { fetchMetadataWithVersion } from '../test-runner/metadata.js';

export interface FetchMetadataReportFromServerInput {
  /** OData service root URL (no resource name or query). */
  readonly url: string;
  /** Bearer token for the endpoint — resolve from the CLI auth chain before calling. */
  readonly bearerToken: string;
  /** DD version stamped into the generated report. */
  readonly version: string;
}

/**
 * Fetch OData `$metadata` from a live endpoint and serialize it to an in-memory
 * RESO Format metadata report. Throws when the fetch fails (non-OK response,
 * propagated by {@link fetchMetadataWithVersion}) or the CSDL cannot be
 * serialized (`generateMetadataReport`). No temporary file is written — the
 * report is returned for a caller (e.g. the variations step) to consume directly.
 */
export const fetchMetadataReportFromServer = async (
  input: FetchMetadataReportFromServerInput,
): Promise<MetadataReport> => {
  const { xml } = await fetchMetadataWithVersion(input.url, input.bearerToken);
  return generateMetadataReport(xml, input.version);
};
