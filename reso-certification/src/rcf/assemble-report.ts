/**
 * Assemble an inferred DD-2.0 metadata report from sampled RCF records (C5 + assembly).
 *
 * Ties the inference pieces together. For each observed (resource, field):
 *   - DD field (present in the injected reference map) → carry the reference
 *     TYPE and shape (ground truth, never inferred). If it is a lookup field,
 *     emit its observed values as lookups, annotating the ones that match the
 *     reference StandardName (`lookupValues`) / LegacyOData (`legacyODataValues`)
 *     sets with their `RESO.DDWikiUrl`.
 *   - Local field (absent from the reference) → infer the type by aggregation;
 *     an all-`Edm.String` field that reads as an enumeration (bounded, repeating)
 *     emits local lookups (`Edm.String`), otherwise it is a plain string field.
 *
 * The reference map is injected (built from `buildMetadataMap(getReferenceMetadata(version))`
 * by the caller) so this module stays pure and unit-testable with fixtures.
 *
 * OPEN (validate in the e2e against the variations service): for a DD lookup
 * field we emit ALL observed distinct values — the reference-matching ones for
 * context and the NON-matching ones so the variations service can flag them as
 * value variations. If the service expects only matching values, restrict the
 * emission in the command layer; it is a one-line filter here.
 */

import type { MetadataReport, MetadataReportField, MetadataReportLookup } from '@reso-standards/reso-metadata-utils';
import { aggregateFieldType } from './aggregate.js';
import { type KindMatcher, buildKindMatcher } from './kind-match.js';
import { classifyStringField, stringFieldStats } from './local-enum-detection.js';
import { isNumericToken, isValidValue } from './values.js';

const DD_WIKI_URL_TERM = 'RESO.DDWikiUrl';

/** A reference lookup value entry, as produced by `buildMetadataMap`. */
export interface ReferenceLookupEntry {
  readonly type: string;
  readonly lookupName: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly ddWikiUrl?: string;
  readonly standardLookupValue?: string;
  readonly isStringEnumeration?: boolean;
}

/** A reference field entry, as produced by `buildMetadataMap` (`map[resource][field]`). */
export interface ReferenceField {
  readonly type: string;
  readonly typeName?: string;
  readonly nullable?: boolean;
  readonly isExpansion?: boolean;
  readonly isCollection?: boolean;
  readonly isLookupField?: boolean;
  readonly isComplexType?: boolean;
  readonly ddWikiUrl?: string;
  readonly lookupValues?: Readonly<Record<string, ReferenceLookupEntry>>;
  readonly legacyODataValues?: Readonly<Record<string, ReferenceLookupEntry>>;
}

export type ReferenceMap = Readonly<Record<string, Readonly<Record<string, ReferenceField>>>>;

/** Accumulated observed values per resource → field. */
export type PayloadCache = Record<string, Record<string, unknown[]>>;

export interface InferMetadataReportInput {
  /** Sampled records grouped by (root) resource name. Expansions are discovered by recursion. */
  readonly recordsByResource: Readonly<Record<string, ReadonlyArray<unknown>>>;
  /** Reference DD metadata map (`buildMetadataMap(getReferenceMetadata(version))`). */
  readonly referenceMap: ReferenceMap;
  readonly version: string;
  /** ISO timestamp for the report; injected so this function stays deterministic. */
  readonly generatedOn: string;
  readonly description?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const push = (cache: PayloadCache, resource: string, field: string, value: unknown): void => {
  cache[resource] ??= {};
  cache[resource][field] ??= [];
  cache[resource][field].push(value);
};

/** Key a resolved expansion kind by its parent resource + field name. */
const kindKey = (resource: string, field: string): string => `${resource} ${field}`;

interface ObservedShape {
  readonly fields: Set<string>;
  readonly enumVals: Map<string, string[]>;
}

/**
 * Pre-pass: collect the UNION field-shape (+ sample string values) of every UNKNOWN expansion — a
 * nested object under a field that is NOT a DD expansion of its parent — keyed by parent + field.
 * Union over all records, not the first, so a jagged first record can't starve the match.
 */
const collectExpansionShapes = (
  records: ReadonlyArray<unknown>,
  resourceName: string,
  referenceMap: ReferenceMap,
  shapes: Map<string, ObservedShape>
): void => {
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    for (const [field, value] of Object.entries(record)) {
      if (field.startsWith('@')) continue;
      const nested = Array.isArray(value) ? value.filter(isPlainObject) : isPlainObject(value) ? [value] : [];
      if (nested.length === 0) continue;
      const ref = referenceMap[resourceName]?.[field];
      if (!ref?.isExpansion) {
        const key = kindKey(resourceName, field);
        const shape = shapes.get(key) ?? { fields: new Set<string>(), enumVals: new Map<string, string[]>() };
        for (const obj of nested) {
          for (const [k, v] of Object.entries(obj)) {
            if (k.startsWith('@')) continue;
            shape.fields.add(k);
            if (typeof v === 'string' && v !== '') {
              const arr = shape.enumVals.get(k) ?? [];
              if (arr.length < 50) arr.push(v); // a sample is enough for enum overlap
              shape.enumVals.set(k, arr);
            }
          }
        }
        shapes.set(key, shape);
      }
      const target = ref?.isExpansion ? ref.typeName || field : field; // observed-name context for collection
      collectExpansionShapes(nested, target, referenceMap, shapes);
    }
  }
};

/**
 * Resolve each unknown expansion's shape to a DD resource via kind matching (conservative; unmatched
 * shapes are absent from the map → they stay local objects). The parent resource is EXCLUDED so a
 * provider flattening of the parent's own fields does not self-match.
 */
const resolveExpansionKinds = (
  recordsByResource: Readonly<Record<string, ReadonlyArray<unknown>>>,
  referenceMap: ReferenceMap,
  matcher: KindMatcher
): ReadonlyMap<string, string> => {
  const shapes = new Map<string, ObservedShape>();
  for (const [resource, records] of Object.entries(recordsByResource)) collectExpansionShapes(records, resource, referenceMap, shapes);
  const matchShape = (shape: ObservedShape, exclude: ReadonlyArray<string>): string | undefined =>
    matcher.match({ fields: [...shape.fields], enumValuesByField: Object.fromEntries(shape.enumVals), exclude: [...exclude] })?.resource;

  // Pass 1: preliminary resolution excluding only the observed parent (correct at depth 1).
  const prelim = new Map<string, string>();
  for (const [key, shape] of shapes) {
    const parent = key.slice(0, key.indexOf(' '));
    const r = matchShape(shape, [parent]);
    if (r) prelim.set(key, r);
  }
  // Pass 2: also exclude the parent's RESOLVED name, so a depth-≥2 flattening of the resolved
  // parent's own fields cannot self-match — the depth-1 self-flatten guard, extended to nested
  // renames now that they resolve. (Depth-1 keys have no resolved parent, so this is a no-op there.)
  const resolved = new Map<string, string>();
  for (const [key, shape] of shapes) {
    const parent = key.slice(0, key.indexOf(' '));
    const parentResolved = [...prelim].find(([k]) => k.endsWith(` ${parent}`))?.[1];
    const r = matchShape(shape, parentResolved ? [parent, parentResolved] : [parent]);
    if (r) resolved.set(key, r);
  }

  // Re-key by the RESOLVED parent context. Shapes are collected under OBSERVED names, but the payload
  // cache stores fields under their resolved resource — so buildPayloadCache and assembleReport (both
  // keyed by resolved resource name) must look a nested resolution up under the resolved parent, or a
  // depth-≥2 rename is stored under one key and read under another and never resolves. A parent that is
  // itself a resolved rename contributes its resolved name; a root resource is unchanged.
  const byResolvedContext = new Map<string, string>();
  for (const [key, resource] of resolved) {
    const sep = key.indexOf(' ');
    const observedParent = key.slice(0, sep);
    const field = key.slice(sep + 1);
    const parentKey = [...resolved.keys()].find(k => k.endsWith(` ${observedParent}`));
    const resolvedParent = parentKey ? (resolved.get(parentKey) ?? observedParent) : observedParent;
    byResolvedContext.set(kindKey(resolvedParent, field), resource);
  }
  return byResolvedContext;
};

/**
 * Accumulate observed values per (resource, field), recursing into nested objects
 * as expansions. A DD expansion's target resource comes from the reference
 * `typeName`; a mis-named expansion whose SHAPE matched a DD resource (`resolvedKinds`)
 * recurses under that resource, so its nested fields type against the DD reference; an
 * unmatched local nested object recurses under the field name. `@…` keys are skipped.
 */
export const buildPayloadCache = (
  records: ReadonlyArray<unknown>,
  resourceName: string,
  referenceMap: ReferenceMap,
  cache: PayloadCache = {},
  // Records seen per resource — a field observed fewer times than its resource's record count
  // was absent from some records (jagged data), which the assembler treats as nullable.
  recordCounts: Record<string, number> = {},
  resolvedKinds: ReadonlyMap<string, string> = new Map()
): PayloadCache => {
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    recordCounts[resourceName] = (recordCounts[resourceName] ?? 0) + 1;
    for (const [field, value] of Object.entries(record)) {
      if (field.startsWith('@')) continue; // OData/RESO annotations, not data fields
      push(cache, resourceName, field, value);

      const ref = referenceMap[resourceName]?.[field];
      // resolvedKinds is keyed by the RESOLVED parent context (see resolveExpansionKinds), matching
      // resourceName / the cache — so a nested (depth ≥2) rename resolves, not just top-level ones.
      const target = ref?.isExpansion ? ref.typeName || field : (resolvedKinds.get(kindKey(resourceName, field)) ?? field);
      if (Array.isArray(value) && value.some(isPlainObject)) {
        buildPayloadCache(value.filter(isPlainObject), target, referenceMap, cache, recordCounts, resolvedKinds);
      } else if (isPlainObject(value)) {
        buildPayloadCache([value], target, referenceMap, cache, recordCounts, resolvedKinds);
      }
    }
  }
  return cache;
};

const ddFieldFromReference = (
  resource: string,
  field: string,
  ref: ReferenceField,
  isEnumeration: boolean,
  nullableByAbsence: boolean
): MetadataReportField => {
  const nullable = nullableByAbsence || ref.nullable === true;
  return {
    resourceName: resource,
    fieldName: field,
    type: ref.type,
    ...(ref.typeName ? { typeName: ref.typeName } : {}),
    ...(nullable ? { nullable: true } : ref.nullable === false ? { nullable: false } : {}),
    ...(ref.isCollection ? { isCollection: true } : {}),
    ...(ref.isExpansion ? { isExpansion: true } : {}),
    // Only when the field actually emitted observed lookups — a DD enum field whose values were all
    // null/blank in the sample carries no lookups, so claiming isEnumeration would be inconsistent
    // (nothing to re-read, an empty enum downstream). Keep isEnumeration ⟺ has-lookups.
    ...(isEnumeration ? { isEnumeration: true } : {}),
    annotations: ref.ddWikiUrl ? [{ term: DD_WIKI_URL_TERM, value: ref.ddWikiUrl }] : []
  };
};

/**
 * Distinct non-blank string observations of a field, preserving first-seen order.
 * Multi-value (collection) observations are arrays, so they are flattened first —
 * otherwise every value of a DD collection lookup (Appliances, ExteriorFeatures, …)
 * would be dropped and the field would emit no lookups.
 */
const distinctStrings = (values: ReadonlyArray<unknown>): ReadonlyArray<string> => [
  ...new Set(values.flatMap(v => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string' && isValidValue(v)))
];

/**
 * Emit lookups for a DD lookup field: every observed value, annotated when it
 * matches the reference. `lookupName` is the enum FQDN (= the field's `type`) so
 * the field↔lookup link re-serializes correctly — a re-read via `buildMetadataMap`
 * recovers `isLookupField` off `field.type === lookup.lookupName`.
 *
 * `type` is `Edm.String`: RCF gives us observed *string* values (not machine
 * ordinals + display annotations like the canonical serializer), so a string
 * enumeration is both correct for validation and the shape `buildMetadataMap`
 * re-reads back into `lookupValues` (keyed by the observed value).
 */
const ddLookups = (ref: ReferenceField, values: ReadonlyArray<unknown>): MetadataReportLookup[] =>
  distinctStrings(values).map(value => {
    const matched = ref.lookupValues?.[value] ?? ref.legacyODataValues?.[value];
    return {
      lookupName: ref.type,
      lookupValue: value,
      type: 'Edm.String',
      ...(matched?.ddWikiUrl ? { annotations: [{ term: DD_WIKI_URL_TERM, value: matched.ddWikiUrl }] } : {})
    };
  });

const localScalarField = (resource: string, field: string, type: string, extra: Partial<MetadataReportField>): MetadataReportField => ({
  resourceName: resource,
  fieldName: field,
  type,
  ...extra,
  annotations: []
});

/**
 * Build the field + any lookups for a LOCAL (non-DD) field. A repeating,
 * bounded all-string field becomes a local enumeration (field type = the local
 * lookup name `Resource.Field`, one `Edm.String` lookup per distinct value);
 * otherwise it is a plain field of the aggregated type.
 */
const localFieldAndLookups = (
  resource: string,
  field: string,
  values: ReadonlyArray<unknown>,
  nullableByAbsence: boolean,
  // The DD resource a mis-named expansion's SHAPE matched, if any → becomes the field's typeName.
  inferredKind?: string
): { readonly field: MetadataReportField; readonly lookups: ReadonlyArray<MetadataReportLookup> } => {
  const agg = aggregateFieldType(values);
  const extra: Partial<MetadataReportField> = {
    ...(agg.isCollection ? { isCollection: true } : {}),
    // typeName must equal the buildPayloadCache recursion target so the schema $ref
    // (#/definitions/<typeName>) resolves: the field name for an unmatched local object, or the matched
    // DD resource for a mis-named expansion (fieldName ≠ typeName is then the inferred-mismatch signal).
    ...(agg.isExpansion ? { isExpansion: true, typeName: inferredKind ?? field } : {}),
    ...(agg.nullable || nullableByAbsence ? { nullable: true } : {}),
    ...(agg.maxLength ? { maxLength: agg.maxLength } : {}),
    ...(agg.scale ? { scale: agg.scale } : {}),
    ...(agg.precision ? { precision: agg.precision } : {})
  };

  if (agg.type === 'Edm.String' && !agg.isExpansion && classifyStringField(stringFieldStats(values)) === 'enum') {
    const lookupName = `${resource}.${field}`;
    const lookups = distinctStrings(values)
      .filter(v => !isNumericToken(v))
      .map(value => ({ lookupName, lookupValue: value, type: 'Edm.String' }));
    return { field: localScalarField(resource, field, lookupName, extra), lookups };
  }
  return { field: localScalarField(resource, field, agg.type, extra), lookups: [] };
};

/** Assemble the DD-2.0 metadata report from an accumulated payload cache. */
export const assembleReport = (
  cache: PayloadCache,
  referenceMap: ReferenceMap,
  version: string,
  generatedOn: string,
  description = 'RESO Data Dictionary Metadata Report (inferred from RESO Common Format samples)',
  recordCounts: Record<string, number> = {},
  resolvedKinds: ReadonlyMap<string, string> = new Map()
): MetadataReport => {
  const fields: MetadataReportField[] = [];
  const lookups: MetadataReportLookup[] = [];

  for (const [resource, fieldMap] of Object.entries(cache)) {
    const total = recordCounts[resource] ?? 0;
    for (const [field, values] of Object.entries(fieldMap)) {
      // Jagged data: a field observed fewer times than the resource's record count was absent
      // from some records → nullable. (total 0 = counts not supplied; fall back to value-based only.)
      const nullableByAbsence = total > 0 && values.length < total;
      const ref = referenceMap[resource]?.[field];
      if (ref) {
        const fieldLookups = ref.isLookupField ? ddLookups(ref, values) : [];
        fields.push(ddFieldFromReference(resource, field, ref, fieldLookups.length > 0, nullableByAbsence));
        // Append element-wise, not `push(...fieldLookups)`: a spread of a very large distinct-value
        // set would overflow the argument-count limit (cf. `maxOf` in aggregate.ts).
        for (const l of fieldLookups) lookups.push(l);
      } else {
        const built = localFieldAndLookups(resource, field, values, nullableByAbsence, resolvedKinds.get(kindKey(resource, field)));
        fields.push(built.field);
        for (const l of built.lookups) lookups.push(l);
      }
    }
  }

  const resources = Object.keys(cache).map(resourceName => ({ resourceName }));
  return { description, version, generatedOn, resources, fields, lookups, actions: [], functions: [] };
};

/** Infer a DD-2.0 metadata report from sampled RCF records grouped by resource. */
export const inferMetadataReport = (input: InferMetadataReportInput): MetadataReport => {
  const cache: PayloadCache = {};
  const recordCounts: Record<string, number> = {};
  // Resolve mis-named expansions to DD resources from their shape ONCE (union over all records), then
  // place + describe them consistently: recurse under the matched resource, type the parent field to it.
  const matcher = buildKindMatcher(input.referenceMap);
  const resolvedKinds = resolveExpansionKinds(input.recordsByResource, input.referenceMap, matcher);
  for (const [resource, records] of Object.entries(input.recordsByResource)) {
    buildPayloadCache(records, resource, input.referenceMap, cache, recordCounts, resolvedKinds);
  }
  return assembleReport(cache, input.referenceMap, input.version, input.generatedOn, input.description, recordCounts, resolvedKinds);
};
