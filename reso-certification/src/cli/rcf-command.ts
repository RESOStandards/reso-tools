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
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import { inferMetadataReport, type ReferenceMap } from '../rcf/index.js';
import { createDdSchemaValidator, type DdSchemaValidator } from './schema-command.js';
import { computeVariationsViaService, isVariationsAuthError, type VariationsServiceReport } from '../variations/index.js';
import { readRcfPayloads, type RcfPayload } from './rcf-input.js';

const requireCjs = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// getReferenceMetadata + buildMetadataMap are shared v2 utilities (reference DD metadata), not RCF inference.
const { getReferenceMetadata } = requireCjs(resolve(here, '../etl/index.cjs')) as { getReferenceMetadata: (v: string) => unknown };
const { buildMetadataMap } = requireCjs(resolve(here, '../legacy/common.js')) as { buildMetadataMap: (r: unknown) => { metadataMap: ReferenceMap } };

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
  } = {},
): Promise<RcfStreamResult> => {
  const recordsByResource: Record<string, unknown[]> = {};
  const availability: Record<string, MutableAvailability> = {};
  // The legacy `validate` folds into and RETURNS the accumulator, so thread its return across payloads.
  let errorMap: Record<string, unknown> = {};
  const cap = opts.sampleCap ?? DEFAULT_SAMPLE_CAP;
  let totalRecords = 0;
  let capturedVersion: string | undefined;

  for await (const payload of payloads) {
    capturedVersion ??= payload.version;
    const { resource, records } = payload;

    if (opts.validator) {
      // Fall back to the caller-resolved version: an @odata.context ($metadata#) collection carries no
      // version in its context, and the legacy validator requires one (else "Version is required").
      errorMap = opts.validator.validate({ value: records }, resource, payload.version ?? opts.version, errorMap);
      if (opts.strict && opts.validator.combine(errorMap).totalErrors > 0) {
        throw Object.assign(new Error(`Schema validation failed (strict) at ${payload.source}.`), { schemaFailure: true });
      }
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
    version: opts.version ?? capturedVersion,
    schemaErrors: combined.totalErrors,
    schemaReport: combined.report,
  };
};

/** A data-availability report from per-field counts (frequency + availability ratio per field). */
const buildDataAvailabilityReport = (
  availability: Record<string, AvailabilityResource>,
  version: string,
  generatedOn: string,
): unknown => ({
  description: 'RESO Data Availability Report (inferred from RESO Common Format samples)',
  version,
  generatedOn,
  resources: Object.entries(availability).map(([resourceName, a]) => ({
    resourceName,
    recordCount: a.recordCount,
    fields: Object.entries(a.fields).map(([fieldName, frequency]) => ({
      fieldName,
      frequency,
      availability: a.recordCount > 0 ? Number((frequency / a.recordCount).toFixed(4)) : 0,
    })),
  })),
});

/** Peek the first payload's DD version without draining the stream (used to build the DD schema/reference). */
const peekVersion = async (input: string): Promise<string | undefined> => {
  for await (const payload of readRcfPayloads(input)) return payload.version;
  return undefined;
};

export interface RcfResult {
  readonly version: string;
  readonly metadataReport: MetadataReport;
  readonly dataAvailabilityReport: unknown;
  readonly variations?: VariationsServiceReport;
  /** Set when variations was requested but degraded (non-auth service failure); reports still produced. */
  readonly variationsError?: string;
  readonly stats: {
    readonly totalRecords: number;
    readonly resources: number;
    readonly fields: number;
    readonly lookups: number;
    readonly schemaErrors: number;
    readonly variationsTotal?: number;
  };
}

/**
 * Run the RCF step: ingest → (optional) schema-validate → infer metadata report + data-availability
 * report → (optional) variations. `version` is taken from the input's context unless overridden.
 */
export const runRcf = async (opts: {
  readonly input: string;
  readonly version?: string;
  readonly fuzziness?: number;
  readonly additionalProperties?: boolean;
  readonly strict?: boolean;
  readonly schemaValidate?: boolean;
  readonly sampleCap?: number;
  readonly generatedOn: string;
  readonly runVariations?: boolean;
  readonly bearerToken?: string;
  readonly validationConfig?: unknown;
}): Promise<RcfResult> => {
  const version = opts.version ?? (await peekVersion(opts.input)) ?? DEFAULT_VERSION;
  const referenceMap = buildMetadataMap(getReferenceMetadata(version)).metadataMap;

  // Schema-validate against the DD (strict / -a), generating the DD schema once up front.
  const validator = opts.schemaValidate
    ? await createDdSchemaValidator({
        metadataReportJson: getReferenceMetadata(version),
        additionalProperties: opts.additionalProperties,
        validationConfig: opts.validationConfig,
      })
    : undefined;

  const stream = await processRcfStream(readRcfPayloads(opts.input), {
    validator,
    strict: opts.strict,
    sampleCap: opts.sampleCap,
    version,
  });

  const metadataReport = inferMetadataReport({
    recordsByResource: stream.recordsByResource,
    referenceMap,
    version,
    generatedOn: opts.generatedOn,
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
          ...(opts.bearerToken ? { bearerToken: opts.bearerToken } : {}),
        }),
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
    stats: {
      totalRecords: stream.totalRecords,
      resources: metadataReport.resources.length,
      fields: metadataReport.fields.length,
      lookups: metadataReport.lookups.length,
      schemaErrors: stream.schemaErrors,
      ...(variationsTotal !== undefined ? { variationsTotal } : {}),
    },
  };
};
