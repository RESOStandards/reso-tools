/**
 * Testable core for `reso-cert rcf` — RESO Common Format (RCF) certification.
 *
 * RCF payloads carry values, not a schema. This step:
 *   1. Streams payloads from the input (source-agnostic — a filesystem generator today; an API
 *      producer could feed the same consumer in a future version, swapping transport under one
 *      interface, without touching the score+validate core below).
 *   2. Schema-validates each payload against the DD (strict-fail or accumulate) and accumulates
 *      records + per-field availability.
 *   3. Infers a DD-2.0 metadata report from the records and builds a data-availability report.
 *   4. Runs the variations service on the inferred report.
 *
 * IO, output routing, and exit codes live in the command action; this module is over its inputs
 * (the payload stream and a bearer token), so it is unit-testable without a filesystem or network.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import { type ReferenceMap, inferMetadataReport } from '../rcf/index.js';
import { SUPPORTED_DD_VERSIONS, isSupportedDDVersion, normalizeDDVersion } from '../sdk/dd-versions.js';
import { type VariationsServiceReport, computeVariationsViaService, isVariationsAuthError } from '../variations/index.js';
import { type RcfPayload, readRcfPayloads } from './rcf-input.js';
import { type DdSchemaValidator, createDdSchemaValidator } from './schema-command.js';

const requireCjs = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// getReferenceMetadata + buildMetadataMap are shared v2 utilities (reference DD metadata), not RCF inference.
const { getReferenceMetadata } = requireCjs(resolve(here, '../etl/index.cjs')) as { getReferenceMetadata: (v: string) => unknown };
const { buildMetadataMap } = requireCjs(resolve(here, '../legacy/common.js')) as {
  buildMetadataMap: (r: unknown) => { metadataMap: ReferenceMap };
};

const DEFAULT_VERSION = '2.0';
/** Records kept per resource for inference; availability is scored over ALL records regardless. */
const DEFAULT_SAMPLE_CAP = 5000;

interface MutableAvailability {
  recordCount: number;
  readonly fields: Record<string, number>; // field -> count of records where it carried a value
}
export type AvailabilityResource = Readonly<MutableAvailability>;

export interface RcfStreamResult {
  readonly recordsByResource: Record<string, unknown[]>;
  readonly availability: Record<string, AvailabilityResource>;
  readonly totalRecords: number;
  /** Files whose `@reso.context` was present but unreadable: ingested, reported by validation, never certifiable. */
  readonly invalidContextFiles: number;
  readonly invalidContextRecords: number;
  /** DD version observed in the stream (first payload that carried one). */
  readonly version?: string;
  readonly schemaErrors: number;
  readonly schemaReport: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Drain a payload stream. When a `validator` is supplied, schema-validate each payload — `strict`
 * throws on the first payload that fails (fast-fail); otherwise errors accumulate into one report.
 * Records accumulate per resource up to `sampleCap` (inference needs a sample, not every record);
 * per-field availability is counted over ALL records.
 */
export const processRcfStream = async (
  payloads: AsyncIterable<RcfPayload>,
  opts: {
    readonly validator?: DdSchemaValidator;
    readonly strict?: boolean;
    readonly sampleCap?: number;
    /** Caller-resolved DD version — the authoritative fallback for validation (see below). */
    readonly version?: string;
    /** Maps a payload's resource (as ingested from its context, lowercase under the RCF rule) to the Data
     *  Dictionary resource name; the ingested form stands for a name the DD does not define. */
    readonly canonicalResource?: (resource: string) => string;
  } = {}
): Promise<RcfStreamResult> => {
  const recordsByResource: Record<string, unknown[]> = {};
  const availability: Record<string, MutableAvailability> = {};
  // The legacy `validate` folds into and RETURNS the accumulator, so thread its return across payloads.
  let errorMap: Record<string, unknown> = {};
  const cap = opts.sampleCap ?? DEFAULT_SAMPLE_CAP;
  let totalRecords = 0;
  let invalidContextFiles = 0;
  let invalidContextRecords = 0;
  let capturedVersion: string | undefined;

  for await (const payload of payloads) {
    capturedVersion ??= payload.version;
    const { records } = payload;
    // The RCF context carries the resource name lowercase; the reports, the reference lookups and the
    // schema definitions are keyed by the DD name (OpenHouse, not Openhouse), so resolve it here once.
    const resource = opts.canonicalResource ? opts.canonicalResource(payload.resource) : payload.resource;

    if (opts.validator) {
      // The caller-resolved run version is authoritative (declared with --version, or peeked from the first
      // payload): the payload's own context is checked AGAINST it (#298), so a file whose context names another
      // version is a mismatch, not a version the run silently adopts. Only when the caller resolved none (an
      // @odata.context collection carries no version, and the legacy validator requires one) does the payload's
      // version stand in. Forward the raw context so its shape and version are validated too. (Its resource
      // segment is what this command derives `resource` from, so on the rcf command a resource disagreement
      // cannot arise; that rule is exercised by callers that request a resource independently of the payload.)
      errorMap = opts.validator.validate(
        { ...(payload.context !== undefined ? { '@reso.context': payload.context } : {}), value: records },
        resource,
        opts.version ?? payload.version,
        errorMap
      );
      if (opts.strict && opts.validator.combine(errorMap).totalErrors > 0) {
        throw Object.assign(new Error(`Schema validation failed (strict) at ${payload.source}.`), { schemaFailure: true });
      }
    }

    if (payload.invalidContext) {
      // part of the submission but never certifiable: its own stat (so the exit code sees it whether or not a
      // validator ran), reported by validation above when one did, never counted as a record or inferred from
      invalidContextFiles += 1;
      invalidContextRecords += records.length;
      continue;
    }
    const acc = (recordsByResource[resource] ??= []);
    const av = (availability[resource] ??= { recordCount: 0, fields: {} });
    for (const record of records) {
      totalRecords += 1;
      av.recordCount += 1;
      if (isRecord(record)) {
        for (const [field, value] of Object.entries(record)) {
          if (field.startsWith('@')) continue;
          if (value !== null && value !== undefined && value !== '') av.fields[field] = (av.fields[field] ?? 0) + 1;
        }
      }
      if (acc.length < cap) acc.push(record);
    }
  }

  const combined = opts.validator ? opts.validator.combine(errorMap) : { totalErrors: 0, report: {} };
  return {
    recordsByResource,
    availability,
    totalRecords,
    invalidContextFiles,
    invalidContextRecords,
    version: opts.version ?? capturedVersion,
    schemaErrors: combined.totalErrors,
    schemaReport: combined.report
  };
};

/** A data-availability report from per-field counts (frequency + availability ratio per field). */
const buildDataAvailabilityReport = (
  availability: Record<string, AvailabilityResource>,
  version: string,
  generatedOn: string
): unknown => ({
  description: 'RESO Data Availability Report (inferred from RESO Common Format samples)',
  version,
  generatedOn,
  type: 'data_availability',
  // Flat `fields[]` carrying (resourceName, fieldName, frequency, availability) — the canonical RESO
  // Data Availability Report shape (cf. src/etl/process-data-availability). A divergent nested shape
  // under this canonical filename would be silently mis-consumed (report.fields → undefined → empty).
  fields: Object.entries(availability).flatMap(([resourceName, a]) =>
    Object.entries(a.fields).map(([fieldName, frequency]) => ({
      resourceName,
      fieldName,
      frequency,
      availability: a.recordCount > 0 ? Number((frequency / a.recordCount).toFixed(4)) : 0
    }))
  )
});

/** Peek the first payload's DD version without draining the stream (used to build the DD schema/reference). */
/** The first payload's context version — skipping payloads that carry none (an unreadable context, the
 *  @odata.context form), so a bad file that sorts first never decides the run's version. */
const peekVersion = async (input: string): Promise<string | undefined> => {
  for await (const payload of readRcfPayloads(input)) {
    if (payload.version) return payload.version;
  }
  return undefined;
};

export interface RcfResult {
  readonly version: string;
  readonly metadataReport: MetadataReport;
  readonly dataAvailabilityReport: unknown;
  readonly variations?: VariationsServiceReport;
  /** Set when variations was requested but degraded (non-auth service failure); reports still produced. */
  readonly variationsError?: string;
  /** The combined schema-validation report (errors / warnings by message) when schema validation ran. */
  readonly schemaReport?: Record<string, unknown>;
  readonly stats: {
    readonly totalRecords: number;
    readonly resources: number;
    readonly fields: number;
    readonly lookups: number;
    readonly schemaErrors: number;
    /** Files with an unreadable `@reso.context` and the records they carried (never certified; see the exit code). */
    readonly invalidContextFiles: number;
    readonly invalidContextRecords: number;
    readonly variationsTotal?: number;
  };
}

/**
 * Maps a completed rcf run to a process exit code. Extracted from the CLI action so the
 * highest-stakes decision — whether a certification run reads as pass or fail — is
 * unit-testable rather than an untested inline expression.
 *
 * - `totalRecords === 0` → 2: an empty or unreadable submission (no RCF entries, an
 *   unrecognized context, an all-non-RCF bundle) ingested nothing certifiable. It MUST NOT
 *   read as a clean pass, or CI would treat a submission it could not parse as certified.
 * - `schemaErrors > 0` → 1: schema/certification failures (an unreadable `@reso.context` is one when a
 *   validator ran).
 * - `invalidContextFiles > 0` → 2: the submission carried files whose context could not be read and no
 *   validator was there to report them; they were never certified, so the run is not a clean pass.
 * - `variationsError` → 2: a requested variations pass degraded and did not complete.
 * - otherwise → 0.
 */
export const resolveRcfExitCode = (result: Pick<RcfResult, 'stats' | 'variationsError'>): number => {
  if (result.stats.totalRecords === 0) return 2;
  if (result.stats.schemaErrors > 0) return 1;
  if (result.stats.invalidContextFiles > 0) return 2;
  if (result.variationsError) return 2;
  return 0;
};

/**
 * Run the RCF step: ingest → (optional) schema-validate → infer metadata report + data-availability
 * report → (optional) variations. `version` is taken from the input's context unless overridden.
 */
export const runRcf = async (opts: {
  readonly input: string;
  readonly version?: string;
  readonly fuzziness?: number;
  /** Kept so existing `-a` invocations keep working; it has no effect: extension is always allowed on the rcf path. */
  readonly additionalProperties?: boolean;
  readonly strict?: boolean;
  readonly schemaValidate?: boolean;
  readonly sampleCap?: number;
  readonly generatedOn: string;
  readonly runVariations?: boolean;
  readonly bearerToken?: string;
  readonly validationConfig?: unknown;
}): Promise<RcfResult> => {
  // The run version: declared (--version), else the first payload's context, else the default — normalized to
  // the Data Dictionary form (2.1.0 → 2.1) and refused when no reference ships for it. Before this guard a
  // context naming 3.0 or 2.00 passed the shape check and the run died on a null reference deep inside.
  const requested = opts.version ?? (await peekVersion(opts.input)) ?? DEFAULT_VERSION;
  if (!isSupportedDDVersion(requested)) {
    throw new Error(
      `Unsupported Data Dictionary version "${requested}" (from ${opts.version ? '--version' : "the input's @reso.context"}); supported: ${SUPPORTED_DD_VERSIONS.join(', ')}`
    );
  }
  const version = normalizeDDVersion(requested);
  const reference = getReferenceMetadata(version) as { readonly resources?: ReadonlyArray<string | { readonly resourceName: string }> };
  const referenceMap = buildMetadataMap(reference).metadataMap;
  // DD resource names by their lowercase form: the context names the resource lowercase (#298), the reports
  // and reference lookups use the DD's own casing (OpenHouse, PropertyUnitTypes, OUID).
  const ddNames = new Map(
    (reference.resources ?? []).map(r => (typeof r === 'string' ? r : r.resourceName)).map(name => [name.toLowerCase(), name] as const)
  );
  const canonicalResource = (resource: string): string => ddNames.get(resource.toLowerCase()) ?? resource;

  // Schema-validate against the DD (--strict), generating the DD schema once up front.
  const validator = opts.schemaValidate
    ? await createDdSchemaValidator({
        metadataReportJson: getReferenceMetadata(version),
        // RCF is taken as-is: the Data Dictionary allows extension, so local fields (and, in the validator,
        // values outside the standard set) are always accepted; a DD field is held to its type, and length,
        // precision and scale beyond the DD's are warnings. Extension is on regardless of `opts.additionalProperties`,
        // which is kept only so existing `-a` invocations keep working.
        additionalProperties: true,
        validationConfig: opts.validationConfig,
        acquisition: 'rcf'
      })
    : undefined;

  const stream = await processRcfStream(readRcfPayloads(opts.input), {
    validator,
    strict: opts.strict,
    sampleCap: opts.sampleCap,
    version,
    canonicalResource
  });

  const metadataReport = inferMetadataReport({
    recordsByResource: stream.recordsByResource,
    referenceMap,
    version,
    generatedOn: opts.generatedOn
  });
  const dataAvailabilityReport = buildDataAvailabilityReport(stream.availability, version, opts.generatedOn);

  // Variations runs LAST and must never discard the already-computed reports. A payload-too-large
  // or a service outage degrades to "no variations" with the reason surfaced, so metadata-report.json
  // and data-availability-report.json still land. Auth misconfig is the one hard-fail — the run can't
  // do what was asked, so rethrow and let the caller report it (and hint --no-variations).
  const attemptVariations = async (): Promise<{ readonly variations?: VariationsServiceReport; readonly variationsError?: string }> => {
    if (opts.runVariations === false) return {};
    try {
      return {
        variations: await computeVariationsViaService({
          metadataReportJson: metadataReport,
          version,
          ...(opts.fuzziness !== undefined ? { fuzziness: opts.fuzziness } : {}),
          fromCli: true,
          ...(opts.bearerToken ? { bearerToken: opts.bearerToken } : {})
        })
      };
    } catch (err) {
      if (isVariationsAuthError(err)) throw err;
      return { variationsError: err instanceof Error ? err.message : String(err) };
    }
  };
  const { variations, variationsError } = await attemptVariations();

  const variationsTotal = variations
    ? Object.values(variations.variations ?? {}).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
    : undefined;

  return {
    version,
    metadataReport,
    dataAvailabilityReport,
    ...(variations ? { variations } : {}),
    ...(variationsError ? { variationsError } : {}),
    ...(opts.schemaValidate ? { schemaReport: stream.schemaReport } : {}),
    stats: {
      totalRecords: stream.totalRecords,
      invalidContextFiles: stream.invalidContextFiles,
      invalidContextRecords: stream.invalidContextRecords,
      resources: metadataReport.resources.length,
      fields: metadataReport.fields.length,
      lookups: metadataReport.lookups.length,
      schemaErrors: stream.schemaErrors,
      ...(variationsTotal !== undefined ? { variationsTotal } : {})
    }
  };
};
