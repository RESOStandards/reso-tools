/**
 * Assemble an inferred DD-2.0 metadata report from RCF records (C5 + assembly), every record folded in as it is read.
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
import { type FieldTypeState, addToFieldType, fieldTypeOf, mergeFieldTypes, newFieldTypeState } from './aggregate.js';
import { type KindMatcher, buildKindMatcher } from './kind-match.js';
import { ENUM_MAX_DISTINCT, classifyStringField } from './local-enum-detection.js';
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

export interface InferMetadataReportInput {
  /** Records grouped by (root) resource name. Expansions are discovered by recursion. */
  readonly recordsByResource: Readonly<Record<string, ReadonlyArray<unknown>>>;
  /** Reference DD metadata map (`buildMetadataMap(getReferenceMetadata(version))`). */
  readonly referenceMap: ReferenceMap;
  readonly version: string;
  /** ISO timestamp for the report; injected so this function stays deterministic. */
  readonly generatedOn: string;
  readonly description?: string;
}

/** What a report is stamped with. */
export interface InferredReportMeta {
  readonly version: string;
  readonly generatedOn: string;
  readonly description?: string;
}

const DEFAULT_DESCRIPTION = 'RESO Data Dictionary Metadata Report (inferred from RESO Common Format samples)';

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Key a resolved expansion kind by its parent resource + field name. */
const kindKey = (resource: string, field: string): string => `${resource} ${field}`;

/**
 * Where an observation falls in reading order: every record of the first resource the files named, then every
 * record of the next, and within a resource in the order read. Each resource counts up within its own stride, so
 * records that arrive interleaved across files still order as if read a resource at a time. The report's resources,
 * fields and lookup values take that order.
 */
type Order = number;
const ORDER_STRIDE = 2 ** 40;

/** Remember a value at the earliest place it was seen. */
const seeAt = (seen: Map<string, Order>, value: string, at: Order): void => {
  const earlier = seen.get(value);
  if (earlier === undefined || at < earlier) seen.set(value, at);
};

/** Values in the order they were first seen. */
const inOrder = (seen: ReadonlyMap<string, Order>): ReadonlyArray<string> => [...seen].sort((a, b) => a[1] - b[1]).map(([value]) => value);

/**
 * The non-blank string values of one observation. A multi-value (collection) observation is an array, so its
 * elements count: otherwise every value of a DD collection lookup (Appliances, ExteriorFeatures, …) would be dropped
 * and the field would emit no lookups.
 */
const stringsOf = (value: unknown): ReadonlyArray<string> =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && isValidValue(v));

/**
 * A local field's type, and its usable string values for telling an enumeration from free text. A field with more
 * distinct values than a local enumeration can have is free text, so no more are kept past that.
 */
interface LocalFold {
  readonly type: FieldTypeState;
  usable: number;
  readonly values: Map<string, Order>;
}

/** What the report needs of one field, gathered a value at a time at one place in the records. */
interface FieldFold {
  readonly first: Order;
  observations: number;
  /** Every distinct value, kept when the field is, or may turn out to be, a Data Dictionary lookup field. */
  readonly lookupValues?: Map<string, Order>;
  /** Kept when the field is, or may turn out to be, a local field. */
  readonly local?: LocalFold;
}

const mergeSeen = (a?: ReadonlyMap<string, Order>, b?: ReadonlyMap<string, Order>): Map<string, Order> | undefined => {
  if (!a || !b) return a || b ? new Map(a ?? b) : undefined;
  const merged = new Map(a);
  for (const [value, at] of b) seeAt(merged, value, at);
  return merged;
};

const mergeLocal = (a?: LocalFold, b?: LocalFold): LocalFold | undefined =>
  a && b
    ? { type: mergeFieldTypes(a.type, b.type), usable: a.usable + b.usable, values: mergeSeen(a.values, b.values) ?? new Map() }
    : (a ?? b);

/** One field's folds from two places in the records that turned out to be the same field. */
const mergeFields = (a: FieldFold, b: FieldFold): FieldFold => {
  const lookupValues = mergeSeen(a.lookupValues, b.lookupValues);
  const local = mergeLocal(a.local, b.local);
  return {
    first: Math.min(a.first, b.first),
    observations: a.observations + b.observations,
    ...(lookupValues ? { lookupValues } : {}),
    ...(local ? { local } : {})
  };
};

/**
 * One place in the records: a resource the files name, or a nested object reached from one through a field. Fields are
 * folded where they are found and filed under their resource at the end, when the shapes of mis-named expansions have
 * been matched, so the records are read once.
 */
interface PathNode {
  /** The context expansion shapes are collected under: the resource, a DD expansion's typeName or the field's name. */
  readonly observed: string;
  /** Whether the node's resource is known as it is read: a root, or reached only through DD expansions. A node at or
   *  below an unknown nested object goes where its shape resolves, which is known only once every record is read. */
  readonly known: boolean;
  records: number;
  readonly fields: Map<string, FieldFold>;
  readonly children: Map<string, PathNode>;
}

const newPathNode = (observed: string, known: boolean): PathNode => ({
  observed,
  known,
  records: 0,
  fields: new Map(),
  children: new Map()
});

/** String values kept per field of an unknown expansion, for the enum overlap of kind matching. */
const SHAPE_VALUE_SAMPLE = 50;

/**
 * The UNION field-shape (+ sample string values) of an UNKNOWN expansion: a nested object under a field that is NOT a
 * DD expansion of its parent, keyed by parent + field. Union over all records, not the first, so a jagged first record
 * can't starve the match. The sample values are the first read, per field.
 */
interface ShapeFold {
  readonly first: Order;
  readonly fields: Map<string, Order>;
  readonly values: Map<string, { readonly first: Order; readonly byRoot: Map<number, string[]> }>;
}

interface ObservedShape {
  readonly fields: ReadonlyArray<string>;
  readonly enumVals: Readonly<Record<string, ReadonlyArray<string>>>;
}

/**
 * Resolve each unknown expansion's shape to a DD resource via kind matching (conservative; unmatched shapes are absent
 * from the map → they stay local objects). The parent resource is EXCLUDED so a provider flattening of the parent's
 * own fields does not self-match. `shapes` are in reading order.
 */
const resolveExpansionKinds = (
  shapes: ReadonlyArray<readonly [string, ObservedShape]>,
  matcher: KindMatcher
): ReadonlyMap<string, string> => {
  const matchShape = (shape: ObservedShape, exclude: ReadonlyArray<string>): string | undefined =>
    matcher.match({ fields: [...shape.fields], enumValuesByField: shape.enumVals, exclude: [...exclude] })?.resource;

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

  // Re-key by the RESOLVED parent context. Shapes are collected under OBSERVED names, but the fold
  // keys fields under their resolved resource, so a nested resolution must be looked up under the
  // resolved parent, or a depth-≥2 rename is stored under one key and read under another and never
  // resolves. A parent that is itself a resolved rename contributes its resolved name; a root resource
  // is unchanged.
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
    // null/blank carries no lookups, so claiming isEnumeration would be inconsistent
    // (nothing to re-read, an empty enum downstream). Keep isEnumeration ⟺ has-lookups.
    ...(isEnumeration ? { isEnumeration: true } : {}),
    annotations: ref.ddWikiUrl ? [{ term: DD_WIKI_URL_TERM, value: ref.ddWikiUrl }] : []
  };
};

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
const ddLookups = (ref: ReferenceField, values: ReadonlyArray<string>): MetadataReportLookup[] =>
  values.map(value => {
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
  local: LocalFold,
  nullableByAbsence: boolean,
  // The DD resource a mis-named expansion's SHAPE matched, if any → becomes the field's typeName.
  inferredKind?: string
): { readonly field: MetadataReportField; readonly lookups: ReadonlyArray<MetadataReportLookup> } => {
  const agg = fieldTypeOf(local.type);
  const extra: Partial<MetadataReportField> = {
    ...(agg.isCollection ? { isCollection: true } : {}),
    // typeName must equal the recursion target so the schema $ref (#/definitions/<typeName>)
    // resolves: the field name for an unmatched local object, or the matched DD resource for a
    // mis-named expansion (fieldName ≠ typeName is then the inferred-mismatch signal).
    ...(agg.isExpansion ? { isExpansion: true, typeName: inferredKind ?? field } : {}),
    ...(agg.nullable || nullableByAbsence ? { nullable: true } : {}),
    ...(agg.maxLength ? { maxLength: agg.maxLength } : {}),
    ...(agg.scale ? { scale: agg.scale } : {}),
    ...(agg.precision ? { precision: agg.precision } : {})
  };

  if (
    agg.type === 'Edm.String' &&
    !agg.isExpansion &&
    classifyStringField({ total: local.usable, distinct: local.values.size }) === 'enum'
  ) {
    const lookupName = `${resource}.${field}`;
    const lookups = inOrder(local.values).map(value => ({ lookupName, lookupValue: value, type: 'Edm.String' }));
    return { field: localScalarField(resource, field, lookupName, extra), lookups };
  }
  return { field: localScalarField(resource, field, agg.type, extra), lookups: [] };
};

/** An inferred metadata report, gathered a record at a time. */
export interface RcfInference {
  /** Fold in one record of a resource the files name. Its expansions are folded in under their own resources. */
  readonly add: (resource: string, record: unknown) => void;
  readonly report: (meta: InferredReportMeta) => MetadataReport;
}

/**
 * Infer a DD-2.0 metadata report from RCF records, folding each record in as it is read so no record is held and the
 * records are read once. Holds per field a count, the field's type and its distinct lookup values, so memory grows
 * with the distinct values in the data, never with the number of records. Every record counts: there is no sample.
 *
 * A DD expansion recurses under its reference `typeName`; a mis-named expansion whose SHAPE matched a DD resource
 * recurses under that resource, so its nested fields type against the DD reference; an unmatched local nested object
 * recurses under the field name. `@…` keys are skipped. Which mis-named expansion matches what is known only once
 * every record is read, so the fields below one are folded where they are found, keeping what either outcome needs,
 * and filed under their resource when the report is made.
 */
export const createRcfInference = (referenceMap: ReferenceMap): RcfInference => {
  // A field below an unknown nested object may turn out to be a DD lookup field of the resource the object matches.
  // Every distinct value is kept for a field with such a name; any other field is local or a DD non-lookup field
  // wherever it lands.
  const ddLookupNames = new Set(
    Object.values(referenceMap).flatMap(fields =>
      Object.entries(fields)
        .filter(([, ref]) => ref.isLookupField)
        .map(([name]) => name)
    )
  );
  const roots = new Map<string, { readonly index: number; read: number; readonly node: PathNode }>();
  const shapes = new Map<string, ShapeFold>();

  const observe = (node: PathNode, field: string, value: unknown, next: () => Order): void => {
    const fold =
      node.fields.get(field) ??
      ((): FieldFold => {
        const ref = node.known ? referenceMap[node.observed]?.[field] : undefined;
        const keepLookupValues = node.known ? ref?.isLookupField === true : ddLookupNames.has(field);
        const keepLocal = !node.known || !ref;
        const created: FieldFold = {
          first: next(),
          observations: 0,
          ...(keepLookupValues ? { lookupValues: new Map<string, Order>() } : {}),
          ...(keepLocal ? { local: { type: newFieldTypeState(), usable: 0, values: new Map<string, Order>() } } : {})
        };
        node.fields.set(field, created);
        return created;
      })();
    fold.observations += 1;
    if (fold.lookupValues) for (const s of stringsOf(value)) seeAt(fold.lookupValues, s, next());
    if (fold.local) {
      const { local } = fold;
      addToFieldType(local.type, value);
      for (const s of stringsOf(value)) {
        if (isNumericToken(s)) continue;
        local.usable += 1;
        const at = next();
        if (local.values.has(s) || local.values.size <= ENUM_MAX_DISTINCT) seeAt(local.values, s, at);
      }
    }
  };

  const collectShape = (key: string, nested: ReadonlyArray<Record<string, unknown>>, rootIndex: number, next: () => Order): void => {
    const shape = shapes.get(key) ?? { first: next(), fields: new Map<string, Order>(), values: new Map() };
    shapes.set(key, shape);
    for (const obj of nested) {
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('@')) continue;
        seeAt(shape.fields, k, next());
        if (typeof v === 'string' && v !== '') {
          const forField = shape.values.get(k) ?? { first: next(), byRoot: new Map<number, string[]>() };
          shape.values.set(k, forField);
          const sample = forField.byRoot.get(rootIndex) ?? [];
          forField.byRoot.set(rootIndex, sample);
          if (sample.length < SHAPE_VALUE_SAMPLE) sample.push(v); // a sample is enough for enum overlap
        }
      }
    }
  };

  const visit = (records: ReadonlyArray<unknown>, node: PathNode, rootIndex: number, next: () => Order): void => {
    for (const record of records) {
      if (!isPlainObject(record)) continue;
      node.records += 1;
      for (const [field, value] of Object.entries(record)) {
        if (field.startsWith('@')) continue; // OData/RESO annotations, not data fields
        observe(node, field, value, next);
        const nested = Array.isArray(value) ? value.filter(isPlainObject) : isPlainObject(value) ? [value] : [];
        if (nested.length === 0) continue;
        const ref = referenceMap[node.observed]?.[field];
        if (!ref?.isExpansion) collectShape(kindKey(node.observed, field), nested, rootIndex, next);
        const child =
          node.children.get(field) ??
          newPathNode(ref?.isExpansion ? ref.typeName || field : field, node.known && ref?.isExpansion === true);
        node.children.set(field, child);
        visit(nested, child, rootIndex, next);
      }
    }
  };

  const add = (resource: string, record: unknown): void => {
    const root = roots.get(resource) ?? { index: roots.size, read: 0, node: newPathNode(resource, true) };
    roots.set(resource, root);
    const next = (): Order => {
      root.read += 1;
      return root.index * ORDER_STRIDE + root.read;
    };
    visit([record], root.node, root.index, next);
  };

  /** The DD resources the shapes of mis-named expansions matched, keyed by parent and field. */
  const resolvedKinds = (): ReadonlyMap<string, string> => {
    const observed = [...shapes]
      .sort((a, b) => a[1].first - b[1].first)
      .map(([key, shape]): readonly [string, ObservedShape] => [
        key,
        {
          fields: inOrder(shape.fields),
          enumVals: Object.fromEntries(
            [...shape.values]
              .sort((a, b) => a[1].first - b[1].first)
              .map(([field, { byRoot }]) => [
                field,
                [...byRoot]
                  .sort((a, b) => a[0] - b[0])
                  .flatMap(([, sample]) => sample)
                  .slice(0, SHAPE_VALUE_SAMPLE)
              ])
          )
        }
      ]);
    return resolveExpansionKinds(observed, buildKindMatcher(referenceMap));
  };

  const report = ({ version, generatedOn, description = DEFAULT_DESCRIPTION }: InferredReportMeta): MetadataReport => {
    const kinds = resolvedKinds();
    // File every place in the records under its resource: where it was read when known, and otherwise where its
    // parent's resource and the matched shapes put it. Places that land on the same resource field merge.
    const filed = new Map<string, { records: number; readonly fields: Map<string, FieldFold> }>();
    const file = (node: PathNode, resource: string): void => {
      const into = filed.get(resource) ?? { records: 0, fields: new Map<string, FieldFold>() };
      filed.set(resource, into);
      into.records += node.records;
      for (const [field, fold] of node.fields) {
        const earlier = into.fields.get(field);
        into.fields.set(field, earlier ? mergeFields(earlier, fold) : fold);
      }
      for (const [field, child] of node.children) {
        const ref = referenceMap[resource]?.[field];
        // kinds is keyed by the RESOLVED parent context (see resolveExpansionKinds), so a nested (depth ≥2) rename
        // resolves, not just top-level ones.
        file(child, ref?.isExpansion ? ref.typeName || field : (kinds.get(kindKey(resource, field)) ?? field));
      }
    };
    for (const [resource, { node }] of roots) file(node, resource);

    const byResource = [...filed]
      .filter(([, { fields }]) => fields.size > 0)
      .map(([resource, { records, fields }]) => ({ resource, records, fields: [...fields].sort((a, b) => a[1].first - b[1].first) }))
      .sort((a, b) => a.fields[0][1].first - b.fields[0][1].first);
    const fields: MetadataReportField[] = [];
    const lookups: MetadataReportLookup[] = [];
    for (const { resource, records, fields: resourceFields } of byResource) {
      for (const [field, fold] of resourceFields) {
        // Jagged data: a field observed fewer times than the resource's record count was absent
        // from some records → nullable.
        const nullableByAbsence = records > 0 && fold.observations < records;
        const ref = referenceMap[resource]?.[field];
        if (ref) {
          const fieldLookups = ref.isLookupField && fold.lookupValues ? ddLookups(ref, inOrder(fold.lookupValues)) : [];
          fields.push(ddFieldFromReference(resource, field, ref, fieldLookups.length > 0, nullableByAbsence));
          // Append element-wise, not `push(...fieldLookups)`: a spread of a very large distinct-value
          // set would overflow the argument-count limit.
          for (const l of fieldLookups) lookups.push(l);
        } else if (fold.local) {
          const built = localFieldAndLookups(resource, field, fold.local, nullableByAbsence, kinds.get(kindKey(resource, field)));
          fields.push(built.field);
          for (const l of built.lookups) lookups.push(l);
        }
      }
    }
    const resources = byResource.map(({ resource }) => ({ resourceName: resource }));
    return { description, version, generatedOn, resources, fields, lookups, actions: [], functions: [] };
  };

  return { add, report };
};

/**
 * Infer a DD-2.0 metadata report from RCF records grouped by resource. Mis-named expansions are resolved from their
 * shapes, then the records are placed and described consistently: under the matched resource, with the parent field
 * typed to it.
 */
export const inferMetadataReport = (input: InferMetadataReportInput): MetadataReport => {
  const inference = createRcfInference(input.referenceMap);
  for (const [resource, records] of Object.entries(input.recordsByResource)) for (const record of records) inference.add(resource, record);
  return inference.report(input);
};
