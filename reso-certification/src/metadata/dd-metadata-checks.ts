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
 *
 * These REPLACE the Commander's per-field DD BDD .feature scenarios (DataDictionary.java +
 * LookupResource.java) — we deliberately do NOT port the BDD/Cucumber layer. The Commander's
 * scenarios are per-field TYPE assertions; these checks compute the same thing directly,
 * parameterized over the DD reference (each resource/field), with per-field findings as the
 * equivalent output. Conceptually they collapse into TYPE conformance — a field's declared type,
 * its enum representation (single/multi, closed, the LookupName annotation + Lookup Resource
 * integrity) and its type facets — plus one naming check (disallowed synonyms). Each check cites
 * the Commander BDD scenario it implements.
 *
 * Intentionally NOT implemented: `"X" MUST contain at least one standard lookup` — latent in the
 * Commander (0 uses in the v1.7/v2.0 generated features) and incompatible with open enums that
 * carry no standard values; `When "X" exists` and `MAY contain` are non-failing guards/info.
 */
import type { MetadataReport, MetadataReportField } from './serializer.js';

/** The kind of metadata-gate violation. */
export type MetadataCheckKind =
  | 'disallowed-synonym'
  | 'closed-enum-value'
  | 'field-type'
  | 'lookup-resource-fields'
  | 'lookup-name-annotation'
  | 'lookup-name-integrity'
  | 'suggested-max';

/**
 * Finding severity. `error` is a MUST violation that fails the metadata gate (fail-fast before
 * variations); `warning` is a SHOULD recommendation (e.g. the DD Suggested Max attributes) that is
 * surfaced as a message but does not fail certification.
 */
export type MetadataCheckSeverity = 'error' | 'warning';

/** A single metadata-gate finding — a metadata issue (or recommendation), not a mapping variation. */
export interface MetadataCheckFinding {
  readonly check: MetadataCheckKind;
  readonly severity: MetadataCheckSeverity;
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
  readonly isEnumeration?: boolean;
  readonly isCollection?: boolean;
  readonly isExpansion?: boolean;
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
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
 *
 * Commander BDD: `Given that the following synonyms for "X" DO NOT exist in the "R" metadata`
 * (DataDictionary.java theFollowingSynonymsForDONOTExistInTheMetadata). The one NAMING check.
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
        severity: 'error' as const,
        resourceName: refField.resourceName,
        fieldName: syn,
        message: `"${syn}" in the "${refField.resourceName}" resource is a disallowed synonym of the standard field "${refField.fieldName}". Use "${refField.fieldName}".`,
      })),
  );
};

/** The annotation term carrying a lookup's human-friendly standard display name. */
const STANDARD_NAME = 'RESO.OData.Metadata.StandardName';

/** The annotation term tying a string-enumeration field to its Lookup Resource enumeration. */
const LOOKUP_NAME_ANNOTATION = 'RESO.OData.Metadata.LookupName';

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
 *
 * Commander BDD: `Then "X" MUST contain only standard enumerations` (DataDictionary.java
 * mustContainOnlyStandardEnumerations) — applied dynamically to closed (lookupStatus "Locked") enums.
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
          severity: 'error' as const,
          resourceName: refField.resourceName,
          fieldName: refField.fieldName,
          message: `"${v.lookupValue}" is not a permitted value of the closed enumeration "${refField.fieldName}" in the "${refField.resourceName}" resource. Closed enumerations may not carry values outside the Data Dictionary.`,
        }));
    });
};

/** OData EDM type names (mirrors the Web API Commander TypeMappings.ODataTypes). */
const EDM = {
  INT16: 'Edm.Int16', INT32: 'Edm.Int32', INT64: 'Edm.Int64',
  STRING: 'Edm.String', DATE: 'Edm.Date', DATETIME_OFFSET: 'Edm.DateTimeOffset',
  BOOLEAN: 'Edm.Boolean', DECIMAL: 'Edm.Decimal', DOUBLE: 'Edm.Double',
} as const;

/** The DD data-type names the Commander asserts ("MUST be <name> data type"). */
type DdDataType = 'String' | 'Date' | 'Decimal' | 'Integer' | 'Boolean' | 'Timestamp' | 'Single Enumeration' | 'Multiple Enumeration';

const EDM_PRIMITIVES: ReadonlySet<string> = new Set(Object.values(EDM));
const INT_TYPES: ReadonlySet<string> = new Set([EDM.INT16, EDM.INT32, EDM.INT64]);

const unwrapCollection = (type: string): string =>
  type.startsWith('Collection(') && type.endsWith(')') ? type.slice('Collection('.length, -1) : type;

/** Derive the DD data type the standard declares for a reference field, or null if it isn't a typed data field. */
const expectedDdDataType = (field: DdReferenceField): DdDataType | null => {
  if (field.isExpansion) return null;
  const base = unwrapCollection(field.type);
  const isCollection = field.isCollection === true || field.type.startsWith('Collection(');
  // A real enumeration is flagged AND has a nominal (enum-FQDN) type. isEnumeration alone can be set
  // for a primitive that merely carries a LookupStatus (e.g. the Boolean YN field BuiltPre1978YN), so
  // the primitive type wins there — matching the Commander, which derives from the EDM type. A
  // non-enum nominal type (a complex type) is not enumeration-flagged, so it falls through to null.
  if (field.isEnumeration && !base.startsWith('Edm.')) {
    return isCollection ? 'Multiple Enumeration' : 'Single Enumeration';
  }
  switch (base) {
    case EDM.STRING: return 'String';
    case EDM.DATE: return 'Date';
    case EDM.DECIMAL:
    case EDM.DOUBLE:
      // DD numeric: scale 0 (an empty DD Suggested Max Precision) denotes an Integer — the Commander
      // emits Edm.Int64 for these; scale > 0 is a true Decimal. The provider's Int bucket need not
      // match the DD's; data capacity is the schema-validation step. (Matches buildNumberTest.)
      return (field.scale ?? 0) === 0 ? 'Integer' : 'Decimal';
    case EDM.INT16:
    case EDM.INT32:
    case EDM.INT64: return 'Integer';
    case EDM.BOOLEAN: return 'Boolean';
    case EDM.DATETIME_OFFSET: return 'Timestamp';
    default: return null;
  }
};

/**
 * Validate a provider field's OData type against the DD-declared data type — a faithful port of the
 * Commander's assertDataTypeMapping. Returns an error fragment if the type is wrong, else null.
 * `underlying` is the provider enum's underlying type (from its lookups); only used for EnumType reps.
 */
const validateFieldType = (expected: DdDataType, field: MetadataReportField, underlying: string | undefined): string | null => {
  const found = unwrapCollection(field.type);
  const isCollection = field.isCollection === true || field.type.startsWith('Collection(');

  switch (expected) {
    case 'String':
      return found === EDM.STRING ? null : `MUST map to ${EDM.STRING} but found ${field.type}`;
    case 'Date':
      return found === EDM.DATE ? null : `MUST map to ${EDM.DATE} but found ${field.type}`;
    case 'Decimal':
      return found === EDM.DECIMAL || found === EDM.DOUBLE ? null : `MUST map to ${EDM.DECIMAL} or ${EDM.DOUBLE} but found ${field.type}`;
    case 'Integer':
      return INT_TYPES.has(found) ? null : `MUST map to ${EDM.INT16}, ${EDM.INT32} or ${EDM.INT64} but found ${field.type}`;
    case 'Boolean':
      return found === EDM.BOOLEAN ? null : `MUST map to ${EDM.BOOLEAN} but found ${field.type}`;
    case 'Timestamp':
      return found === EDM.DATETIME_OFFSET ? null : `MUST map to ${EDM.DATETIME_OFFSET} but found ${field.type}`;
    case 'Single Enumeration':
      if (isCollection) return 'single enumerations cannot be collections';
      if (found === EDM.STRING) return null; // string + Lookup Resource representation
      if (EDM_PRIMITIVES.has(found)) return `enumerated data types MUST declare a unique nominal (lookup) type, found primitive ${found}`;
      if (!INT_TYPES.has(underlying ?? '')) return `enumerated types MUST use an underlying type of ${EDM.INT16}, ${EDM.INT32} or ${EDM.INT64}`;
      return field.isFlags ? 'IsFlags="true" but MUST be false for single-valued enumerations' : null;
    case 'Multiple Enumeration':
      if (found === EDM.STRING) return isCollection ? null : `multiple enumerations MUST use Collection(${EDM.STRING}), found ${EDM.STRING}`;
      if (EDM_PRIMITIVES.has(found)) return `enumerated data type MUST declare a unique nominal type, found primitive ${found}`;
      if (!INT_TYPES.has(underlying ?? '')) return `enumerated types MUST use an underlying type of ${EDM.INT16}, ${EDM.INT32} or ${EDM.INT64}`;
      return !isCollection && !field.isFlags ? 'multi-enumerations MUST have IsFlags="true"' : null;
  }
};

/**
 * Field-type check: a provider field MUST map to the DD-declared data type. The three enum
 * representations (Edm.String + Lookup Resource, the EnumType FQDN, and a Collection for multi) are
 * all accepted where valid, matching the Commander's assertDataTypeMapping exactly. Only fields the
 * provider actually declares are checked (field existence is a separate concern).
 *
 * Commander BDD: `Then "X" MUST be "<type>" data type` (DataDictionary.java assertDataTypeMapping;
 * derived per BDDProcessor build{Number,Integer,Decimal,Boolean,Date,Timestamp,String,Enum}Test).
 */
export const checkFieldTypes = (report: MetadataReport, reference: DdReference): ReadonlyArray<MetadataCheckFinding> => {
  const providerByKey = new Map(report.fields.map((f) => [fieldKey(f.resourceName, f.fieldName), f]));
  // Provider enum underlying type: each lookup carries it as its `type`; first wins (uniform per enum).
  const providerUnderlying = report.lookups.reduce(
    (acc, l) => (acc.has(l.lookupName) ? acc : acc.set(l.lookupName, l.type)),
    new Map<string, string>(),
  );

  return reference.fields.flatMap((refField) => {
    const provider = providerByKey.get(fieldKey(refField.resourceName, refField.fieldName));
    if (!provider || provider.isExpansion) return [];
    const expected = expectedDdDataType(refField);
    if (expected == null) return [];
    // A field carrying a LookupName annotation is the string + Lookup Resource representation; its EDM
    // type is Edm.String even though the merged report rewrites field.type to the LookupName for the
    // variations join. Use the effective EDM type so the type-class check routes to the string branch.
    const isStringRep = provider.annotations.some((a) => a.term === LOOKUP_NAME_ANNOTATION);
    const isCollection = provider.isCollection === true || provider.type.startsWith('Collection(');
    const effectiveType = isStringRep ? (isCollection ? `Collection(${EDM.STRING})` : EDM.STRING) : provider.type;
    // Underlying type from the enum's lookups; an open enum with no standard members carries none, so
    // default to Edm.Int32 (the OData/RESO default). A non-int underlying, when present, still fails.
    const underlying = providerUnderlying.get(unwrapCollection(provider.type)) ?? EDM.INT32;
    const error = validateFieldType(expected, { ...provider, type: effectiveType }, underlying);
    return error
      ? [{
          check: 'field-type' as const,
          severity: 'error' as const,
          resourceName: refField.resourceName,
          fieldName: refField.fieldName,
          message: `"${refField.fieldName}" in the "${refField.resourceName}" resource MUST be a ${expected} data type: ${error}.`,
        }]
      : [];
  });
};

/** The Lookup Resource (string representation) entity set name and its mandatory metadata fields. */
const LOOKUP_RESOURCE = 'Lookup';
const LOOKUP_MANDATORY_FIELDS: ReadonlyArray<string> = ['LookupKey', 'LookupName', 'LookupValue', 'ModificationTimestamp'];

/**
 * Lookup Resource mandatory fields (metadata): when a provider serves the string representation (a
 * "Lookup" resource is present), that resource MUST declare LookupKey, LookupName, LookupValue and
 * ModificationTimestamp. Guarded on the Lookup resource existing — the EnumType representation has
 * none, so this is skipped there. (The Commander additionally checks each Lookup record carries
 * non-null values for these; that is data validation, outside this metadata gate.)
 *
 * Commander BDD: `Then "Lookup" Resource data and metadata MUST contain the following fields`
 * (LookupResource.java, RCP-032 lookup-resource-tests.feature) — the metadata half.
 */
export const checkLookupResourceFields = (
  report: MetadataReport,
  _reference: DdReference,
): ReadonlyArray<MetadataCheckFinding> => {
  const lookupFields = new Set(report.fields.filter((f) => f.resourceName === LOOKUP_RESOURCE).map((f) => f.fieldName));
  if (lookupFields.size === 0) return [];
  return LOOKUP_MANDATORY_FIELDS.filter((mf) => !lookupFields.has(mf)).map((mf) => ({
    check: 'lookup-resource-fields' as const,
    severity: 'error' as const,
    resourceName: LOOKUP_RESOURCE,
    fieldName: mf,
    message: `The "${LOOKUP_RESOURCE}" Resource MUST contain the field "${mf}".`,
  }));
};

/**
 * LookupName annotation requirement: a standard lookup field served in the string representation
 * (Edm.String or Collection(Edm.String)) MUST carry the RESO.OData.Metadata.LookupName annotation
 * tying it to its enumeration. EnumType representations (a nominal type) are exempt.
 *
 * Commander BDD: `Then RESO Lookups using String or String Collection data types MUST have the
 * annotation "RESO.OData.Metadata.LookupName"` (LookupResource.java, RCP-032).
 */
export const checkLookupNameAnnotations = (
  report: MetadataReport,
  reference: DdReference,
): ReadonlyArray<MetadataCheckFinding> => {
  const standardLookupFields = new Set(
    reference.fields.filter((f) => f.isEnumeration && !f.isExpansion).map((f) => fieldKey(f.resourceName, f.fieldName)),
  );
  return report.fields.flatMap((field) => {
    if (!standardLookupFields.has(fieldKey(field.resourceName, field.fieldName))) return [];
    if (unwrapCollection(field.type) !== 'Edm.String') return []; // EnumType representation is exempt
    return field.annotations.some((a) => a.term === LOOKUP_NAME_ANNOTATION)
      ? []
      : [{
          check: 'lookup-name-annotation' as const,
          severity: 'error' as const,
          resourceName: field.resourceName,
          fieldName: field.fieldName,
          message: `"${field.fieldName}" in the "${field.resourceName}" resource is a string-enumeration field and MUST carry the "${LOOKUP_NAME_ANNOTATION}" annotation.`,
        }];
  });
};

/**
 * LookupName referential integrity: every field carrying a LookupName annotation MUST reference an
 * enumeration that exists in the Lookup Resource data (report.lookups). Catches an annotation that
 * points at a missing or misspelled Lookup Resource entry. (The inverse — values served but not
 * advertised — is the schema-validation phase's job.)
 *
 * Commander BDD: `And fields with the annotation term "X" MUST have a LookupName in the Lookup
 * Resource` (LookupResource.java, RCP-032).
 */
export const checkLookupNameIntegrity = (
  report: MetadataReport,
  _reference: DdReference,
): ReadonlyArray<MetadataCheckFinding> => {
  const lookupDataNames = new Set(report.lookups.map((l) => l.lookupName));
  return report.fields.flatMap((field) => {
    const annotation = field.annotations.find((a) => a.term === LOOKUP_NAME_ANNOTATION);
    if (!annotation) return [];
    return lookupDataNames.has(annotation.value)
      ? []
      : [{
          check: 'lookup-name-integrity' as const,
          severity: 'error' as const,
          resourceName: field.resourceName,
          fieldName: field.fieldName,
          message: `"${field.fieldName}" in the "${field.resourceName}" resource references LookupName "${annotation.value}", which is not present in the Lookup Resource.`,
        }];
  });
};

/**
 * Suggested-max checks (SHOULD): the DD's maxLength / precision / scale are recommendations, not
 * requirements, so a provider value that differs from the suggested maximum yields a WARNING, not a
 * gate failure — matching the Commander, which only logs these. Only fields the provider declares
 * are checked, and only the attributes the DD actually suggests for each field.
 *
 * Commander BDD: `And "X" {precision|scale|length} SHOULD be equal to the RESO Suggested Max ...`
 * (DataDictionary.java {precision|scale|length}SHOULDBeEqualTo... — the only SHOULD/warning checks).
 */
export const checkSuggestedMaxConstraints = (
  report: MetadataReport,
  reference: DdReference,
): ReadonlyArray<MetadataCheckFinding> => {
  const providerByKey = new Map(report.fields.map((f) => [fieldKey(f.resourceName, f.fieldName), f]));

  const attributes = [
    { name: 'Length', suggested: (f: DdReferenceField) => f.maxLength, actual: (f: MetadataReportField) => f.maxLength },
    { name: 'Precision', suggested: (f: DdReferenceField) => f.precision, actual: (f: MetadataReportField) => f.precision },
    { name: 'Scale', suggested: (f: DdReferenceField) => f.scale, actual: (f: MetadataReportField) => f.scale },
  ] as const;

  return reference.fields.flatMap((refField) => {
    const provider = providerByKey.get(fieldKey(refField.resourceName, refField.fieldName));
    if (!provider) return [];
    return attributes.flatMap(({ name, suggested, actual }) => {
      const want = suggested(refField);
      if (want == null) return [];
      const got = actual(provider);
      return got === want
        ? []
        : [{
            check: 'suggested-max' as const,
            severity: 'warning' as const,
            resourceName: refField.resourceName,
            fieldName: refField.fieldName,
            message: `${name} for "${refField.fieldName}" in the "${refField.resourceName}" resource SHOULD be equal to the RESO Suggested Max ${name} of ${want} but was ${got ?? 'not set'}.`,
          }];
    });
  });
};

/**
 * Run the full DD metadata gate. Returns the combined findings across all checks; an empty array
 * means the metadata passes. Callers fail certification on `error` findings (before variations) and
 * surface `warning` findings as non-blocking messages.
 */
export const runDdMetadataChecks = (
  report: MetadataReport,
  reference: DdReference,
): ReadonlyArray<MetadataCheckFinding> => [
  ...checkDisallowedSynonyms(report, reference),
  ...checkClosedEnumValues(report, reference),
  ...checkFieldTypes(report, reference),
  ...checkLookupResourceFields(report, reference),
  ...checkLookupNameAnnotations(report, reference),
  ...checkLookupNameIntegrity(report, reference),
  ...checkSuggestedMaxConstraints(report, reference),
];
