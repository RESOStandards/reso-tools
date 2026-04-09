/**
 * Metadata report serializer — converts EDMX XML to the RESO metadata-report.json format.
 *
 * This replaces the Java Commander's MetadataReport + FieldJson + LookupJson serializers.
 * The output format matches server-metadata.json used by the reference server and consumed
 * by reso-certification-utils for DD testing.
 */

import {
  parseCsdlXml,
  getAllFields,
  type CsdlSchema,
  type CsdlEnumType,
  type CsdlEnumMember,
  type FieldInfo,
  type FieldAnnotation,
} from '@reso-standards/reso-client';

// ── Output Types ──

/** A field entry in the metadata report. */
export interface MetadataReportField {
  readonly resourceName: string;
  readonly fieldName: string;
  readonly type: string;
  readonly typeName?: string;
  readonly nullable?: boolean;
  readonly maxLength?: number;
  readonly scale?: number;
  readonly precision?: number;
  readonly defaultValue?: string;
  readonly isCollection?: boolean;
  readonly isExpansion?: boolean;
  readonly isEnumeration?: boolean;
  readonly isComplexType?: boolean;
  readonly annotations: ReadonlyArray<{ readonly term: string; readonly value: string }>;
}

/** A lookup entry in the metadata report. */
export interface MetadataReportLookup {
  readonly lookupName: string;
  readonly lookupValue: string;
  readonly type: string;
  readonly annotations?: ReadonlyArray<{ readonly term: string; readonly value: string }>;
}

/**
 * A resource entry in the metadata report.
 *
 * Only `resourceName` is mandatory today. The shape is intentionally
 * extensible via an index signature so DD 2.2's forthcoming Model
 * resource (which will carry per-resource definitions, complex type
 * info, and other descriptors) can be added without a breaking
 * change. Consumers should narrow `unknown` extras before using
 * them.
 */
export interface MetadataReportResource {
  readonly resourceName: string;
  readonly [extra: string]: unknown;
}

/** The complete metadata report. */
export interface MetadataReport {
  readonly description: string;
  readonly version: string;
  readonly generatedOn: string;
  readonly resources: ReadonlyArray<MetadataReportResource>;
  readonly fields: ReadonlyArray<MetadataReportField>;
  readonly lookups: ReadonlyArray<MetadataReportLookup>;
}

// ── Helpers ──

/** Check if a type is an OData primitive (starts with "Edm."). */
const isEdmPrimitive = (type: string): boolean =>
  type.startsWith('Edm.') || type.startsWith('Collection(Edm.');

/** Check if a field type represents an enumeration. */
const isEnumerationType = (type: string): boolean => {
  const unwrapped = type.startsWith('Collection(') ? type.slice('Collection('.length, -1) : type;
  return !isEdmPrimitive(type) && !unwrapped.startsWith('Edm.');
};

/** Convert FieldInfo to MetadataReportField with additional properties. */
const fieldInfoToReportField = (field: FieldInfo, enumTypeNames: ReadonlySet<string>): MetadataReportField => {
  // A field is an enumeration if its (unwrapped) type matches a defined EnumType,
  // or if it has a LookupName annotation (string enum mode)
  const unwrapped = field.type.startsWith('Collection(') ? field.type.slice('Collection('.length, -1) : field.type;
  const isEnum = !field.isExpansion && (enumTypeNames.has(unwrapped) || !!field.lookupName);

  return {
    resourceName: field.resourceName,
    fieldName: field.fieldName,
    type: field.type,
    ...(field.typeName ? { typeName: field.typeName } : {}),
    ...(field.nullable != null ? { nullable: field.nullable } : {}),
    ...(field.maxLength != null ? { maxLength: field.maxLength } : {}),
    ...(field.scale != null ? { scale: field.scale } : {}),
    ...(field.precision != null ? { precision: field.precision } : {}),
    ...(field.isCollection ? { isCollection: true } : {}),
    ...(field.isExpansion ? { isExpansion: true } : {}),
    ...(isEnum ? { isEnumeration: true } : {}),
    annotations: field.annotations,
  };
};

/** Convert a CsdlEnumType member to a MetadataReportLookup. */
const enumMemberToLookup = (
  enumType: CsdlEnumType,
  member: CsdlEnumMember,
  namespace: string,
): MetadataReportLookup => {
  const lookupName = `${namespace}.${enumType.name}`;
  const type = enumType.underlyingType ?? 'Edm.Int32';

  // Enum member annotations aren't currently parsed by reso-client's CSDL parser,
  // but we include the structure for when they are
  return {
    lookupName,
    lookupValue: member.name,
    type,
  };
};

// ── Main Serializer ──

/**
 * Serialize a parsed CSDL schema to the RESO metadata report format.
 *
 * @param schema Parsed CSDL schema from reso-client's parseCsdlXml()
 * @param version DD version (e.g., "2.0")
 * @returns MetadataReport matching server-metadata.json format
 */
export const serializeMetadataReport = (
  schema: CsdlSchema,
  version: string,
): MetadataReport => {
  if (!schema.entityContainer) {
    throw new Error(
      'Metadata is missing the required EntityContainer. ' +
      'OData 4.01 requires a single EntityContainer per metadata document. ' +
      'See https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_EntityContainer'
    );
  }

  // Resources from entity container
  const resources: ReadonlyArray<MetadataReportResource> =
    schema.entityContainer.entitySets.map(es => ({ resourceName: es.name }));

  // Build set of fully-qualified enum type names for isEnumeration detection
  const enumTypeNames = new Set(
    schema.enumTypes.map(et => `${schema.namespace}.${et.name}`)
  );

  // Fields from all entity types (properties + navigation properties)
  const allFieldsByResource = getAllFields(schema);
  const fields: ReadonlyArray<MetadataReportField> = Object.values(allFieldsByResource)
    .flat()
    .map(field => fieldInfoToReportField(field, enumTypeNames));

  // Lookups from enum type definitions
  const lookups: ReadonlyArray<MetadataReportLookup> = schema.enumTypes.flatMap(enumType =>
    enumType.members.map(member => enumMemberToLookup(enumType, member, schema.namespace))
  );

  return {
    description: 'RESO Data Dictionary Metadata Report',
    version,
    generatedOn: new Date().toISOString(),
    resources,
    fields,
    lookups,
  };
};

/**
 * Generate a metadata report from raw EDMX XML.
 *
 * @param edmxXml Raw XML string from /$metadata
 * @param version DD version (e.g., "2.0")
 * @returns MetadataReport matching server-metadata.json format
 */
export const generateMetadataReport = (
  edmxXml: string,
  version: string,
): MetadataReport => {
  const schema = parseCsdlXml(edmxXml);
  return serializeMetadataReport(schema, version);
};
