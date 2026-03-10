/**
 * Converts CSDL schema types from @reso-standards/odata-client into the ResoField
 * types used by the UI. This enables the UI to work with any OData server's $metadata.
 */
import type { CsdlEntityType, CsdlProperty, CsdlSchema } from '@reso-standards/odata-client';
import type { ResoAnnotation, ResoField } from '../types';

/** The RESO annotation term that indicates a field uses the Lookup Resource. */
const LOOKUP_NAME_TERM = 'RESO.OData.Metadata.LookupName';

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

  // Check for Lookup Resource annotation (Edm.String or Collection(Edm.String) with LookupName)
  const lookupName = prop.annotations?.[LOOKUP_NAME_TERM];

  // A field is a CSDL enum if its type is not an Edm primitive and not Collection(Edm.*)
  const isCsdlEnum = !isEdmPrimitive(prop.type) && !prop.type.startsWith('Collection(Edm.');

  // For CSDL enum types, extract just the type name without namespace
  // For Lookup Resource fields, use the lookupName as the typeName
  const typeName = isCsdlEnum
    ? (rawType.startsWith(namespace + '.') ? rawType.slice(namespace.length + 1) : rawType)
    : lookupName ?? undefined;

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
    annotations: toAnnotations(prop.annotations),
    lookupName: lookupName ?? undefined
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
