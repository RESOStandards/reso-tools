/**
 * Field type resolution and value sampling from live server data.
 *
 * Ports the generate-resoscripts.sh logic to TypeScript:
 * 1. Identify fields by OData type from metadata
 * 2. Fetch sample records from the server
 * 3. Pick the best field + median value for each required type
 */

import type { EnumRepresentation } from '@reso-standards/reso-client';
import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import { odataRequest, buildResourceUrl } from '../test-runner/index.js';
import type { EntityType } from '../test-runner/types.js';
import { type EnumCandidate, isMultiRep, isSingleRep, selectEnumCandidates } from './enum-selection.js';
import type { StandardMap } from './standard-map.js';

/** Resolved test parameters for one resource. */
export interface TestParams {
  readonly resource: string;
  readonly keyField: string;
  readonly keyValue: string;
  readonly enumMode: EnumMode;
  readonly integerField?: string;
  /** Median sampled value — for eq / ge / le / ne (the value's own record satisfies eq/ge/le; ne is gated). */
  readonly integerValueLow?: number;
  readonly integerValueHigh: number;
  /** Sampled MIN — the `gt` target. `field gt min` matches iff a larger value exists (≥2 distinct), so the
   *  empty-verdict gates it on the distinct count. Using the median would false-fail at low cardinality
   *  (median == max when ≤2 distinct → `gt median` is correctly empty yet was scored a defect). */
  readonly integerValueMin?: number;
  /** Sampled MAX — the `lt` target (symmetric to {@link integerValueMin}). */
  readonly integerValueMax?: number;
  /** Sentinel for the `not(integerField le <sentinel>)` scenario — below the field's floor so `not` matches
   *  every record (guaranteed non-empty). `-1` for a non-negative field (the old Commander value), or below
   *  the sampled min for a signed one. Absent when there is no integer field. */
  readonly integerNotSentinel?: number;
  readonly decimalField?: string;
  readonly decimalValueLow?: number;
  readonly decimalValueHigh?: number;
  /** Sampled decimal MIN / MAX — the `gt` / `lt` targets (see {@link integerValueMin}). */
  readonly decimalValueMin?: number;
  readonly decimalValueMax?: number;
  readonly dateField?: string;
  readonly dateValue?: string;
  /** Sampled date MIN / MAX — the `gt` / `lt` targets (see {@link integerValueMin}). */
  readonly dateValueMin?: string;
  readonly dateValueMax?: string;
  readonly timestampField?: string;
  /** The sampled MIN timestamp — used for `gt` / `ge`. `gt min` is gated on {@link datetimeDistinctCount};
   *  the previous first-seen value was the global MAX under a `…DESC` default sort, making `gt max` a false fail. */
  readonly datetimeValue?: string;
  readonly singleLookupField?: string;
  readonly singleLookupValue?: string;
  readonly multiLookupField?: string;
  readonly multiLookupValue1?: string;
  readonly multiLookupValue2?: string;
  /** A plain (non-lookup) Edm.String field + a sample substring, for the
   *  optional string-function tests (contains/startswith/endswith). */
  readonly stringField?: string;
  readonly stringValue?: string;
  /** Additional sample values for the OData 4.01 `in` operator scenario.
   *  Need at least 2 distinct lookup values; the runner skips the scenario
   *  if fewer than 2 of `singleLookupValue` / `singleLookupValue2` /
   *  `singleLookupValue3` are populated. */
  readonly singleLookupValue2?: string;
  readonly singleLookupValue3?: string;
  /** The resolved representation of the chosen single/multi lookup field — the runner gates each enum
   *  scenario on this (flags→has, single→eq/ne/in, collection→any/all) instead of the resource-wide mode. */
  readonly singleLookupFieldRep?: EnumRepresentation;
  readonly multiLookupFieldRep?: EnumRepresentation;
  /** The CSDL enum type of the chosen enum-typed lookup field — lets the runner decode an integer-bitmask
   *  response value back to member names when validating a flags field. Absent for string lookups. */
  readonly singleLookupEnumType?: CsdlEnumType;
  readonly multiLookupEnumType?: CsdlEnumType;
  /** Ranked candidate fields per slot (standard-first). The runner tries alternates when the primary
   *  field isn't queryable — we're not guaranteed a given field can be filtered on. */
  readonly singleLookupCandidates?: ReadonlyArray<EnumCandidate>;
  readonly multiLookupCandidates?: ReadonlyArray<EnumCandidate>;
  /** Map from single-lookup field name to its RESO.OData.Metadata.LookupName
   *  annotation value. Used by the Lookup Resource validation scenario
   *  (`GET /Lookup?$filter=LookupName eq '<lookupName>'`). Sampled from the
   *  metadata at test-setup time. Falls back to the field name if absent. */
  readonly lookupNameByField?: Readonly<Record<string, string>>;
  readonly expandField?: string;
  /** True when the $top=1000 sample was the COMPLETE resource (no forward `@odata.nextLink`). The `ne`
   *  empty-verdict needs this to distinguish "the field genuinely holds one value across the whole resource"
   *  (empty is correct → pass) from "our sample only saw one value" (unknowable → skip). */
  readonly sampleComplete: boolean;
  /** Distinct sampled value counts for the chosen scalar fields — the `ne` verdict needs ≥2 to prove the
   *  field holds another value (so an empty `field ne <sampled>` result is a defect, not the correct answer).
   *  Enum slots carry their own count on the candidate (`EnumCandidate.distinctValueCount`). */
  readonly integerDistinctCount?: number;
  readonly decimalDistinctCount?: number;
  readonly dateDistinctCount?: number;
  readonly datetimeDistinctCount?: number;
  /** Distinct sampled value counts for the CHOSEN enum lookup fields — the enum `ne` verdict's equivalent of
   *  the scalar counts. The runner overrides these per candidate (`paramsWithCandidate`) as it tries the
   *  ranked ladder, so each attempt carries its own field's count; the primary candidate seeds them here. */
  readonly singleLookupDistinctCount?: number;
  readonly multiLookupDistinctCount?: number;
  readonly skippedTypes: ReadonlyArray<string>;
}

/** A sampled page is COMPLETE (the whole resource) when the OData response carries no forward
 *  `@odata.nextLink`. Core 2.1.0 requires that link when more results exist, so its absence means we sampled
 *  every record. A null/absent body is unknowable, so conservatively INCOMPLETE — never a false "complete". */
export const isSampleComplete = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const nextLink = (body as Record<string, unknown>)['@odata.nextLink'];
  return nextLink == null;
};

/** The sentinel for the `not(field le sentinel)` test — strictly below the field's sampled floor so `not`
 *  matches every record (guaranteed non-empty, making an empty result a determinate defect). A non-negative
 *  field yields `-1` (min ≥ 0 ⇒ min−1 ≥ −1, so the −1 clamp wins — the old Commander value); a signed field
 *  yields `sampledMin − 1`. Undefined when the field has no finite sampled values. */
export const integerNotSentinelFor = (values: ReadonlyArray<unknown>): number | undefined => {
  // Drop null/undefined BEFORE coercion — Number(null) is 0, which would masquerade as a real floor of 0.
  const nums = values.filter((v) => v != null).map(Number).filter(Number.isFinite);
  return nums.length > 0 ? Math.min(-1, Math.min(...nums) - 1) : undefined;
};

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

/** The sample page size. A page that returns fewer than this AND carries no `@odata.nextLink` is the COMPLETE
 *  resource; a full page (== SAMPLE_TOP) may be `$top`-capped with more records beyond it, so it is NOT proof
 *  of completeness — treating it as complete would let a `ne` false-PASS through. */
const SAMPLE_TOP = 1000;

/** Numeric min / median / max / distinct-count of a field's sampled values, NUMERICALLY deduped. An
 *  IEEE754Compatible server serializes Edm.Decimal/Int64 as JSON strings, so the same value can arrive as
 *  "100" and "100.00"; deduping by Number (not String) keeps a numerically single-valued field from
 *  over-counting its distinct values and wrongly failing a correct `ne`/`gt`/`lt`. */
export const numericStats = (
  values: ReadonlyArray<unknown>,
): { readonly min: number; readonly median: number; readonly max: number; readonly distinct: number } | undefined => {
  // Drop null/undefined BEFORE coercion — Number(null) is 0, which would inject a spurious 0 into the stats.
  const nums = [...new Set(values.filter(v => v != null).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  return nums.length === 0 ? undefined : { min: nums[0], median: nums[Math.floor(nums.length / 2)], max: nums[nums.length - 1], distinct: nums.length };
};

/** Date-only min / median / max / distinct-count. ISO date strings sort chronologically, so a lexicographic
 *  sort suffices; the date-only slice normalizes any datetime-shaped value. */
export const dateStats = (
  values: ReadonlyArray<unknown>,
): { readonly min: string; readonly median: string; readonly max: string; readonly distinct: number } | undefined => {
  const dates = [...new Set(values.map(v => String(v).split('T')[0]))].sort();
  return dates.length === 0 ? undefined : { min: dates[0], median: dates[Math.floor(dates.length / 2)], max: dates[dates.length - 1], distinct: dates.length };
};

/** Min timestamp + distinct count of a field's sampled full-timestamp values (ISO sorts chronologically). */
const timestampStats = (values: ReadonlyArray<unknown>): { readonly min: string; readonly distinct: number } | undefined => {
  const stamps = [...new Set(values.map(v => String(v)))].sort();
  return stamps.length === 0 ? undefined : { min: stamps[0], distinct: stamps.length };
};

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

/** Choose the field for the timestamp scenarios. The `lt/le now()` scenarios need a field guaranteed to be
 *  <= now, or a future-dated datetime (OpenHouse start times, Showing appointments) legitimately returns empty
 *  for `lt now()` and would false-fail a compliant server. Prefer ModificationTimestamp (RESO-required, always
 *  past); else another standard `*Timestamp` field (system modification/event timestamps, likewise always past);
 *  else a generic populated datetime (last resort — a resource with no timestamp field is a DD-gate failure). */
export const selectTimestampField = (
  datetimeFields: ReadonlyArray<string>,
  records: ReadonlyArray<Record<string, unknown>>,
): string | undefined => {
  const isStandardTimestamp = (f: string): boolean => f.endsWith('Timestamp');
  return (
    (datetimeFields.includes('ModificationTimestamp') && records.some(r => r['ModificationTimestamp'] != null)
      ? 'ModificationTimestamp'
      : undefined)
    ?? datetimeFields.filter(isStandardTimestamp).find(f => records.some(r => r[f] != null))
    ?? findFullyPopulatedTimestamp(datetimeFields, records)
    ?? datetimeFields.find(f => records.some(r => r[f] != null))
  );
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
  enumTypes: ReadonlyArray<CsdlEnumType>,
  standardMap: StandardMap,
  enumModeOverride?: EnumMode,
): Promise<TestParams> => {
  // enumMode is retained as an informational/coverage field only — selection and gating are now per-field
  // (resolveEnum), so the `--enumMode` override no longer steers field choice. Vestigial; a candidate for removal.
  const enumMode = enumModeOverride ?? detectEnumMode(entityType);
  const keyField = entityType.keyProperties[0] ?? 'ListingKey';
  const skippedTypes: string[] = [];

  // Fetch sample records. 1000 (up from 100) gives far better field/value coverage for enum selection —
  // more fields are populated across the wider sample — while staying a single fast request.
  const url = `${buildResourceUrl(serverUrl, resource)}?$top=${SAMPLE_TOP}`;
  const response = await odataRequest({ method: 'GET', url, authToken });
  const body = response.body as { value?: ReadonlyArray<Record<string, unknown>> } | null;
  const records = body?.value ?? [];
  // Was this page the COMPLETE resource? Drives the ne/gt/lt empty-verdict's pass-vs-skip split. A full page
  // (== SAMPLE_TOP) with no nextLink may still be `$top`-capped, so require BOTH no-nextLink AND a short page.
  const sampleComplete = isSampleComplete(body) && records.length < SAMPLE_TOP;

  if (records.length === 0) {
    return { resource, keyField, keyValue: '', enumMode, integerValueHigh: 2147483647, sampleComplete, skippedTypes: ['all — no records found'] };
  }

  const keyValue = String(records[0][keyField] ?? '');

  // Categorize fields by type
  const integerFields = entityType.properties.filter(p => isIntegerType(p.type)).map(p => p.name);
  const decimalFields = entityType.properties.filter(p => isDecimalType(p.type)).map(p => p.name);
  const dateFields = entityType.properties.filter(p => isDateType(p.type)).map(p => p.name);
  const datetimeFields = entityType.properties.filter(p => isDateTimeType(p.type)).map(p => p.name);
  // Enum fields: classify each by its REAL representation (resolveEnum), decode its sampled values, and
  // rank candidates standard-first — replacing the resource-wide name-shape heuristic. A ladder of up to 3
  // per group lets the runner try alternates when a field isn't queryable.
  const singleLookupCandidates = selectEnumCandidates(entityType.properties, records, enumTypes, standardMap, resource, isSingleRep);
  const multiLookupCandidates = selectEnumCandidates(entityType.properties, records, enumTypes, standardMap, resource, isMultiRep);

  // Resolve integer field + values. median → eq/ge/le/ne; min → gt; max → lt (the gt/lt targets must be the
  // extremes so a match exists iff another value lies beyond them — the empty-verdict gates gt/lt on distinct).
  const intResult = findBestField(integerFields, records);
  const integerField = intResult?.field;
  const intStats = intResult ? numericStats(intResult.values) : undefined;
  const integerValueLow = intStats?.median;
  const integerValueMin = intStats?.min;
  const integerValueMax = intStats?.max;
  const integerDistinctCount = intStats?.distinct;
  if (!integerField) skippedTypes.push('integer');
  const integerNotSentinel = intResult ? integerNotSentinelFor(intResult.values) : undefined;

  // Resolve decimal field + values (same median/min/max scheme).
  const decResult = findBestField(decimalFields, records);
  const decimalField = decResult?.field;
  const decStats = decResult ? numericStats(decResult.values) : undefined;
  const decimalValueLow = decStats?.median;
  const decimalValueHigh = decStats?.median; // le uses the high slot; median satisfies le (all ≤ median)
  const decimalValueMin = decStats?.min;
  const decimalValueMax = decStats?.max;
  const decimalDistinctCount = decStats?.distinct;
  if (!decimalField) skippedTypes.push('decimal');

  // Resolve date field + values.
  const dateResult = findBestField(dateFields, records);
  const dateField = dateResult?.field;
  const dtStats = dateResult ? dateStats(dateResult.values) : undefined;
  const dateValue = dtStats?.median;
  const dateValueMin = dtStats?.min;
  const dateValueMax = dtStats?.max;
  const dateDistinctCount = dtStats?.distinct;
  if (!dateField) skippedTypes.push('date');

  // Resolve timestamp field + value (prefer fully populated for orderby). datetimeValue = sampled MIN (feeds
  // gt/ge); the previous first-seen value was the global MAX under a `…DESC` default sort → `gt max` false-fail.
  const timestampField = selectTimestampField(datetimeFields, records);
  const tsStats = timestampField ? timestampStats(collectValues(records, timestampField)) : undefined;
  const datetimeValue = tsStats?.min;
  const datetimeDistinctCount = tsStats?.distinct;
  if (!timestampField) skippedTypes.push('timestamp');

  // Primary field per slot = the top-ranked candidate (standard-first). Values come from the field's own
  // decoded samples, so they are type-correct for it; values[1]/[2] feed the has-and / in scenarios.
  const single = singleLookupCandidates[0];
  const singleLookupField = single?.field;
  const singleLookupValue = single?.values[0];
  const singleLookupValue2 = single?.values[1];
  const singleLookupValue3 = single?.values[2];
  if (!singleLookupField) skippedTypes.push('singleLookup');

  const multi = multiLookupCandidates[0];
  const multiLookupField = multi?.field;
  const multiLookupValue1 = multi?.values[0];
  const multiLookupValue2 = multi?.values[1];
  if (!multiLookupField) skippedTypes.push('multiLookup');

  // Resolve a plain string field + sample substring for the optional string
  // function tests (contains/startswith/endswith). v2.1.0.
  const stringSample = entityType.properties
    .filter(p => p.type === 'Edm.String' && !p.annotations?.['RESO.OData.Metadata.LookupName'])
    .map(p => {
      const vals = collectValues(records, p.name);
      const val = vals.length > 0 ? String(vals[0]) : '';
      return val.length >= 3 ? { field: p.name, value: val.slice(0, Math.min(5, val.length)) } : undefined;
    })
    .find((m): m is { field: string; value: string } => m != null);
  const stringField = stringSample?.field;
  const stringValue = stringSample?.value;

  // LookupName per candidate field (from the RESO.OData.Metadata.LookupName annotation — string lookups
  // only; enum-typed fields have no Lookup Resource) for the Lookup Resource validation scenario.
  const lookupNameByField: Record<string, string> = {};
  for (const candidate of [...singleLookupCandidates, ...multiLookupCandidates]) {
    const lookupName = entityType.properties.find(p => p.name === candidate.field)?.annotations?.['RESO.OData.Metadata.LookupName'];
    if (typeof lookupName === 'string' && lookupName) {
      lookupNameByField[candidate.field] = lookupName;
    }
  }

  return {
    resource,
    keyField,
    keyValue,
    enumMode,
    integerField,
    integerValueLow,
    integerValueHigh: 2147483647,
    integerValueMin,
    integerValueMax,
    integerNotSentinel,
    decimalField,
    decimalValueLow,
    decimalValueHigh,
    decimalValueMin,
    decimalValueMax,
    dateField,
    dateValue,
    dateValueMin,
    dateValueMax,
    timestampField,
    datetimeValue,
    sampleComplete,
    // Distinct value counts (NUMERICALLY deduped for numerics — see numericStats) — the ne/gt/lt verdict's gate.
    integerDistinctCount,
    decimalDistinctCount,
    dateDistinctCount,
    datetimeDistinctCount,
    singleLookupField,
    singleLookupValue,
    singleLookupValue2,
    singleLookupValue3,
    ...(single && { singleLookupFieldRep: single.representation }),
    ...(single?.enumType && { singleLookupEnumType: single.enumType }),
    ...(single && { singleLookupDistinctCount: single.distinctValueCount }),
    singleLookupCandidates,
    multiLookupField,
    multiLookupValue1,
    multiLookupValue2,
    ...(multi && { multiLookupFieldRep: multi.representation }),
    ...(multi?.enumType && { multiLookupEnumType: multi.enumType }),
    ...(multi && { multiLookupDistinctCount: multi.distinctValueCount }),
    multiLookupCandidates,
    stringField,
    stringValue,
    lookupNameByField: Object.keys(lookupNameByField).length ? lookupNameByField : undefined,
    skippedTypes,
  };
};
