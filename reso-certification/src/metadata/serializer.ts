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
  type CsdlAction,
  type CsdlFunction,
  type FieldInfo,
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

/** A model entry (entity type or complex type) in the metadata report. */
export interface MetadataReportModel {
  readonly modelName: string;
  readonly modelType: 'EntityType' | 'ComplexType';
  readonly baseType?: string;
  readonly abstract?: boolean;
  readonly openType?: boolean;
  readonly keyProperties?: ReadonlyArray<string>;
  readonly properties: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly nullable?: boolean;
    readonly maxLength?: number;
    readonly precision?: number;
    readonly scale?: number;
  }>;
  readonly navigationProperties: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly nullable?: boolean;
    readonly partner?: string;
    readonly containsTarget?: boolean;
  }>;
}

/** An action or function in the metadata report. */
export interface MetadataReportOperation {
  readonly name: string;
  readonly isBound?: boolean;
  readonly entitySetPath?: string;
  readonly isComposable?: boolean;
  readonly parameters: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly nullable?: boolean;
  }>;
  readonly returnType?: {
    readonly type: string;
    readonly nullable?: boolean;
  };
}

/** The complete metadata report. */
export interface MetadataReport {
  readonly description: string;
  readonly version: string;
  readonly generatedOn: string;
  readonly resources: ReadonlyArray<MetadataReportResource>;
  readonly models?: ReadonlyArray<MetadataReportModel>;
  readonly fields: ReadonlyArray<MetadataReportField>;
  readonly lookups: ReadonlyArray<MetadataReportLookup>;
  readonly actions: ReadonlyArray<MetadataReportOperation>;
  readonly functions: ReadonlyArray<MetadataReportOperation>;
}

// ── Helpers ──

/**
 * Detect if a field is an enumeration from CSDL type info.
 *
 * Single enumerations:
 *   - Edm.String with LookupName annotation (standard or local string enum)
 *   - Edm.EnumType (underlying Edm.Int16/Int32/Int64)
 *
 * Multiple enumerations:
 *   - Collection(Edm.String) with LookupName annotation
 *   - Collection(Edm.EnumType) for OData enum collections
 *   - Edm.EnumType with IsFlags = true
 */
const detectEnumeration = (
  field: FieldInfo,
  enumTypeNames: ReadonlySet<string>,
  isFlagsTypeNames: ReadonlySet<string>,
): boolean => {
  if (field.isExpansion) return false;

  const type = field.type;
  const unwrapped = type.startsWith('Collection(') ? type.slice('Collection('.length, -1) : type;

  // OData EnumType (single or collection): match the field type against the enum's full FQDN at
  // the TRANSPORT level. The enum's true namespace comes from CsdlEnumType.namespace — entity
  // types and enum types often live in separate schemas (e.g. org.reso.metadata vs
  // org.reso.metadata.enums), so enumTypeNames is keyed by each enum's real namespace + name and
  // field.type === the enum FQDN exactly. (Display uses the parsed tail; joins use the FQDN.)
  if (enumTypeNames.has(unwrapped)) return true;
  if (isFlagsTypeNames.has(unwrapped)) return true;

  // String enum: Edm.String or Collection(Edm.String) with LookupName annotation
  if ((unwrapped === 'Edm.String') && field.lookupName) return true;

  return false;
};

/** Convert FieldInfo to MetadataReportField with additional properties. */
const fieldInfoToReportField = (
  field: FieldInfo,
  enumTypeNames: ReadonlySet<string>,
  isFlagsTypeNames: ReadonlySet<string>,
): MetadataReportField => {
  const isEnum = detectEnumeration(field, enumTypeNames, isFlagsTypeNames);

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

  // Carry member annotations (e.g. StandardName) so the report keeps BOTH values: the legacy
  // OData value (lookupValue) and the standard display name (annotation).
  const annotations = member.annotations
    ? Object.entries(member.annotations).map(([term, value]) => ({ term, value }))
    : [];

  return {
    lookupName,
    lookupValue: member.name,
    type,
    ...(annotations.length > 0 && { annotations })
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

  // Build sets for enumeration detection, keyed by each enum's full FQDN. The enum's true
  // namespace (CsdlEnumType.namespace) is used so a field's type matches at the transport level —
  // entity types and enum types often live in separate namespaced schemas (e.g.
  // org.reso.metadata vs org.reso.metadata.enums).
  const enumFqn = (et: CsdlEnumType): string => `${et.namespace ?? schema.namespace}.${et.name}`;
  const enumTypeNames = new Set(schema.enumTypes.map(enumFqn));
  const isFlagsTypeNames = new Set(schema.enumTypes.filter(et => et.isFlags).map(enumFqn));

  // Fields from all entity types (properties + navigation properties)
  const allFieldsByResource = getAllFields(schema);
  const fields: ReadonlyArray<MetadataReportField> = Object.values(allFieldsByResource)
    .flat()
    .map(field => fieldInfoToReportField(field, enumTypeNames, isFlagsTypeNames));

  // Lookups from enum type definitions
  const lookups: ReadonlyArray<MetadataReportLookup> = schema.enumTypes.flatMap(enumType =>
    enumType.members.map(member => enumMemberToLookup(enumType, member, enumType.namespace ?? schema.namespace))
  );

  // Actions and Functions
  const serializeOperation = (op: CsdlAction | CsdlFunction): MetadataReportOperation => ({
    name: op.name,
    ...(op.isBound ? { isBound: op.isBound } : {}),
    ...(op.entitySetPath ? { entitySetPath: op.entitySetPath } : {}),
    ...('isComposable' in op && op.isComposable ? { isComposable: op.isComposable } : {}),
    parameters: op.parameters.map(p => ({
      name: p.name,
      type: p.type,
      ...(p.nullable != null ? { nullable: p.nullable } : {}),
    })),
    ...(op.returnType ? { returnType: { type: op.returnType.type, ...(op.returnType.nullable != null ? { nullable: op.returnType.nullable } : {}) } } : {}),
  });

  const actions = schema.actions.map(serializeOperation);
  const functions = schema.functions.map(serializeOperation);

  return {
    description: 'RESO Data Dictionary Metadata Report',
    version,
    generatedOn: new Date().toISOString(),
    resources,
    fields,
    lookups,
    actions,
    functions,
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
