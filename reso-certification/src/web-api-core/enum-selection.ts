/**
 * Representation-aware enum field selection for Web API Core sampling.
 *
 * Replaces the run-level `EnumMode` name-shape heuristic: each candidate field is classified by its
 * *real* representation via the SDK's `resolveEnum` (kind from the metadata, which the metadata-
 * validation scenario has vetted), its sampled values are `decodeValue`d into member names (handling
 * bitmask / comma / array / scalar), and those members are matched against the DD standard map. The
 * selector returns a *ranked candidate list* per cardinality group — standard fields first, standard
 * values first — so the runner can try alternates (a given field may not be queryable) and only skip
 * when the candidates are exhausted, rather than fail a provider on one unlucky pick.
 *
 * The comparison value always comes from the field's *own* decoded samples, so it is type-correct for
 * that field by construction; the standard map is a quality gate, never a value source.
 */

import { resolveEnum, type EnumRepresentation } from '@reso-standards/reso-client';
import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import type { EntityProperty } from '../test-runner/types.js';
import type { StandardMap } from './standard-map.js';

const LOOKUP_NAME_ANNOTATION = 'RESO.OData.Metadata.LookupName';

/** Single-valued representations — filter with `eq` / `ne` / `in`. */
export const isSingleRep = (rep: EnumRepresentation): boolean => rep === 'SINGLE_ENUM' || rep === 'SINGLE_STRING';

/** Multi-valued representations — `has` for flags, `any` / `all` for collections. */
export const isMultiRep = (rep: EnumRepresentation): boolean =>
  rep === 'FLAGS_ENUM' || rep === 'COLLECTION_ENUM' || rep === 'COLLECTION_STRING';

/** A field the runner can test, with the metadata-derived kind and standard-first sample values. */
export interface EnumCandidate {
  readonly field: string;
  readonly representation: EnumRepresentation;
  /** True when the field is a standard DD field for its resource. */
  readonly isStandard: boolean;
  /** Distinct decoded member values present in the samples, standard values first (for filter tests). */
  readonly values: ReadonlyArray<string>;
  /** The same distinct values, LOCAL-first. The Lookup Resource validation exists to prove the provider's
   *  OWN data values appear in /Lookup, so the values most at risk of being absent (local, non-standard)
   *  must be tested first — the standard-first `values` would bias them away and mask an RCP-039 defect. */
  readonly lookupSampleValues: ReadonlyArray<string>;
  /** Distinct decoded member values in the sample. The `ne` empty-verdict needs ≥2 to prove the field holds
   *  another value (so an empty `ne` result is a defect, not the correct answer). */
  readonly distinctValueCount: number;
  /** Fraction of sampled records that carry a usable value for this field (0–1). A higher fill rate means a
   *  filter built from the field is more likely to match and more resistant to record drift; used to rank. */
  readonly fillRate: number;
  /** LookupName for string-form lookups (the annotation) or the enum type name — for the Lookup Resource scenario. */
  readonly lookupName?: string;
  /** The CSDL enum type for enum-typed representations — lets the runner decode an integer-bitmask response
   *  value back to member names when validating a flags field. Absent for string lookups (no bitmask form). */
  readonly enumType?: CsdlEnumType;
}

/** Decode a field's sampled raw values, ordering distinct members by FREQUENCY (most-common first) and
 *  counting how many records carry a usable value. Frequency is the drift-resistant choice: a value present
 *  in many records survives edits/deletes on an active feed, so a filter built from it can't empty out. */
const decodedMembers = (
  records: ReadonlyArray<Record<string, unknown>>,
  field: string,
  decode: (raw: unknown) => ReadonlyArray<string>,
): { readonly members: ReadonlyArray<string>; readonly fillCount: number } => {
  const counts = new Map<string, number>(); // Map insertion order = first-seen, a stable tiebreak for equal counts
  let fillCount = 0;
  for (const record of records) {
    const decoded = decode(record[field]);
    if (decoded.length > 0) fillCount += 1;
    for (const member of decoded) counts.set(member, (counts.get(member) ?? 0) + 1);
  }
  const members = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([member]) => member);
  return { members, fillCount };
};

/** Build a candidate for one property, or undefined if it is not an enum of the wanted group or has no usable value. */
const buildCandidate = (
  prop: EntityProperty,
  records: ReadonlyArray<Record<string, unknown>>,
  enumTypes: ReadonlyArray<CsdlEnumType>,
  standardMap: StandardMap,
  resource: string,
  wantRep: (rep: EnumRepresentation) => boolean,
): EnumCandidate | undefined => {
  const ef = resolveEnum({ name: prop.name, type: prop.type, ...(prop.annotations && { annotations: prop.annotations }) }, { enumTypes });
  if (!ef || !wantRep(ef.representation)) return undefined;

  const { members, fillCount } = decodedMembers(records, prop.name, ef.decodeValue);
  if (members.length === 0) return undefined; // no sampled value to compare against — not testable

  // Values come from the field's own decoded samples (type-correct by construction), already ordered
  // most-frequent-first by decodedMembers. Filter tests prefer a DD-known value (standard-first); the Lookup
  // Resource validation instead prefers a LOCAL value, because its job is to catch a data value the provider
  // forgot to publish in /Lookup. Partitioning by standard-ness preserves the frequency order within each
  // partition, so values[0] is the most-frequent standard member — DD-known AND drift-resistant. Keep up to 3.
  const isStd = (m: string): boolean => standardMap.isStandardValue(m);
  const standardFirst = [...members.filter(isStd), ...members.filter((m) => !isStd(m))];
  const localFirst = [...members.filter((m) => !isStd(m)), ...members.filter(isStd)];
  const lookupName = prop.annotations?.[LOOKUP_NAME_ANNOTATION] ?? ef.enumType?.name;

  return {
    field: prop.name,
    representation: ef.representation,
    isStandard: standardMap.isStandardField(resource, prop.name),
    values: standardFirst.slice(0, 3),
    lookupSampleValues: localFirst.slice(0, 3),
    distinctValueCount: members.length,
    fillRate: records.length > 0 ? fillCount / records.length : 0,
    ...(lookupName !== undefined && { lookupName }),
    ...(ef.enumType !== undefined && { enumType: ef.enumType }),
  };
};

/**
 * Rank enum candidates of one cardinality group (single vs multi) for a resource. Standard fields first,
 * then local; within each, fields whose first value is a standard DD value first.
 *
 * The FULL ranked list is returned — deliberately uncapped. The multi group mixes operator *families*
 * (FLAGS_ENUM→`has` vs COLLECTION_*→`any`/`all`); capping here would let a higher-ranked family crowd the
 * other's field out of the list before the runner filters by operator, silently skipping a required test.
 * The runner (`runEnumFamilyScenario`) bounds the actual attempts to 3 PER operator family, after it has
 * filtered candidates by the operator each scenario exercises.
 */
export const selectEnumCandidates = (
  properties: ReadonlyArray<EntityProperty>,
  records: ReadonlyArray<Record<string, unknown>>,
  enumTypes: ReadonlyArray<CsdlEnumType>,
  standardMap: StandardMap,
  resource: string,
  wantRep: (rep: EnumRepresentation) => boolean,
): ReadonlyArray<EnumCandidate> => {
  const candidates = properties
    .map((p) => buildCandidate(p, records, enumTypes, standardMap, resource, wantRep))
    .filter((c): c is EnumCandidate => c !== undefined);

  const hasStandardValue = (c: EnumCandidate): boolean => c.values.length > 0 && standardMap.isStandardValue(c.values[0]);
  const rank = (c: EnumCandidate): number => (c.isStandard ? 0 : 2) + (hasStandardValue(c) ? 0 : 1);
  // Sort by rank: standard field + standard value (0) → standard field/local value (1) → local (2/3). Within
  // a rank, the higher fill rate wins — a fuller field is more likely to yield a non-empty result and is more
  // resistant to record drift between sampling and the live query.
  return [...candidates].sort((a, b) => rank(a) - rank(b) || b.fillRate - a.fillRate);
};
