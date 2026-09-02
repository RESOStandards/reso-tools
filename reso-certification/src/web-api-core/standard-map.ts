/**
 * Standard-element map from the DD reference — the membership tests Core field/value selection uses to
 * prefer standard (DD-defined) fields and values over local ones.
 *
 * The *kind* of an enumeration is read from the server metadata (`resolveEnum` on the field's type +
 * enumTypes, which the metadata-validation scenario has already vetted). This map answers a different
 * question — "is this element standard?" — off the DD reference (reso-common `dd-{ver}.json`, loaded via
 * `getReferenceMetadata`). A value counts as standard if it is a member of *any* supported DD enum, per
 * the rule that a lookup value could belong to any of the enums we support; `standardValues` narrows to
 * one lookup when a precise, per-field match is wanted.
 */

// @ts-expect-error — legacy CJS (reference metadata loader), no type declarations
import certUtilsEtl from '../etl/index.cjs';
import type { DdReference } from '../metadata/dd-metadata-checks.js';

// getReferenceMetadata returns null when it can't load a version's reference file (it catches + logs), so the
// type must admit null — the caller MUST guard, or `ref.fields` throws and takes down the whole Core run.
// version is optional — the loader defaults to the latest DD (CURRENT_DD_VERSION) when omitted, which is the
// fallback buildStandardMap relies on. Returns null when it can't load a version's file (it catches + logs).
const { getReferenceMetadata } = certUtilsEtl as { getReferenceMetadata: (version?: string) => DdReference | null };

export interface StandardMap {
  /** True if `resource.field` is a standard DD field. */
  readonly isStandardField: (resource: string, field: string) => boolean;
  /** True if `value` is a standard value in *any* supported DD enum. */
  readonly isStandardValue: (value: string) => boolean;
  /** The standard values for one lookup/enum name — a precise, per-field match when the lookup is known. */
  readonly standardValues: (lookupName: string) => ReadonlySet<string>;
  /** The DD-standard values for a resource+field's OWN enum, resolved via the field's DD `type` (an
   *  enumeration field's `type` IS its enum name, which keys {@link standardValues}). Returns undefined when
   *  the field isn't a resolvable DD enumeration (unknown field, or a non-enum type) so the caller can fall
   *  back to {@link isStandardValue}. This is the precise per-FIELD join — it never uses a provider's arbitrary
   *  wire LookupName, only the field's DD type. */
  readonly standardValuesForField: (resource: string, field: string) => ReadonlySet<string> | undefined;
}

const fieldKey = (resource: string, field: string): string => `${resource}/${field}`;

/** Build a {@link StandardMap} from an already-loaded DD reference. Pure — the unit-test seam. */
export const buildStandardMapFrom = (ref: DdReference): StandardMap => {
  const fields = new Set(ref.fields.map((f) => fieldKey(f.resourceName, f.fieldName)));
  // A field's DD `type` is its enum name for an enumeration field (e.g. `org.reso.metadata.enums.StandardStatus`),
  // which is exactly how the lookups below are keyed — so this map is the field → enum-name join.
  const fieldTypes = new Map<string, string>(ref.fields.map((f) => [fieldKey(f.resourceName, f.fieldName), f.type]));
  // A DD lookup value has two legal wire forms (the dual representation): the machine LegacyODataValue —
  // here `lookupValue` — and the human StandardName carried in the RESO.OData.Metadata.StandardName
  // annotation. A provider may serve EITHER, so both must count as standard; keying only on the machine
  // form misreads every human-form value as local, which defeats the local-first Lookup Resource sampling.
  const STANDARD_NAME_TERM = 'RESO.OData.Metadata.StandardName';
  const valueForms = (l: DdReference['lookups'][number]): ReadonlyArray<string> => {
    const standardName = l.annotations?.find((a) => a.term === STANDARD_NAME_TERM)?.value;
    return standardName ? [l.lookupValue, standardName] : [l.lookupValue];
  };
  const allValues = new Set(ref.lookups.flatMap(valueForms));
  // Group values by their enum name for the precise per-lookup match. Local mutable Map, scoped to this
  // builder and never leaked — the returned closures read it as a ReadonlyMap.
  const byLookup = new Map<string, Set<string>>();
  for (const l of ref.lookups) {
    const existing = byLookup.get(l.lookupName) ?? new Set<string>();
    for (const form of valueForms(l)) existing.add(form);
    byLookup.set(l.lookupName, existing);
  }
  return {
    isStandardField: (resource, field) => fields.has(fieldKey(resource, field)),
    isStandardValue: (value) => allValues.has(value),
    standardValues: (lookupName) => byLookup.get(lookupName) ?? new Set<string>(),
    standardValuesForField: (resource, field) => {
      const type = fieldTypes.get(fieldKey(resource, field));
      return type ? byLookup.get(type) : undefined; // undefined for an unknown field or a non-enum type
    },
  };
};

/** An all-local standard map — every membership test is false. A last-resort net for when NO DD reference
 *  loads at all, so a totally-missing reference degrades field/value ranking to local-only instead of
 *  CRASHING the Core run. Standard preference is a ranking optimization, not a correctness gate. */
const EMPTY_STANDARD_MAP: StandardMap = {
  isStandardField: () => false,
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
  standardValuesForField: () => undefined,
};

const isValidRef = (ref: DdReference | null): ref is DdReference =>
  !!ref && Array.isArray(ref.fields) && Array.isArray(ref.lookups);

/**
 * Build the {@link StandardMap} for a version, loading the reference from reso-common.
 *
 * The Core spec version (e.g. `2.1.0`) is a 3-part Web API version, but the DD reference files are keyed by
 * the 2-part DD version (`dd-2.0.json`, `dd-2.1.json`), so the patch segment is stripped (`2.1.0` → `2.1`).
 * If the requested DD version isn't published (e.g. a new spec whose DD file hasn't shipped), fall back to
 * the LATEST available DD — `getReferenceMetadata()`'s default tracks the current DD version, and the rule
 * is "latest major.minor" (during a major-version adoption year two versions coexist; prefer the latest).
 * Only if no reference loads at all does the map degrade to {@link EMPTY_STANDARD_MAP} — never a crash.
 */
export const buildStandardMap = (version: string): StandardMap => {
  const ddVersion = version.split('.').slice(0, 2).join('.');
  const requested = getReferenceMetadata(ddVersion);
  const ref = isValidRef(requested) ? requested : getReferenceMetadata(); // fall back to the latest published DD
  return isValidRef(ref) ? buildStandardMapFrom(ref) : EMPTY_STANDARD_MAP;
};
