/**
 * Testable core for the `reso-cert metadata` command — the metadata cert step.
 *
 * Combines the two operations the step performs: validate the OData CSDL/EDMX (XSD structural + CSDL semantic,
 * via `src/sdk/metadata-validation`) and serialize it to a RESO Format metadata report (`generateMetadataReport`).
 * Validation gates the step; the report is the artifact the downstream steps (schema, variations) consume. IO,
 * output routing and exit codes live in the command action (`index.ts`); this module is pure over its inputs.
 */

import { generateMetadataReport } from '@reso-standards/reso-metadata-utils';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import {
  validateMetadata,
  formatValidationSummary,
  collectValidationErrors,
} from '../sdk/metadata-validation.js';
import type { MetadataValidationResult } from '../sdk/metadata-validation.js';
import type { ODataVersion } from '../xsd/validate-csdl.js';

/** DD version stamped into the generated report when the caller does not specify one. */
export const DEFAULT_DD_VERSION = '2.0';

export interface MetadataStepResult {
  /** The step passes iff the metadata validates (XSD + semantic) AND — when a report was requested — it
   *  serialized to a RESO Format report. Validation and serialization are distinct checks with distinct
   *  strictness, so a document can validate yet fail to serialize; the step fails in that case too. */
  readonly passed: boolean;
  readonly validation: MetadataValidationResult;
  /** One-line human summary of the validation outcome. */
  readonly summary: string;
  /** Flattened validation errors, plus a `[report]` line when serialization was requested but failed. */
  readonly errors: ReadonlyArray<string>;
  /** The serialized RESO Format metadata report — present when it serialized and a report was requested;
   *  absent when generation was skipped (`emitReport: false`) or serialization failed (see {@link reportError}). */
  readonly report?: MetadataReport;
  /** Set when report serialization was requested but threw (e.g. the CSDL lacks the required EntityContainer).
   *  The serializer imposes service-document requirements the XSD/semantic validators do not, so this can fire
   *  even when {@link validation} passes — and when it does, the step fails: downstream has no report to read. */
  readonly reportError?: string;
}

/**
 * Run the metadata step over raw CSDL/EDMX XML: validate, then (unless suppressed) serialize to a RESO Format
 * report. `ddVersion` stamps the report's version; `odataVersion` overrides OData-version auto-detection for
 * validation. Serialization is attempted independently of the RESO verdict — a semantically invalid but
 * serializable document still yields a report — and a serialization failure is surfaced (never thrown out of
 * this function) so the step returns a determinate verdict rather than crashing on malformed metadata.
 */
export const runMetadataStep = async (opts: {
  readonly metadataXml: string;
  readonly ddVersion?: string;
  readonly odataVersion?: ODataVersion;
  readonly emitReport?: boolean;
}): Promise<MetadataStepResult> => {
  const validation = await validateMetadata(opts.metadataXml, opts.odataVersion);
  const emit = opts.emitReport !== false;
  const { report, reportError } = emit
    ? tryGenerateReport(opts.metadataXml, opts.ddVersion ?? DEFAULT_DD_VERSION)
    : { report: undefined, reportError: undefined };
  const validationValid = validation.xsdValid && validation.semanticValid;
  const passed = validationValid && (!emit || report !== undefined);
  const errors = reportError
    ? [...collectValidationErrors(validation), `[report] ${reportError}`]
    : collectValidationErrors(validation);
  return { passed, validation, summary: formatValidationSummary(validation), errors, report, reportError };
};

/** Serialize the report, capturing (rather than throwing) a serializer failure so the step reports a verdict
 *  instead of crashing on malformed CSDL. The failure reason is surfaced in {@link MetadataStepResult.reportError}. */
const tryGenerateReport = (
  metadataXml: string,
  ddVersion: string,
): { readonly report?: MetadataReport; readonly reportError?: string } => {
  try {
    return { report: generateMetadataReport(metadataXml, ddVersion) };
  } catch (err) {
    return { reportError: err instanceof Error ? err.message : String(err) };
  }
};
