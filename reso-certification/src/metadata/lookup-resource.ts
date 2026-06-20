/**
 * Lookup Resource fetcher and metadata merger.
 *
 * Replaces the Commander's Lookup Resource replication + serialization
 * and the cert-utils ETL merge. Fetches all Lookup records via $top/$skip
 * pagination, then merges them into the base metadata report.
 */

import { odataRequest, buildResourceUrl } from '../test-runner/index.js';
import type { MetadataReport, MetadataReportField, MetadataReportLookup } from './serializer.js';

// ── Constants ──

const LOOKUP_NAME_ANNOTATION_TERM = 'RESO.OData.Metadata.LookupName';
const STANDARD_NAME_ANNOTATION_TERM = 'RESO.OData.Metadata.StandardName';
const LEGACY_ODATA_VALUE_TERM = 'RESO.OData.Metadata.LegacyODataValue';
const PAGE_SIZE = 1000;

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
 * Fetch all Lookup records from the server.
 * Uses @odata.nextLink pagination by default, falls back to $top/$skip
 * if the server doesn't provide nextLinks.
 * Returns undefined if the Lookup resource doesn't exist (HTTP 404).
 */
export const fetchLookupResource = async (
  serverUrl: string,
  authToken: string,
  onProgress?: (count: number) => void,
  odataVersion?: string,
): Promise<ReadonlyArray<RawLookupRecord> | undefined> => {
  const allRecords: RawLookupRecord[] = [];
  let url: string | undefined = `${buildResourceUrl(serverUrl, 'Lookup')}?$top=${PAGE_SIZE}`;
  let useNextLink = true;
  let skip = 0;

  while (url) {
    const response = await odataRequest({ method: 'GET', url, authToken, odataVersion });

    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      const errorBody = typeof response.body === 'object' ? JSON.stringify(response.body) : String(response.body ?? '');
      const err = new Error(`Lookup Resource returned HTTP ${response.status}`);
      (err as unknown as Record<string, unknown>).requestDetails = { method: 'GET', url, status: response.status, responseBody: errorBody.slice(0, 500) };
      throw err;
    }

    const body = response.body as {
      value?: ReadonlyArray<RawLookupRecord>;
      '@odata.nextLink'?: string;
    } | null;

    const records = body?.value ?? [];
    if (records.length === 0) break;
    allRecords.push(...records);
    onProgress?.(allRecords.length);

    // Prefer @odata.nextLink for pagination
    const nextLink = body?.['@odata.nextLink'];
    if (nextLink) {
      url = nextLink;
      useNextLink = true;
    } else if (useNextLink && records.length >= PAGE_SIZE) {
      // First page had no nextLink — fall back to $top/$skip
      useNextLink = false;
      skip += PAGE_SIZE;
      url = `${buildResourceUrl(serverUrl, 'Lookup')}?$top=${PAGE_SIZE}&$skip=${skip}`;
    } else if (!useNextLink && records.length >= PAGE_SIZE) {
      // Continue $top/$skip fallback
      skip += PAGE_SIZE;
      url = `${buildResourceUrl(serverUrl, 'Lookup')}?$top=${PAGE_SIZE}&$skip=${skip}`;
    } else {
      break;
    }
  }

  return allRecords;
};

/**
 * Serialize raw Lookup records to the dump format (matches Commander output).
 */
export const serializeLookupResourceDump = (
  records: ReadonlyArray<RawLookupRecord>,
  version = '1.7',
): LookupResourceDump => ({
  description: 'Data Dictionary Lookup Resource Metadata',
  version,
  generatedOn: new Date().toISOString(),
  lookups: records,
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
    ...(annotations.length > 0 ? { annotations } : {}),
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
export const mergeWithLookupResource = (
  baseReport: MetadataReport,
  lookupRecords: ReadonlyArray<RawLookupRecord>,
): MetadataReport => ({
  ...baseReport,
  fields: baseReport.fields.map(transformFieldWithLookup),
  lookups: [
    ...baseReport.lookups,
    ...lookupRecords.map(transformLookupRecord),
  ],
});

/** The unqualified (display) lookup name — the tail of a possibly-namespaced lookup name. */
const parseLookupName = (lookupName: string): string =>
  lookupName.includes('.') ? lookupName.slice(lookupName.lastIndexOf('.') + 1) : lookupName;

/**
 * Synthesize a Lookup Resource dataset from a DD reference report's lookups — the inverse of
 * transformLookupRecord. Produces the raw records a string-representation provider would serve at
 * /Lookup, so the certification self-test can exercise the string + Lookup Resource model against
 * the reference. The LookupName is the unqualified (short) name, matching a string-mode field's
 * LookupName annotation; StandardName and LegacyODataValue annotations become the record's
 * StandardLookupValue and LegacyODataValue.
 */
export const synthesizeLookupResourceRecords = (report: MetadataReport): ReadonlyArray<RawLookupRecord> =>
  report.lookups.map(lookup => {
    const standardName = lookup.annotations?.find(a => a.term === STANDARD_NAME_ANNOTATION_TERM)?.value;
    const legacyValue = lookup.annotations?.find(a => a.term === LEGACY_ODATA_VALUE_TERM)?.value;
    return {
      LookupName: parseLookupName(lookup.lookupName),
      LookupValue: lookup.lookupValue,
      ...(standardName ? { StandardLookupValue: standardName } : {}),
      ...(legacyValue ? { LegacyODataValue: legacyValue } : {}),
    };
  });

/**
 * Full pipeline: fetch Lookup Resource, merge with base report.
 * Returns the base report unchanged if Lookup resource is not available.
 */
export const fetchAndMergeLookupResource = async (
  baseReport: MetadataReport,
  serverUrl: string,
  authToken: string,
  onProgress?: (count: number) => void,
  odataVersion?: string,
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
    rawRecords: lookupRecords,
  };
};
