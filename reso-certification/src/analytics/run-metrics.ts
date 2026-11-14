/**
 * A certification run's metrics, read from the run's own directory.
 *
 * The first primitive of RESO Analytics: everything a comparison, a ranking or a criterion reads is a flat list of
 * {@link Metric}s, each with an id, the resource it covers and which way is better. The counts and availability come
 * from the same ETL the certification site runs (`processMetadataReport`, `processDataAvailability`), so a number here
 * is the number the site shows for the same run.
 *
 * Reads Data Dictionary runs: `metadata-report.json` is required; `data-availability-report.json`,
 * `data-availability-responses.json` and the schema validation reports are read when present. A run whose payloads
 * failed schema validation writes the errors report instead of the availability report, so its availability and
 * performance are "not measured" (null), never zero.
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
// @ts-expect-error — legacy CJS ETL, no type declarations
import certUtilsEtl from '../etl/index.cjs';

// ── Report files ──

export const METADATA_REPORT_FILE = 'metadata-report.json';
export const AVAILABILITY_REPORT_FILE = 'data-availability-report.json';
export const AVAILABILITY_RESPONSES_FILE = 'data-availability-responses.json';
export const SCHEMA_ERRORS_FILE = 'data-availability-schema-validation-errors.json';
export const SCHEMA_WARNINGS_FILE = 'data-availability-schema-validation-warnings.json';

/** The scope of a metric that covers every resource in the run. */
export const ALL_RESOURCES = '*';

// ── Types ──

/** How a metric's value reads and how a change in it is stated: rates in points, performance in percent. */
export type MetricKind = 'count' | 'rate' | 'duration' | 'size' | 'throughput';

/** Which way is better. `neutral` metrics change without being better or worse (more local fields, more records). */
export type MetricDirection = 'higher' | 'lower' | 'neutral';

export interface Metric {
  /** Stable id, for criteria and scripts: `fields.standardRate`. */
  readonly id: string;
  readonly label: string;
  /** {@link ALL_RESOURCES}, or the resource the metric covers. */
  readonly scope: string;
  readonly kind: MetricKind;
  readonly better: MetricDirection;
  /** Null when the run did not measure it. Rates are percentages (0–100), durations milliseconds, sizes bytes,
   *  throughput bytes per second. */
  readonly value: number | null;
}

export interface RunInfo {
  /** The run's directory, absolute. */
  readonly path: string;
  readonly endorsement: string;
  readonly version: string;
  readonly generatedOn: string | null;
  /** From the run's place in the results tree, when it is in one. */
  readonly providerUoi: string | null;
  readonly providerUsi: string | null;
  readonly recipientUoi: string | null;
  readonly measured: {
    readonly metadata: boolean;
    readonly availability: boolean;
    readonly responses: boolean;
  };
}

export interface RunMetrics {
  readonly run: RunInfo;
  readonly metrics: ReadonlyArray<Metric>;
}

// ── The metrics ──

interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: MetricKind;
  readonly better: MetricDirection;
}

/** Every metric a run reports, in the order a report shows them. */
export const METRIC_DEFINITIONS = {
  resources: { id: 'resources.total', label: 'Resources', kind: 'count', better: 'neutral' },
  fields: { id: 'fields.total', label: 'Fields', kind: 'count', better: 'neutral' },
  standardFields: { id: 'fields.standard', label: 'Standard fields', kind: 'count', better: 'higher' },
  localFields: { id: 'fields.local', label: 'Local fields', kind: 'count', better: 'neutral' },
  fieldStandardization: { id: 'fields.standardRate', label: 'Field standardization', kind: 'rate', better: 'higher' },
  lookups: { id: 'lookups.total', label: 'Lookup values', kind: 'count', better: 'neutral' },
  standardLookups: { id: 'lookups.standard', label: 'Standard lookup values', kind: 'count', better: 'higher' },
  lookupStandardization: { id: 'lookups.standardRate', label: 'Lookup standardization', kind: 'rate', better: 'higher' },
  fieldsWithData: { id: 'fields.withData', label: 'Fields with data', kind: 'count', better: 'higher' },
  standardFieldAvailability: {
    id: 'fields.standardAvailability',
    label: 'Standard field availability',
    kind: 'rate',
    better: 'higher'
  },
  recordsSampled: { id: 'records.sampled', label: 'Records sampled', kind: 'count', better: 'neutral' },
  averageResponseTime: { id: 'responses.averageTime', label: 'Average response time', kind: 'duration', better: 'lower' },
  medianResponseTime: { id: 'responses.medianTime', label: 'Median response time', kind: 'duration', better: 'lower' },
  averageResponseSize: { id: 'responses.averageSize', label: 'Average response size', kind: 'size', better: 'neutral' },
  throughput: { id: 'responses.throughput', label: 'Throughput', kind: 'throughput', better: 'higher' },
  slowResponses: { id: 'responses.slow', label: 'Slow responses', kind: 'count', better: 'lower' },
  schemaErrors: { id: 'schema.errors', label: 'Schema validation errors', kind: 'count', better: 'lower' },
  schemaWarnings: { id: 'schema.warnings', label: 'Schema validation warnings', kind: 'count', better: 'lower' }
} as const satisfies Readonly<Record<string, MetricDefinition>>;

const metric = (definition: MetricDefinition, scope: string, value: number | null): Metric => ({
  ...definition,
  scope,
  value: value === null || Number.isFinite(value) ? value : null
});

// ── Narrowing what the reports hold ──

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): ReadonlyArray<Json> => (Array.isArray(value) ? value.filter(isRecord) : []);
const numberOr = (value: unknown, fallback: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const stringOr = <T extends string | null>(value: unknown, fallback: T): string | T => (typeof value === 'string' ? value : fallback);

/** A share as a percentage, or null when there is nothing to divide by. */
const percent = (part: number, whole: number): number | null => (whole > 0 ? (100 * part) / whole : null);

const mean = (values: ReadonlyArray<number>): number | null =>
  values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

const fieldKey = (resourceName: string, fieldName: string): string => `${resourceName}/${fieldName}`;

// ── The site's ETL ──

interface ProcessedMetadata {
  readonly standardFieldsCount: number;
  readonly localFieldsCount: number;
  readonly totalFieldsCount: number;
  readonly totalResourcesCount: number;
  readonly standardLookupsCount: number;
  readonly totalLookupsCount: number;
  readonly fields: ReadonlyArray<Json>;
}

interface ProcessedAvailability {
  readonly resources: ReadonlyArray<Json>;
  readonly fields: ReadonlyArray<Json>;
}

const etl = certUtilsEtl as {
  readonly processMetadata: { readonly processMetadataReport: (report: unknown) => Json };
  readonly processDataAvailability: { readonly processDataAvailability: (report: unknown) => Promise<Json> };
};

const processMetadata = (report: Json): ProcessedMetadata => {
  const processed = etl.processMetadata.processMetadataReport(report);
  const count = (key: string): number => numberOr(processed[key], 0) ?? 0;
  return {
    standardFieldsCount: count('standardFieldsCount'),
    localFieldsCount: count('localFieldsCount'),
    totalFieldsCount: count('totalFieldsCount'),
    totalResourcesCount: count('totalResourcesCount'),
    standardLookupsCount: count('standardLookupsCount'),
    totalLookupsCount: count('totalLookupsCount'),
    fields: records(processed.fields)
  };
};

const processAvailability = async (report: Json): Promise<ProcessedAvailability> => {
  const processed = await etl.processDataAvailability.processDataAvailability(report);
  return { resources: records(processed.resources), fields: records(processed.fields) };
};

// ── From reports to metrics (the pure part) ──

export interface RunReports {
  readonly metadataReport: Json;
  readonly availabilityReport?: Json;
  readonly responsesReport?: Json;
  readonly schemaErrorsReport?: Json;
  readonly schemaWarningsReport?: Json;
}

interface ResourcePerformance {
  readonly resourceName: string;
  readonly recordsSampled: number | null;
  readonly averageTimeMs: number | null;
  readonly medianTimeMs: number | null;
  readonly averageBytes: number | null;
  readonly samples: number;
}

const performanceOf = (resource: Json): ResourcePerformance => ({
  resourceName: stringOr(resource.resourceName, ''),
  recordsSampled: numberOr(resource.numUniqueRecordsFetched, numberOr(resource.numRecordsFetched, null)),
  averageTimeMs: numberOr(resource.averageResponseTimeMs, numberOr(resource.averageResponseTimeMillis, null)),
  medianTimeMs: numberOr(resource.medianResponseTimeMs, null),
  averageBytes: numberOr(resource.averageResponseBytes, null),
  samples: numberOr(resource.numSamples, 0) ?? 0
});

/** Bytes per second, as the site computes bandwidth: average bytes over average seconds. */
const throughputOf = (averageBytes: number | null, averageTimeMs: number | null): number | null =>
  averageBytes !== null && averageTimeMs !== null && averageTimeMs > 0 ? averageBytes / (averageTimeMs / 1000) : null;

/** Weighted by pages fetched, so a resource sampled once does not count as much as one sampled a hundred times. */
const weighted = (items: ReadonlyArray<ResourcePerformance>, pick: (p: ResourcePerformance) => number | null): number | null => {
  const pairs = items.flatMap(p => {
    const value = pick(p);
    return value === null || p.samples <= 0 ? [] : [[value, p.samples] as const];
  });
  const weight = pairs.reduce((sum, [, w]) => sum + w, 0);
  return weight > 0 ? pairs.reduce((sum, [v, w]) => sum + v * w, 0) / weight : null;
};

/**
 * The metrics of one run, from its reports. Deterministic: the same reports always give the same metrics.
 * The DD version comes from the metadata report, which every Data Dictionary run writes.
 */
export const runMetricsFromReports = async (
  reports: RunReports,
  run: Omit<RunInfo, 'measured' | 'version' | 'generatedOn'>
): Promise<RunMetrics> => {
  const version = stringOr(reports.metadataReport.version, null);
  if (version === null) throw new Error(`${METADATA_REPORT_FILE} in ${run.path} has no version`);

  const meta = processMetadata(reports.metadataReport);
  const availability = reports.availabilityReport ? await processAvailability(reports.availabilityReport) : null;
  const D = METRIC_DEFINITIONS;

  // Fields, per resource, from the metadata report. Standard means what the site's ETL says it means.
  const standardKeys = new Set(
    meta.fields.filter(f => f.standardRESO === true).map(f => fieldKey(stringOr(f.resourceName, ''), stringOr(f.fieldName, '')))
  );
  const fieldsByResource = meta.fields.reduce<Map<string, { total: number; standard: number }>>((acc, f) => {
    const resourceName = stringOr(f.resourceName, '');
    const current = acc.get(resourceName) ?? { total: 0, standard: 0 };
    acc.set(resourceName, { total: current.total + 1, standard: current.standard + (f.standardRESO === true ? 1 : 0) });
    return acc;
  }, new Map());

  // Availability per field, each resource's own fields only (an expanded resource's fields carry parentResourceName).
  const ownFields = (availability?.fields ?? []).filter(f => f.parentResourceName === undefined || f.parentResourceName === null);
  const availabilityOf = (f: Json): number => numberOr(f.availability, 0) ?? 0;
  const withData = (fields: ReadonlyArray<Json>): number => fields.filter(f => availabilityOf(f) > 0).length;
  const standardAvailability = (fields: ReadonlyArray<Json>): number | null => {
    const values = fields
      .filter(f => standardKeys.has(fieldKey(stringOr(f.resourceName, ''), stringOr(f.fieldName, ''))))
      .map(f => 100 * availabilityOf(f));
    return mean(values);
  };

  const performance = (availability?.resources ?? []).map(performanceOf).filter(p => p.resourceName !== '');
  const measuredAvailability = availability !== null;
  const orUnmeasured = (value: number | null): number | null => (measuredAvailability ? value : null);

  const responsesStats = isRecord(reports.responsesReport?.stats) ? reports.responsesReport.stats : undefined;
  const schemaErrors = reports.schemaErrorsReport ? numberOr(reports.schemaErrorsReport.totalErrors, 0) : 0;
  const schemaWarnings = reports.schemaWarningsReport ? numberOr(reports.schemaWarningsReport.totalWarnings, 0) : 0;

  const overall: ReadonlyArray<Metric> = [
    metric(D.resources, ALL_RESOURCES, meta.totalResourcesCount),
    metric(D.fields, ALL_RESOURCES, meta.totalFieldsCount),
    metric(D.standardFields, ALL_RESOURCES, meta.standardFieldsCount),
    metric(D.localFields, ALL_RESOURCES, meta.localFieldsCount),
    metric(D.fieldStandardization, ALL_RESOURCES, percent(meta.standardFieldsCount, meta.totalFieldsCount)),
    metric(D.lookups, ALL_RESOURCES, meta.totalLookupsCount),
    metric(D.standardLookups, ALL_RESOURCES, meta.standardLookupsCount),
    metric(D.lookupStandardization, ALL_RESOURCES, percent(meta.standardLookupsCount, meta.totalLookupsCount)),
    metric(D.fieldsWithData, ALL_RESOURCES, orUnmeasured(withData(ownFields))),
    metric(D.standardFieldAvailability, ALL_RESOURCES, orUnmeasured(standardAvailability(ownFields))),
    metric(D.recordsSampled, ALL_RESOURCES, orUnmeasured(performance.reduce((sum, p) => sum + (p.recordsSampled ?? 0), 0))),
    metric(D.averageResponseTime, ALL_RESOURCES, orUnmeasured(weighted(performance, p => p.averageTimeMs))),
    metric(D.averageResponseSize, ALL_RESOURCES, orUnmeasured(weighted(performance, p => p.averageBytes))),
    metric(
      D.throughput,
      ALL_RESOURCES,
      orUnmeasured(
        throughputOf(
          weighted(performance, p => p.averageBytes),
          weighted(performance, p => p.averageTimeMs)
        )
      )
    ),
    metric(D.slowResponses, ALL_RESOURCES, responsesStats ? numberOr(responsesStats.anomalyCount, null) : null),
    metric(D.schemaErrors, ALL_RESOURCES, schemaErrors),
    metric(D.schemaWarnings, ALL_RESOURCES, schemaWarnings)
  ];

  const resourceNames = [...new Set([...fieldsByResource.keys(), ...performance.map(p => p.resourceName)])]
    .filter(name => name !== '')
    .sort((a, b) => a.localeCompare(b));

  const perResource: ReadonlyArray<Metric> = resourceNames.flatMap(resourceName => {
    const counts = fieldsByResource.get(resourceName);
    const fields = ownFields.filter(f => f.resourceName === resourceName);
    const perf = performance.find(p => p.resourceName === resourceName);
    return [
      metric(D.fields, resourceName, counts?.total ?? null),
      metric(D.standardFields, resourceName, counts?.standard ?? null),
      metric(D.fieldStandardization, resourceName, counts ? percent(counts.standard, counts.total) : null),
      metric(D.fieldsWithData, resourceName, perf ? withData(fields) : null),
      metric(D.standardFieldAvailability, resourceName, perf ? standardAvailability(fields) : null),
      metric(D.recordsSampled, resourceName, perf?.recordsSampled ?? null),
      metric(D.averageResponseTime, resourceName, perf?.averageTimeMs ?? null),
      metric(D.medianResponseTime, resourceName, perf?.medianTimeMs ?? null),
      metric(D.throughput, resourceName, perf ? throughputOf(perf.averageBytes, perf.averageTimeMs) : null)
    ];
  });

  return {
    run: {
      ...run,
      version,
      generatedOn: stringOr(reports.metadataReport.generatedOn, stringOr(reports.availabilityReport?.generatedOn, null)),
      measured: {
        metadata: true,
        availability: measuredAvailability,
        responses: responsesStats !== undefined
      }
    },
    metrics: [...overall, ...perResource]
  };
};

// ── Reading a run directory ──

const readJson = async (path: string): Promise<Json | undefined> => {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
};

const ENDORSEMENT_LABELS: Readonly<Record<string, string>> = {
  'data-dictionary': 'Data Dictionary'
};

/**
 * Where a run sits in the results tree, when it does:
 * `{base}/{endorsement}-{version}/{providerUoi}-{providerUsi}/{recipientUoi}/(current | archived/{timestamp})`.
 * Anything else gives nulls: a run copied elsewhere still compares, without its connection.
 */
export const runPlacement = (
  runPath: string
): Pick<RunInfo, 'endorsement' | 'providerUoi' | 'providerUsi' | 'recipientUoi'> & { readonly endorsementSlug: string | null } => {
  const path = resolve(runPath);
  const recipientDir =
    basename(path) === 'current' ? dirname(path) : basename(dirname(path)) === 'archived' ? dirname(dirname(path)) : null;
  if (recipientDir === null) {
    return {
      endorsement: ENDORSEMENT_LABELS['data-dictionary'],
      endorsementSlug: null,
      providerUoi: null,
      providerUsi: null,
      recipientUoi: null
    };
  }
  const providerDir = basename(dirname(recipientDir));
  const endorsementDir = basename(dirname(dirname(recipientDir)));
  const slug = /^(.+)-(\d+\.\d+(?:\.\d+)?)$/.exec(endorsementDir)?.[1] ?? null;
  const dash = providerDir.indexOf('-');
  return {
    endorsement: (slug && ENDORSEMENT_LABELS[slug]) ?? ENDORSEMENT_LABELS['data-dictionary'],
    endorsementSlug: slug,
    providerUoi: dash > 0 ? providerDir.slice(0, dash) : providerDir || null,
    providerUsi: dash > 0 ? providerDir.slice(dash + 1) : null,
    recipientUoi: basename(recipientDir) || null
  };
};

/** Read a run directory's reports and compute its metrics. Throws when the directory holds no Data Dictionary run. */
export const readRunMetrics = async (runPath: string): Promise<RunMetrics> => {
  const path = resolve(runPath);
  const metadataReport = await readJson(join(path, METADATA_REPORT_FILE));
  if (metadataReport === undefined) {
    throw new Error(`${path} has no ${METADATA_REPORT_FILE}. Compare reads Data Dictionary runs.`);
  }
  const [availabilityReport, responsesReport, schemaErrorsReport, schemaWarningsReport] = await Promise.all([
    readJson(join(path, AVAILABILITY_REPORT_FILE)),
    readJson(join(path, AVAILABILITY_RESPONSES_FILE)),
    readJson(join(path, SCHEMA_ERRORS_FILE)),
    readJson(join(path, SCHEMA_WARNINGS_FILE))
  ]);
  const { endorsementSlug: _slug, ...placement } = runPlacement(path);
  return runMetricsFromReports(
    {
      metadataReport,
      ...(availabilityReport ? { availabilityReport } : {}),
      ...(responsesReport ? { responsesReport } : {}),
      ...(schemaErrorsReport ? { schemaErrorsReport } : {}),
      ...(schemaWarningsReport ? { schemaWarningsReport } : {})
    },
    { path, ...placement }
  );
};
