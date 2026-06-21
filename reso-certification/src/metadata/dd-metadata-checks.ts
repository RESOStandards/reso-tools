/**
 * DD metadata checks — the fail-fast gate between the semantic/structural OData tests and the
 * variations (mapping) check.
 *
 * These catch METADATA issues: the metadata declares something the DD forbids, independent of how
 * a provider's values map to the standard. This mirrors the Web API Commander, which failed these
 * before the variations check ever ran — metadata issues vs mapping issues. Keeping them out of the
 * variations engine also leaves that WG-approved behavior untouched.
 *
 * Pure functions over a provider MetadataReport + the DD reference (no I/O). Each returns the
 * findings for its check; an empty array means the metadata passes that gate. The DD reference is
 * the source of truth for what's allowed: `synonyms` (disallowed alternate field names) and
 * `lookupStatus` ("Locked with Enumerations" = a closed enum) are DD-authored descriptors carried
 * in dd-{ver}.json.
 */
import type { MetadataReport } from './serializer.js';

/** The kind of metadata-gate violation. */
export type MetadataCheckKind = 'disallowed-synonym' | 'closed-enum-value' | 'field-type';

/** A single metadata-gate finding — a fail-fast metadata issue, not a mapping variation. */
export interface MetadataCheckFinding {
  readonly check: MetadataCheckKind;
  readonly resourceName: string;
  readonly fieldName: string;
  readonly message: string;
}

/**
 * A DD reference field. The reference carries DD-authored descriptors beyond the provider report
 * shape — `synonyms` (comma-separated disallowed alternate field names) and `lookupStatus` (the
 * enum open/closed status; values seen: "Open", "Open with Enumerations", "Locked with Enumerations").
 */
export interface DdReferenceField {
  readonly resourceName: string;
  readonly fieldName: string;
  readonly type: string;
  readonly lookupStatus?: string;
  readonly synonyms?: string;
}

/** The DD reference shape these checks read (a structural superset of MetadataReport). */
export interface DdReference {
  readonly fields: ReadonlyArray<DdReferenceField>;
  readonly lookups: ReadonlyArray<{
    readonly lookupName: string;
    readonly lookupValue: string;
    readonly annotations?: ReadonlyArray<{ readonly term: string; readonly value: string }>;
  }>;
}

/** A unique key for a (resource, field) pair. Resource/field names are OData SimpleIdentifiers, so '/' is a safe separator. */
const fieldKey = (resourceName: string, fieldName: string): string => `${resourceName}/${fieldName}`;

/** Split a DD `synonyms` cell ("A, B, C") into trimmed, non-empty names. */
const parseSynonyms = (synonyms: string | undefined): ReadonlyArray<string> =>
  (synonyms ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Disallowed-synonym check: a provider MUST use the standard field name, not a known synonym. For
 * each standard field carrying `synonyms`, flag any of those synonym names that appear as a field
 * in the provider's SAME resource. A synonym that is itself a standard field name is skipped — it's
 * a legitimate field, not a synonym misuse (the DD reference is verified free of such collisions).
 */
export const checkDisallowedSynonyms = (
  report: MetadataReport,
  reference: DdReference,
): ReadonlyArray<MetadataCheckFinding> => {
  const providerFields = new Set(report.fields.map((f) => fieldKey(f.resourceName, f.fieldName)));
  const standardFields = new Set(reference.fields.map((f) => fieldKey(f.resourceName, f.fieldName)));

  return reference.fields.flatMap((refField) =>
    parseSynonyms(refField.synonyms)
      .filter((syn) => {
        const k = fieldKey(refField.resourceName, syn);
        return providerFields.has(k) && !standardFields.has(k);
      })
      .map((syn) => ({
        check: 'disallowed-synonym' as const,
        resourceName: refField.resourceName,
        fieldName: syn,
        message: `"${syn}" in the "${refField.resourceName}" resource is a disallowed synonym of the standard field "${refField.fieldName}". Use "${refField.fieldName}".`,
      })),
  );
};

/** The annotation term carrying a lookup's human-friendly standard display name. */
const STANDARD_NAME = 'RESO.OData.Metadata.StandardName';

/** A field's enum is CLOSED when its DD lookupStatus is "Locked with Enumerations". */
const isClosedEnum = (lookupStatus: string | undefined): boolean => (lookupStatus ?? '').startsWith('Locked');

/**
 * Closed-enum membership check: for a closed enum ("Locked with Enumerations"), the standard value
 * set is fixed — any provider value outside it is illegal metadata, not a mapping variation. (Open
 * enums are intentionally NOT checked here; their local values are variations.)
 *
 * Joins by transport identity (field.type === lookup.lookupName), so it works in both enum
 * representations and across enums shared by several fields (e.g. IanaTimeZoneValues). A provider
 * value is permitted if EITHER its machine value OR its StandardName matches a standard value's
 * machine value or StandardName — covering providers that key by either form.
 */
export const checkClosedEnumValues = (
  report: MetadataReport,
  reference: DdReference,
): ReadonlyArray<MetadataCheckFinding> => {
  // Allowed value identities per standard enum (reference lookupName/FQDN): machine value + StandardName.
  const allowedByEnum = reference.lookups.reduce((acc, l) => {
    const set = acc.get(l.lookupName) ?? new Set<string>();
    set.add(l.lookupValue);
    const sn = l.annotations?.find((a) => a.term === STANDARD_NAME)?.value;
    if (sn) set.add(sn);
    return acc.set(l.lookupName, set);
  }, new Map<string, Set<string>>());

  // Provider lookups grouped by their lookupName, and provider field types by (resource, field).
  const providerLookupsByName = report.lookups.reduce((acc, l) => {
    const arr = acc.get(l.lookupName) ?? [];
    arr.push(l);
    return acc.set(l.lookupName, arr);
  }, new Map<string, MetadataReport['lookups'][number][]>());
  const providerFieldType = new Map(report.fields.map((f) => [fieldKey(f.resourceName, f.fieldName), f.type]));

  return reference.fields
    .filter((f) => isClosedEnum(f.lookupStatus))
    .flatMap((refField) => {
      const allowed = allowedByEnum.get(refField.type);
      const providerType = providerFieldType.get(fieldKey(refField.resourceName, refField.fieldName));
      // No standard enum (shouldn't happen) or the provider doesn't declare the field (field
      // existence is a separate check) → nothing to validate here.
      if (!allowed || providerType == null) return [];

      return (providerLookupsByName.get(providerType) ?? [])
        .filter((v) => {
          const sn = v.annotations?.find((a) => a.term === STANDARD_NAME)?.value;
          return !(allowed.has(v.lookupValue) || (sn != null && allowed.has(sn)));
        })
        .map((v) => ({
          check: 'closed-enum-value' as const,
          resourceName: refField.resourceName,
          fieldName: refField.fieldName,
          message: `"${v.lookupValue}" is not a permitted value of the closed enumeration "${refField.fieldName}" in the "${refField.resourceName}" resource. Closed enumerations may not carry values outside the Data Dictionary.`,
        }));
    });
};

/**
 * Run the full DD metadata gate. Returns the combined findings across all checks; an empty array
 * means the metadata passes. The field-type check slots in here next.
 */
export const runDdMetadataChecks = (
  report: MetadataReport,
  reference: DdReference,
): ReadonlyArray<MetadataCheckFinding> => [
  ...checkDisallowedSynonyms(report, reference),
  ...checkClosedEnumValues(report, reference),
];
