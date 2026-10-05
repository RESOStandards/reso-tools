/**
 * Lookup Resource fetcher and metadata merger.
 *
 * Replaces the Commander's Lookup Resource replication + serialization
 * and the cert-utils ETL merge. Fetches all Lookup records via $top/$skip
 * pagination, then merges them into the base metadata report.
 */

import type { MetadataReport, MetadataReportField, MetadataReportLookup } from '@reso-standards/reso-metadata-utils';
import { REPLICATION_STRATEGIES, replicationIterator } from '../replication/replication-iterator.js';
import type { ODataRequester } from '../test-runner/index.js';

// ── Constants ──

const LOOKUP_NAME_ANNOTATION_TERM = 'RESO.OData.Metadata.LookupName';
const STANDARD_NAME_ANNOTATION_TERM = 'RESO.OData.Metadata.StandardName';
const LEGACY_ODATA_VALUE_TERM = 'RESO.OData.Metadata.LegacyODataValue';
const PAGE_SIZE = 1000;
const LOOKUP_RESOURCE_NAME = 'Lookup';

// ── Raw Lookup Resource Types ──

/** A raw record from the Lookup resource (OData entity shape). */
export interface RawLookupRecord {
  readonly LookupName: string;
  readonly LookupValue: string;
  readonly StandardLookupValue?: string | null;
  readonly LegacyODataValue?: string | null;
  readonly ModificationTimestamp?: string;
  readonly LookupKey?: string;
  readonly [key: string]: unknown;
}

/** Raw Lookup Resource dump (same format Commander produces). */
export interface LookupResourceDump {
  readonly description: string;
  readonly version: string;
  readonly generatedOn: string;
  readonly lookups: ReadonlyArray<RawLookupRecord>;
}

// ── Fetch ──

/**
 * Fetch every Lookup record from the server.
 *
 * Replication is `$top`/`$skip`, which is what the Data Dictionary rules prescribe for this
 * resource. See {@link replicationIterator} for that grounding and for the two paging mistakes it
 * avoids — advancing the cursor by the requested window rather than the served count, and reading
 * a short page as end-of-data. The records accumulate in memory; the iterator's optional disk dump
 * is unused here because the caller serializes the complete set itself.
 *
 * Everything certification-specific stays here rather than in the iterator, which has no opinion
 * about what a status means: a 404 on the first request means the provider does not serve this
 * resource, any other non-200 is a failure carrying the request that produced it, and progress is
 * reported per page.
 *
 * Returns undefined if the Lookup resource doesn't exist (HTTP 404).
 */
export const fetchLookupResource = async (
  serverUrl: string,
  authToken: string,
  onProgress?: (count: number) => void,
  odataVersion?: string,
  requester?: ODataRequester
): Promise<ReadonlyArray<RawLookupRecord> | undefined> => {
  const allRecords: RawLookupRecord[] = [];

  for await (const page of replicationIterator({
    serviceRootUri: serverUrl,
    resourceName: LOOKUP_RESOURCE_NAME,
    strategy: REPLICATION_STRATEGIES.TOP_AND_SKIP,
    authToken,
    pageSize: PAGE_SIZE,
    odataVersion,
    requester
  })) {
    // Only the FIRST request can tell us the resource is absent. A 404 partway through a walk is a
    // failure on a resource we have already read from, not an absence.
    if (page.status === 404 && page.pageNumber === 1) return undefined;

    if (page.status !== 200) {
      const err = new Error(`Lookup Resource returned HTTP ${page.status}`);
      (err as unknown as Record<string, unknown>).requestDetails = {
        method: 'GET',
        url: page.requestUrl,
        status: page.status,
        responseBody: (page.errorBody ?? '').slice(0, 500)
      };
      throw err;
    }

    allRecords.push(...(page.records as ReadonlyArray<RawLookupRecord>));
    if (page.records.length > 0) onProgress?.(allRecords.length);
  }

  return allRecords;
};

/**
 * Serialize raw Lookup records to the dump format (matches Commander output).
 */
export const serializeLookupResourceDump = (records: ReadonlyArray<RawLookupRecord>, version: string): LookupResourceDump => ({
  description: 'Data Dictionary Lookup Resource Metadata',
  version,
  generatedOn: new Date().toISOString(),
  lookups: records
});

// ── Merge ──

/**
 * Transform a raw Lookup Resource record to the metadata report lookup format.
 * Matches the cert-utils ETL transformation.
 */
const transformLookupRecord = (record: RawLookupRecord): MetadataReportLookup => {
  const annotations: Array<{ readonly term: string; readonly value: string }> = [];

  if (record.LegacyODataValue?.trim?.()?.length) {
    annotations.push({ term: LEGACY_ODATA_VALUE_TERM, value: record.LegacyODataValue });
  }

  if (record.StandardLookupValue?.trim?.()?.length) {
    annotations.push({ term: STANDARD_NAME_ANNOTATION_TERM, value: record.StandardLookupValue });
  }

  return {
    lookupName: record.LookupName,
    lookupValue: record.LookupValue,
    type: 'Edm.String',
    ...(annotations.length > 0 ? { annotations } : {})
  };
};

/**
 * Transform fields: for fields with LookupName annotations, set their type
 * to the LookupName value (matching cert-utils ETL behavior).
 */
const transformFieldWithLookup = (field: MetadataReportField): MetadataReportField => {
  const lookupAnnotation = field.annotations.find(a => a.term === LOOKUP_NAME_ANNOTATION_TERM);

  if (lookupAnnotation) {
    return { ...field, type: lookupAnnotation.value };
  }

  return field;
};

/**
 * Merge a base metadata report with Lookup Resource data.
 *
 * This produces the merged metadata report. The DD pipeline writes it as the
 * canonical metadata-report.json and keeps the pre-merge base as metadata-report.raw.json
 * (the equivalent of cert-utils' old metadata-report.json + metadata-report.processed.json pair):
 * 1. Fields with LookupName annotations get their type replaced with the lookup name
 * 2. Lookup Resource records are transformed and appended to the lookups array
 */
export const mergeWithLookupResource = (baseReport: MetadataReport, lookupRecords: ReadonlyArray<RawLookupRecord>): MetadataReport => ({
  ...baseReport,
  fields: baseReport.fields.map(transformFieldWithLookup),
  lookups: [...baseReport.lookups, ...lookupRecords.map(transformLookupRecord)]
});

/** The unqualified (display) lookup name — the tail of a possibly-namespaced lookup name. */
const parseLookupName = (lookupName: string): string =>
  lookupName.includes('.') ? lookupName.slice(lookupName.lastIndexOf('.') + 1) : lookupName;

const unwrapCollectionType = (type: string): string =>
  type.startsWith('Collection(') && type.endsWith(')') ? type.slice('Collection('.length, -1) : type;

/**
 * Sentinel sample value for an open enumeration that carries no standard members. Matches the Web
 * API Commander's `Sample{LookupName}EnumValue` pattern, which is filtered out everywhere the
 * reference metadata is consumed (e.g. buildMetadataMap skips `Sample…EnumValue`), so it never
 * reaches variations, DD docs, or any comparison against the standard. The name is deliberately
 * self-identifying so it cannot be mistaken for a standard value.
 */
const sampleEnumValue = (lookupName: string): string => `Sample${lookupName}EnumValue`;

/** The enumeration a field references: its LookupName annotation (string rep) or the short tail of its type (EnumType rep). */
const enumReferenceName = (field: MetadataReportField): string =>
  field.annotations.find(a => a.term === LOOKUP_NAME_ANNOTATION_TERM)?.value ?? parseLookupName(unwrapCollectionType(field.type));

/**
 * Synthesize a Lookup Resource dataset from a DD reference report's lookups — the inverse of
 * transformLookupRecord. Produces the raw records a string-representation provider would serve at
 * /Lookup, so the certification self-test can exercise the string + Lookup Resource model against
 * the reference. The LookupName is the unqualified (short) name, matching a string-mode field's
 * LookupName annotation; StandardName and LegacyODataValue annotations become the record's
 * StandardLookupValue and LegacyODataValue.
 *
 * Open enumerations — referenced by a field but carrying no standard members (e.g. CountyOrParish,
 * City) — get a single sentinel sample record each, exactly as a real provider would populate its
 * own values. Without it the strict Lookup Resource referential-integrity check would flag every
 * open enumeration the reference defines but does not itself enumerate. The sentinel is sample-only
 * (see sampleEnumValue) and is filtered out of every downstream comparison.
 */
export const synthesizeLookupResourceRecords = (report: MetadataReport): ReadonlyArray<RawLookupRecord> => {
  const standardRecords: ReadonlyArray<RawLookupRecord> = report.lookups.map(lookup => {
    const standardName = lookup.annotations?.find(a => a.term === STANDARD_NAME_ANNOTATION_TERM)?.value;
    const legacyValue = lookup.annotations?.find(a => a.term === LEGACY_ODATA_VALUE_TERM)?.value;
    return {
      LookupName: parseLookupName(lookup.lookupName),
      LookupValue: lookup.lookupValue,
      ...(standardName ? { StandardLookupValue: standardName } : {}),
      ...(legacyValue ? { LegacyODataValue: legacyValue } : {})
    };
  });

  const enumsWithRecords = new Set(standardRecords.map(r => r.LookupName));
  const referencedEnums = new Set(report.fields.filter(f => f.isEnumeration && !f.isExpansion).map(enumReferenceName));
  const sampleRecords: ReadonlyArray<RawLookupRecord> = [...referencedEnums]
    .filter(name => !enumsWithRecords.has(name))
    .map(name => ({ LookupName: name, LookupValue: sampleEnumValue(name) }));

  return [...standardRecords, ...sampleRecords];
};

/**
 * Full pipeline: fetch Lookup Resource, merge with base report.
 * Returns the base report unchanged if Lookup resource is not available.
 */
export const fetchAndMergeLookupResource = async (
  baseReport: MetadataReport,
  serverUrl: string,
  authToken: string,
  onProgress?: (count: number) => void,
  odataVersion?: string
): Promise<{
  readonly report: MetadataReport;
  readonly lookupResourceAvailable: boolean;
  readonly lookupRecordCount: number;
  readonly rawRecords?: ReadonlyArray<RawLookupRecord>;
}> => {
  const lookupRecords = await fetchLookupResource(serverUrl, authToken, onProgress, odataVersion);

  if (!lookupRecords) {
    return { report: baseReport, lookupResourceAvailable: false, lookupRecordCount: 0 };
  }

  return {
    report: mergeWithLookupResource(baseReport, lookupRecords),
    lookupResourceAvailable: true,
    lookupRecordCount: lookupRecords.length,
    rawRecords: lookupRecords
  };
};
