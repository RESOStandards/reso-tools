/**
 * Field type resolution and value sampling from live server data.
 *
 * Ports the generate-resoscripts.sh logic to TypeScript:
 * 1. Identify fields by OData type from metadata
 * 2. Fetch sample records from the server
 * 3. Pick the best field + median value for each required type
 */

import { odataRequest, buildResourceUrl } from '../test-runner/index.js';
import type { EntityType, EntityProperty } from '../test-runner/types.js';

/** Resolved test parameters for one resource. */
export interface TestParams {
  readonly resource: string;
  readonly keyField: string;
  readonly keyValue: string;
  readonly enumMode: EnumMode;
  readonly integerField?: string;
  readonly integerValueLow?: number;
  readonly integerValueHigh: number;
  readonly decimalField?: string;
  readonly decimalValueLow?: number;
  readonly decimalValueHigh?: number;
  readonly dateField?: string;
  readonly dateValue?: string;
  readonly timestampField?: string;
  readonly datetimeValue?: string;
  readonly singleLookupField?: string;
  readonly singleLookupValue?: string;
  readonly multiLookupField?: string;
  readonly multiLookupValue1?: string;
  readonly multiLookupValue2?: string;
  readonly expandField?: string;
  readonly skippedTypes: ReadonlyArray<string>;
}

/** Well-known RESO resources with their key fields. */
export const WELL_KNOWN_RESOURCES: ReadonlyArray<{ readonly resource: string; readonly keyField: string }> = [
  { resource: 'Property', keyField: 'ListingKey' },
  { resource: 'Member', keyField: 'MemberKey' },
  { resource: 'Office', keyField: 'OfficeKey' },
  { resource: 'Media', keyField: 'MediaKey' },
  { resource: 'OpenHouse', keyField: 'OpenHouseKey' },
  { resource: 'Showing', keyField: 'ShowingKey' },
];

/** Required resources for v2.1.0 compliance. */
export const REQUIRED_RESOURCES_V21 = ['Property', 'Member', 'Office', 'Field', 'Lookup'];

// ── Type matchers ──

const INTEGER_TYPES = ['Edm.Int16', 'Edm.Int32', 'Edm.Int64'];
const DECIMAL_TYPES = ['Edm.Decimal', 'Edm.Double'];
const DATE_TYPES = ['Edm.Date'];
const DATETIME_TYPES = ['Edm.DateTimeOffset'];

const isIntegerType = (type: string): boolean => INTEGER_TYPES.includes(type);
const isDecimalType = (type: string): boolean => DECIMAL_TYPES.includes(type);
const isDateType = (type: string): boolean => DATE_TYPES.includes(type);
const isDateTimeType = (type: string): boolean => DATETIME_TYPES.includes(type);

/** Detected or configured enumeration mode. */
export type EnumMode = 'isflags' | 'collections' | 'string';

const isSingleLookup = (prop: EntityProperty, enumMode: EnumMode): boolean => {
  if (enumMode === 'string') return prop.type === 'Edm.String' && !!prop.annotations?.['RESO.OData.Metadata.LookupName'];
  return prop.type.startsWith('org.reso.metadata.enums.') && !prop.type.startsWith('Collection(');
};

const isMultiLookup = (prop: EntityProperty, enumMode: EnumMode): boolean => {
  if (enumMode === 'string') return prop.type === 'Collection(Edm.String)';
  if (enumMode === 'collections') return prop.type.startsWith('Collection(org.reso.metadata.enums.');
  // IsFlags: multi-value uses same Edm.EnumType with IsFlags=true (detected separately)
  return prop.type.startsWith('org.reso.metadata.enums.') && !prop.type.startsWith('Collection(');
};

/**
 * Auto-detect enum mode from entity type properties.
 *   - If any property uses Collection(Edm.String) with no enum types → 'string'
 *   - If any property uses Collection(org.reso.metadata.enums.*) → 'collections'
 *   - If any property uses org.reso.metadata.enums.* (no collections) → 'isflags'
 *   - Default: 'string'
 */
export const detectEnumMode = (entityType: EntityType): EnumMode => {
  const hasStringLookup = entityType.properties.some(p =>
    p.type === 'Edm.String' && !!p.annotations?.['RESO.OData.Metadata.LookupName']);
  const hasEnumCollection = entityType.properties.some(p =>
    p.type.startsWith('Collection(org.reso.metadata.enums.'));
  const hasEnumType = entityType.properties.some(p =>
    p.type.startsWith('org.reso.metadata.enums.') && !p.type.startsWith('Collection('));

  if (hasStringLookup) return 'string';
  if (hasEnumCollection) return 'collections';
  if (hasEnumType) return 'isflags';
  return 'string';
};

// ── Sampling helpers ──

/** Pick the median value from a sorted array. */
const median = <T>(sorted: ReadonlyArray<T>): T | undefined =>
  sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)];

/** Collect all non-null distinct values for a field across records. */
const collectValues = (
  records: ReadonlyArray<Record<string, unknown>>,
  field: string,
): ReadonlyArray<unknown> => {
  const seen = new Set<string>();
  const values: unknown[] = [];
  for (const record of records) {
    const val = record[field];
    if (val == null) continue;
    const key = String(val);
    if (!seen.has(key)) {
      seen.add(key);
      values.push(val);
    }
  }
  return values;
};

/** Find the best field of a given type: prefers 3+ distinct values, falls back to any with values. */
const findBestField = (
  fields: ReadonlyArray<string>,
  records: ReadonlyArray<Record<string, unknown>>,
  minDistinct = 3,
): { readonly field: string; readonly values: ReadonlyArray<unknown> } | undefined => {
  let fallback: { readonly field: string; readonly values: ReadonlyArray<unknown> } | undefined;

  for (const field of fields) {
    const values = collectValues(records, field);
    if (values.length >= minDistinct) return { field, values };
    if (values.length > 0 && !fallback) fallback = { field, values };
  }

  return fallback;
};

/** Find a timestamp field with no null values (best for orderby). */
const findFullyPopulatedTimestamp = (
  fields: ReadonlyArray<string>,
  records: ReadonlyArray<Record<string, unknown>>,
): string | undefined => {
  for (const field of fields) {
    const allPopulated = records.every(r => r[field] != null);
    if (allPopulated) return field;
  }
  return undefined;
};

/** Find lookup values for multi-value fields: need 2 distinct values. */
const findMultiLookupValues = (
  fields: ReadonlyArray<string>,
  records: ReadonlyArray<Record<string, unknown>>,
): { readonly field: string; readonly value1: string; readonly value2: string } | undefined => {
  for (const field of fields) {
    const allValues = new Set<string>();
    for (const record of records) {
      const val = record[field];
      if (val == null) continue;
      const items: ReadonlyArray<string> = Array.isArray(val)
        ? (val as unknown[]).map(String)
        : String(val).split(',').map(s => s.trim());
      for (const item of items) allValues.add(item);
    }
    const distinct = [...allValues];
    if (distinct.length >= 2) {
      return { field, value1: distinct[0], value2: distinct[1] };
    }
  }
  return undefined;
};

// ── Main resolver ──

/**
 * Resolve test parameters for a resource by sampling live data.
 *
 * Fetches up to 100 records and finds the best field + value for each
 * required OData type. Uses median selection for numeric/temporal values
 * to ensure filter tests work bidirectionally.
 */
export const resolveTestParams = async (
  serverUrl: string,
  resource: string,
  entityType: EntityType,
  authToken: string,
  enumModeOverride?: EnumMode,
): Promise<TestParams> => {
  const enumMode = enumModeOverride ?? detectEnumMode(entityType);
  const keyField = entityType.keyProperties[0] ?? 'ListingKey';
  const skippedTypes: string[] = [];

  // Fetch sample records
  const url = `${buildResourceUrl(serverUrl, resource)}?$top=100`;
  const response = await odataRequest({ method: 'GET', url, authToken });
  const body = response.body as { value?: ReadonlyArray<Record<string, unknown>> } | null;
  const records = body?.value ?? [];

  if (records.length === 0) {
    return { resource, keyField, keyValue: '', enumMode, integerValueHigh: 2147483647, skippedTypes: ['all — no records found'] };
  }

  const keyValue = String(records[0][keyField] ?? '');

  // Categorize fields by type
  const integerFields = entityType.properties.filter(p => isIntegerType(p.type)).map(p => p.name);
  const decimalFields = entityType.properties.filter(p => isDecimalType(p.type)).map(p => p.name);
  const dateFields = entityType.properties.filter(p => isDateType(p.type)).map(p => p.name);
  const datetimeFields = entityType.properties.filter(p => isDateTimeType(p.type)).map(p => p.name);
  const singleLookupFields = entityType.properties.filter(p => isSingleLookup(p, enumMode)).map(p => p.name);
  const multiLookupFields = entityType.properties.filter(p => isMultiLookup(p, enumMode)).map(p => p.name);

  // Resolve integer field + value
  const intResult = findBestField(integerFields, records);
  const integerField = intResult?.field;
  const integerValueLow = intResult
    ? Number(median([...intResult.values].map(Number).sort((a, b) => a - b)))
    : undefined;
  if (!integerField) skippedTypes.push('integer');

  // Resolve decimal field + value
  const decResult = findBestField(decimalFields, records);
  const decimalField = decResult?.field;
  const decimalValueLow = decResult
    ? Number(median([...decResult.values].map(Number).sort((a, b) => a - b)))
    : undefined;
  const decimalValueHigh = decimalValueLow != null ? decimalValueLow : undefined;
  if (!decimalField) skippedTypes.push('decimal');

  // Resolve date field + value
  const dateResult = findBestField(dateFields, records);
  const dateField = dateResult?.field;
  const dateValue = dateResult
    ? String(median([...dateResult.values].map(v => String(v).split('T')[0]).sort()))
    : undefined;
  if (!dateField) skippedTypes.push('date');

  // Resolve timestamp field + value (prefer fully populated for orderby)
  const timestampField = findFullyPopulatedTimestamp(datetimeFields, records)
    ?? datetimeFields.find(f => records.some(r => r[f] != null))
    ?? (datetimeFields.includes('ModificationTimestamp') ? 'ModificationTimestamp' : undefined);
  const datetimeValue = timestampField
    ? String(collectValues(records, timestampField)[0])
    : undefined;
  if (!timestampField) skippedTypes.push('timestamp');

  // Resolve single lookup
  let singleLookupField: string | undefined;
  let singleLookupValue: string | undefined;
  for (const field of singleLookupFields) {
    const vals = collectValues(records, field);
    if (vals.length > 0) {
      singleLookupField = field;
      singleLookupValue = String(vals[0]);
      break;
    }
  }
  if (!singleLookupField) skippedTypes.push('singleLookup');

  // Resolve multi lookup (need 2 distinct values)
  const multiResult = findMultiLookupValues(multiLookupFields, records);
  if (!multiResult) skippedTypes.push('multiLookup');

  return {
    resource,
    keyField,
    keyValue,
    enumMode,
    integerField,
    integerValueLow,
    integerValueHigh: 2147483647,
    decimalField,
    decimalValueLow,
    decimalValueHigh,
    dateField,
    dateValue,
    timestampField,
    datetimeValue,
    singleLookupField,
    singleLookupValue,
    multiLookupField: multiResult?.field,
    multiLookupValue1: multiResult?.value1,
    multiLookupValue2: multiResult?.value2,
    skippedTypes,
  };
};
