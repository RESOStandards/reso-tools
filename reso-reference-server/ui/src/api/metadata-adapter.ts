/**
 * Converts CSDL schema types from @reso/odata-client into the ResoField/ResoLookup
 * types used by the UI. This enables the UI to work with any OData server's $metadata.
 */
import type { CsdlEntityType, CsdlEnumType, CsdlProperty, CsdlSchema } from '@reso/odata-client';
import type { ResoAnnotation, ResoField, ResoLookup } from '../types';

/** Convert CSDL annotations record to ResoAnnotation array. */
const toAnnotations = (annotations?: Readonly<Record<string, string>>): ReadonlyArray<ResoAnnotation> =>
  annotations ? Object.entries(annotations).map(([term, value]) => ({ term, value })) : [];

/** Check if a CSDL type string represents a collection. */
const isCollectionType = (type: string): boolean => type.startsWith('Collection(');

/** Extract the inner type from a Collection() wrapper, or return as-is. */
const unwrapType = (type: string): string =>
  isCollectionType(type) ? type.slice('Collection('.length, -1) : type;

/** Check if a type is an Edm primitive (e.g., Edm.String, Edm.Int32). */
const isEdmPrimitive = (type: string): boolean => unwrapType(type).startsWith('Edm.');

/** Convert a single CSDL property to a ResoField. */
const propertyToField = (resourceName: string, prop: CsdlProperty, namespace: string): ResoField => {
  const rawType = unwrapType(prop.type);
  const isEnum = !isEdmPrimitive(prop.type) && !prop.type.startsWith('Collection(Edm.');

  // For enum types, extract just the type name without namespace
  const typeName = isEnum
    ? (rawType.startsWith(namespace + '.') ? rawType.slice(namespace.length + 1) : rawType)
    : undefined;

  return {
    resourceName,
    fieldName: prop.name,
    type: prop.type,
    typeName,
    nullable: prop.nullable,
    isCollection: isCollectionType(prop.type),
    maxLength: prop.maxLength,
    scale: prop.scale,
    precision: prop.precision,
    annotations: toAnnotations(prop.annotations)
  };
};

/** Convert a CSDL entity type's properties into ResoField array. */
export const entityTypeToFields = (
  entityType: CsdlEntityType,
  resourceName: string,
  schema: CsdlSchema
): ReadonlyArray<ResoField> => {
  const fields: ResoField[] = entityType.properties.map(p =>
    propertyToField(resourceName, p, schema.namespace)
  );

  // Add navigation properties as expansion fields
  const navFields: ReadonlyArray<ResoField> = entityType.navigationProperties.map(nav => ({
    resourceName,
    fieldName: nav.name,
    type: nav.type,
    typeName: nav.entityTypeName,
    nullable: nav.nullable,
    isCollection: nav.isCollection,
    isExpansion: true,
    annotations: []
  }));

  return [...fields, ...navFields];
};

/** Convert all entity types in a schema to ResoField arrays, keyed by entity set name. */
export const schemaToFieldsByResource = (
  schema: CsdlSchema
): Readonly<Record<string, ReadonlyArray<ResoField>>> => {
  if (!schema.entityContainer) return {};

  const entityTypeMap = new Map(
    schema.entityTypes.map(et => [et.name, et])
  );

  return Object.fromEntries(
    schema.entityContainer.entitySets.map(es => {
      const typeName = es.entityType.includes('.')
        ? es.entityType.split('.').pop()!
        : es.entityType;
      const entityType = entityTypeMap.get(typeName);
      if (!entityType) return [es.name, []];
      return [es.name, entityTypeToFields(entityType, es.name, schema)];
    })
  );
};

/** Convert a CSDL enum type to an array of ResoLookup entries. */
const enumTypeToLookups = (enumType: CsdlEnumType): ReadonlyArray<ResoLookup> =>
  enumType.members.map(member => ({
    lookupName: enumType.name,
    lookupValue: member.name,
    type: enumType.name,
    annotations: []
  }));

/** Convert all enum types in a schema to ResoLookup records, keyed by enum type name. */
export const schemaToLookups = (
  schema: CsdlSchema
): Readonly<Record<string, ReadonlyArray<ResoLookup>>> =>
  Object.fromEntries(
    schema.enumTypes.map(et => [et.name, enumTypeToLookups(et)])
  );

/** Build a resource-scoped lookup map: for each enum field in a resource, map fieldName → lookups. */
export const buildResourceLookups = (
  fields: ReadonlyArray<ResoField>,
  allLookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>
): Readonly<Record<string, ReadonlyArray<ResoLookup>>> =>
  Object.fromEntries(
    fields
      .filter(f => f.typeName && allLookups[f.typeName])
      .map(f => [f.fieldName, allLookups[f.typeName!]])
  );
