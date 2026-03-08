/**
 * CSDL/EDMX XML parser — converts OData metadata XML into structured types.
 *
 * Moved from certification/add-edit/src/lib/metadata.ts and enhanced with
 * enum type, entity container, and NavigationProperty extraction. Uses
 * fast-xml-parser with the same options for compatibility with existing
 * RESO tooling.
 *
 * @see https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html
 */

import { XMLParser } from 'fast-xml-parser';
import type {
  CsdlAction,
  CsdlActionImport,
  CsdlComplexType,
  CsdlEntityContainer,
  CsdlEntitySet,
  CsdlEntityType,
  CsdlEnumMember,
  CsdlEnumType,
  CsdlFunction,
  CsdlFunctionImport,
  CsdlNavigationProperty,
  CsdlNavigationPropertyBinding,
  CsdlParameter,
  CsdlProperty,
  CsdlReferentialConstraint,
  CsdlResourceInfo,
  FieldAnnotation,
  FieldInfo,
  CsdlReturnType,
  CsdlSchema,
  CsdlSingleton
} from './types.js';

/**
 * Parser options for fast-xml-parser.
 * `isArray` forces certain elements to always be arrays even when only
 * one child exists, preventing inconsistent shapes.
 */
const xmlParserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name: string) =>
    [
      'EntityType',
      'EnumType',
      'ComplexType',
      'Member',
      'Property',
      'NavigationProperty',
      'PropertyRef',
      'Annotation',
      'EntitySet',
      'NavigationPropertyBinding',
      'Action',
      'Function',
      'Parameter',
      'Singleton',
      'ActionImport',
      'FunctionImport',
      'ReferentialConstraint'
    ].includes(name)
};

/**
 * Check if a type string is a Collection wrapper: Collection(Namespace.TypeName)
 */
const isCollectionType = (type: string): boolean => type.startsWith('Collection(') && type.endsWith(')');

/**
 * Unwrap Collection(X) → X
 */
const unwrapCollectionType = (type: string): string => type.slice('Collection('.length, -1);

/**
 * Extract the unqualified type name from a potentially namespace-qualified
 * and/or Collection-wrapped type string.
 * e.g. "Collection(org.reso.metadata.Media)" → "Media"
 * e.g. "org.reso.metadata.Property" → "Property"
 */
const extractTypeName = (type: string): string => {
  const unwrapped = isCollectionType(type) ? unwrapCollectionType(type) : type;
  const dotIndex = unwrapped.lastIndexOf('.');
  return dotIndex >= 0 ? unwrapped.slice(dotIndex + 1) : unwrapped;
};

const parseProperties = (rawProperties: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlProperty> =>
  rawProperties.map(rawProp => {
    const annotations: Record<string, string> = {};
    const rawAnnotations = (rawProp.Annotation as ReadonlyArray<Record<string, string>> | undefined) ?? [];
    for (const ann of rawAnnotations) {
      const term = ann['@_Term'];
      const value = ann['@_String'] ?? ann['@_Bool'] ?? '';
      if (term) {
        annotations[term] = value;
      }
    }

    return {
      name: rawProp['@_Name'] as string,
      type: rawProp['@_Type'] as string,
      ...(rawProp['@_Nullable'] !== undefined && {
        nullable: rawProp['@_Nullable'] === 'true'
      }),
      ...(rawProp['@_MaxLength'] !== undefined && {
        maxLength: Number(rawProp['@_MaxLength'])
      }),
      ...(rawProp['@_Precision'] !== undefined && {
        precision: Number(rawProp['@_Precision'])
      }),
      ...(rawProp['@_Scale'] !== undefined && {
        scale: Number(rawProp['@_Scale'])
      }),
      ...(Object.keys(annotations).length > 0 && { annotations })
    };
  });

/**
 * Parse ReferentialConstraint child elements from a NavigationProperty.
 */
const parseReferentialConstraints = (rawConstraints: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlReferentialConstraint> =>
  rawConstraints.map(rc => ({
    property: rc['@_Property'] as string,
    referencedProperty: rc['@_ReferencedProperty'] as string
  }));

/**
 * Parse NavigationProperty elements from an entity type or complex type.
 *
 * NavigationProperty defines relationships between entity types. The type
 * attribute may be a simple qualified name (single entity) or wrapped in
 * Collection() for to-many relationships.
 *
 * @see https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_NavigationProperty
 */
const parseNavigationProperties = (rawNavProps: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlNavigationProperty> =>
  rawNavProps.map(rawNav => {
    const name = rawNav['@_Name'] as string;
    const type = rawNav['@_Type'] as string;
    const collection = isCollectionType(type);
    const entityTypeName = extractTypeName(type);

    const rawConstraints = (rawNav.ReferentialConstraint as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];

    return {
      name,
      type,
      isCollection: collection,
      entityTypeName,
      ...(rawNav['@_Nullable'] !== undefined && {
        nullable: rawNav['@_Nullable'] === 'true'
      }),
      ...(rawNav['@_Partner'] !== undefined && {
        partner: rawNav['@_Partner'] as string
      }),
      ...(rawNav['@_ContainsTarget'] !== undefined && {
        containsTarget: rawNav['@_ContainsTarget'] === 'true'
      }),
      ...(rawConstraints.length > 0 && {
        referentialConstraints: parseReferentialConstraints(rawConstraints)
      })
    };
  });

const parseEntityTypes = (rawEntityTypes: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlEntityType> =>
  rawEntityTypes.map(rawEntity => {
    const name = rawEntity['@_Name'] as string;

    const keyRefs = ((rawEntity.Key as Record<string, unknown>)?.PropertyRef as ReadonlyArray<Record<string, string>> | undefined) ?? [];
    const key = keyRefs.map(ref => ref['@_Name']);

    const rawProperties = (rawEntity.Property as ReadonlyArray<Record<string, unknown>>) ?? [];
    const rawNavProperties = (rawEntity.NavigationProperty as ReadonlyArray<Record<string, unknown>>) ?? [];

    return {
      name,
      key,
      properties: parseProperties(rawProperties),
      navigationProperties: parseNavigationProperties(rawNavProperties),
      ...(rawEntity['@_BaseType'] !== undefined && {
        baseType: rawEntity['@_BaseType'] as string
      }),
      ...(rawEntity['@_Abstract'] !== undefined && {
        abstract: rawEntity['@_Abstract'] === 'true'
      }),
      ...(rawEntity['@_OpenType'] !== undefined && {
        openType: rawEntity['@_OpenType'] === 'true'
      }),
      ...(rawEntity['@_HasStream'] !== undefined && {
        hasStream: rawEntity['@_HasStream'] === 'true'
      })
    };
  });

const parseComplexTypes = (rawComplexTypes: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlComplexType> =>
  rawComplexTypes.map(rawComplex => {
    const name = rawComplex['@_Name'] as string;

    const rawProperties = (rawComplex.Property as ReadonlyArray<Record<string, unknown>>) ?? [];
    const rawNavProperties = (rawComplex.NavigationProperty as ReadonlyArray<Record<string, unknown>>) ?? [];

    return {
      name,
      properties: parseProperties(rawProperties),
      navigationProperties: parseNavigationProperties(rawNavProperties),
      ...(rawComplex['@_BaseType'] !== undefined && {
        baseType: rawComplex['@_BaseType'] as string
      }),
      ...(rawComplex['@_Abstract'] !== undefined && {
        abstract: rawComplex['@_Abstract'] === 'true'
      }),
      ...(rawComplex['@_OpenType'] !== undefined && {
        openType: rawComplex['@_OpenType'] === 'true'
      })
    };
  });

const parseEnumTypes = (rawEnumTypes: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlEnumType> =>
  rawEnumTypes.map(rawEnum => {
    const name = rawEnum['@_Name'] as string;
    const rawMembers = (rawEnum.Member as ReadonlyArray<Record<string, string>> | undefined) ?? [];
    const members: ReadonlyArray<CsdlEnumMember> = rawMembers.map(m => ({
      name: m['@_Name'],
      ...(m['@_Value'] !== undefined && { value: m['@_Value'] })
    }));
    return {
      name,
      members,
      ...(rawEnum['@_UnderlyingType'] !== undefined && {
        underlyingType: rawEnum['@_UnderlyingType'] as string
      }),
      ...(rawEnum['@_IsFlags'] !== undefined && {
        isFlags: rawEnum['@_IsFlags'] === 'true'
      })
    };
  });

/**
 * Parse NavigationPropertyBinding elements from an EntitySet or Singleton.
 */
const parseNavigationPropertyBindings = (
  rawBindings: ReadonlyArray<Record<string, unknown>>
): ReadonlyArray<CsdlNavigationPropertyBinding> =>
  rawBindings.map(b => ({
    path: b['@_Path'] as string,
    target: b['@_Target'] as string
  }));

/**
 * Parse Parameter elements from an Action or Function.
 */
const parseParameters = (rawParams: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlParameter> =>
  rawParams.map(p => ({
    name: p['@_Name'] as string,
    type: p['@_Type'] as string,
    ...(p['@_Nullable'] !== undefined && {
      nullable: p['@_Nullable'] === 'true'
    })
  }));

/**
 * Parse a ReturnType element from an Action or Function.
 */
const parseReturnType = (rawReturn: Record<string, unknown> | undefined): CsdlReturnType | undefined => {
  if (!rawReturn) return undefined;
  return {
    type: rawReturn['@_Type'] as string,
    ...(rawReturn['@_Nullable'] !== undefined && {
      nullable: rawReturn['@_Nullable'] === 'true'
    })
  };
};

const parseActions = (rawActions: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlAction> =>
  rawActions.map(rawAction => {
    const rawParams = (rawAction.Parameter as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
    const rawReturn = rawAction.ReturnType as Record<string, unknown> | undefined;

    return {
      name: rawAction['@_Name'] as string,
      ...(rawAction['@_IsBound'] !== undefined && {
        isBound: rawAction['@_IsBound'] === 'true'
      }),
      ...(rawAction['@_EntitySetPath'] !== undefined && {
        entitySetPath: rawAction['@_EntitySetPath'] as string
      }),
      parameters: parseParameters(rawParams),
      ...(rawReturn !== undefined && {
        returnType: parseReturnType(rawReturn) as CsdlReturnType
      })
    };
  });

const parseFunctions = (rawFunctions: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<CsdlFunction> =>
  rawFunctions.map(rawFunc => {
    const rawParams = (rawFunc.Parameter as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
    const rawReturn = rawFunc.ReturnType as Record<string, unknown> | undefined;

    return {
      name: rawFunc['@_Name'] as string,
      ...(rawFunc['@_IsBound'] !== undefined && {
        isBound: rawFunc['@_IsBound'] === 'true'
      }),
      ...(rawFunc['@_IsComposable'] !== undefined && {
        isComposable: rawFunc['@_IsComposable'] === 'true'
      }),
      ...(rawFunc['@_EntitySetPath'] !== undefined && {
        entitySetPath: rawFunc['@_EntitySetPath'] as string
      }),
      parameters: parseParameters(rawParams),
      returnType: parseReturnType(rawReturn) as CsdlReturnType
    };
  });

const parseEntityContainer = (rawContainer: Record<string, unknown> | undefined): CsdlEntityContainer | undefined => {
  if (!rawContainer) return undefined;

  const name = (rawContainer['@_Name'] as string) ?? 'Default';

  // Entity sets
  const rawEntitySets = (rawContainer.EntitySet as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
  const entitySets: ReadonlyArray<CsdlEntitySet> = rawEntitySets.map(es => {
    const rawBindings = (es.NavigationPropertyBinding as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
    return {
      name: es['@_Name'] as string,
      entityType: es['@_EntityType'] as string,
      ...(rawBindings.length > 0 && {
        navigationPropertyBindings: parseNavigationPropertyBindings(rawBindings)
      })
    };
  });

  // Singletons
  const rawSingletons = (rawContainer.Singleton as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
  const singletons: ReadonlyArray<CsdlSingleton> = rawSingletons.map(s => {
    const rawBindings = (s.NavigationPropertyBinding as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
    return {
      name: s['@_Name'] as string,
      type: s['@_Type'] as string,
      ...(rawBindings.length > 0 && {
        navigationPropertyBindings: parseNavigationPropertyBindings(rawBindings)
      })
    };
  });

  // Action imports
  const rawActionImports = (rawContainer.ActionImport as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
  const actionImports: ReadonlyArray<CsdlActionImport> = rawActionImports.map(ai => ({
    name: ai['@_Name'] as string,
    action: ai['@_Action'] as string,
    ...(ai['@_EntitySet'] !== undefined && {
      entitySet: ai['@_EntitySet'] as string
    })
  }));

  // Function imports
  const rawFunctionImports = (rawContainer.FunctionImport as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
  const functionImports: ReadonlyArray<CsdlFunctionImport> = rawFunctionImports.map(fi => ({
    name: fi['@_Name'] as string,
    function: fi['@_Function'] as string,
    ...(fi['@_EntitySet'] !== undefined && {
      entitySet: fi['@_EntitySet'] as string
    })
  }));

  return { name, entitySets, singletons, actionImports, functionImports };
};

/**
 * Parse an OData EDMX/CSDL XML string into a structured CsdlSchema.
 *
 * Expects the standard EDMX 4.0 format:
 * `edmx:Edmx > edmx:DataServices > Schema > EntityType | EnumType | ComplexType | Action | Function | EntityContainer`
 *
 * @throws {Error} if the Schema element cannot be found
 */
export const parseCsdlXml = (xml: string): CsdlSchema => {
  const parser = new XMLParser(xmlParserOptions);
  const parsed = parser.parse(xml);

  const rawSchema = parsed?.['edmx:Edmx']?.['edmx:DataServices']?.Schema ?? parsed?.['edmx:Edmx']?.['edmx:DataServices']?.schema;

  if (!rawSchema) {
    throw new Error('Could not find Schema element in metadata XML');
  }

  // Handle both single Schema element and multiple Schema elements (common in external servers
  // that split entity types and enum types into separate namespaced schemas).
  const schemas: ReadonlyArray<Record<string, unknown>> = Array.isArray(rawSchema) ? rawSchema : [rawSchema];

  // Use the namespace from the first schema that has entity types, or fall back to the first schema
  const namespace: string = (schemas.find(s => s.EntityType) ?? schemas[0])['@_Namespace'] as string ?? '';

  // Merge elements from all schemas
  const rawEntityTypes: ReadonlyArray<Record<string, unknown>> = schemas.flatMap(s => (s.EntityType as ReadonlyArray<Record<string, unknown>>) ?? []);
  const rawEnumTypes: ReadonlyArray<Record<string, unknown>> = schemas.flatMap(s => (s.EnumType as ReadonlyArray<Record<string, unknown>>) ?? []);
  const rawComplexTypes: ReadonlyArray<Record<string, unknown>> = schemas.flatMap(s => (s.ComplexType as ReadonlyArray<Record<string, unknown>>) ?? []);
  const rawActions: ReadonlyArray<Record<string, unknown>> = schemas.flatMap(s => (s.Action as ReadonlyArray<Record<string, unknown>>) ?? []);
  const rawFunctions: ReadonlyArray<Record<string, unknown>> = schemas.flatMap(s => (s.Function as ReadonlyArray<Record<string, unknown>>) ?? []);
  // EntityContainer is typically in one schema — find it
  const rawContainer = schemas.reduce<Record<string, unknown> | undefined>(
    (found, s) => found ?? (s.EntityContainer as Record<string, unknown> | undefined),
    undefined
  );

  return {
    namespace,
    entityTypes: parseEntityTypes(rawEntityTypes),
    enumTypes: parseEnumTypes(rawEnumTypes),
    complexTypes: parseComplexTypes(rawComplexTypes),
    actions: parseActions(rawActions),
    functions: parseFunctions(rawFunctions),
    entityContainer: parseEntityContainer(rawContainer)
  };
};

/**
 * Discover all resources (entity sets) from a parsed schema, resolving
 * key fields and navigation properties from their entity type definitions.
 *
 * @throws {Error} if the schema has no EntityContainer
 */
export const discoverResources = (schema: CsdlSchema): ReadonlyArray<CsdlResourceInfo> => {
  if (!schema.entityContainer) {
    throw new Error('No EntityContainer found in metadata');
  }

  const entityTypeMap = new Map(schema.entityTypes.map(et => [et.name, et]));

  /** Resolve key field by walking up the inheritance chain. */
  const resolveKeyField = (et: CsdlEntityType | undefined, fallback: string): string => {
    let current = et;
    while (current) {
      if (current.key.length > 0) return current.key[0];
      if (!current.baseType) break;
      current = entityTypeMap.get(extractTypeName(current.baseType));
    }
    return fallback;
  };

  /**
   * Find a human-friendly alternate key (e.g. ListingId, MemberId) distinct from the primary key.
   * Prefers a field matching the key field pattern (e.g. ListingKey → ListingId) or the
   * entity set / type name + "Id", then falls back to the first Edm.String *Id field.
   */
  const resolveAlternateKey = (
    et: CsdlEntityType | undefined,
    keyField: string,
    entitySetName: string,
    typeName: string
  ): string | undefined => {
    if (!et) return undefined;
    const idProps = et.properties.filter(
      p => p.name !== keyField && p.name.endsWith('Id') && p.type === 'Edm.String'
    );
    if (idProps.length === 0) return undefined;

    // Derive the stem from the key field (e.g. "ListingKey" → "Listing", "MemberKey" → "Member")
    const keyStem = keyField.endsWith('Key') ? keyField.slice(0, -3) : undefined;
    const preferredNames = [
      keyStem ? `${keyStem}Id` : undefined,    // ListingKey → ListingId
      `${entitySetName}Id`,                     // Property → PropertyId
      `${typeName}Id`                           // Property → PropertyId (type name)
    ].filter((n): n is string => n !== undefined);

    const preferred = preferredNames.reduce<string | undefined>(
      (found, name) => found ?? idProps.find(p => p.name === name)?.name,
      undefined
    );
    return preferred;
  };

  return schema.entityContainer.entitySets.map(es => {
    const typeName = extractTypeName(es.entityType);
    const et = entityTypeMap.get(typeName);
    const keyField = resolveKeyField(et, `${typeName}Key`);
    const alternateKeyField = resolveAlternateKey(et, keyField, es.name, typeName);
    const navigationProperties = et?.navigationProperties.map(np => np.name) ?? [];
    return {
      name: es.name, entityType: es.entityType, keyField,
      ...(alternateKeyField ? { alternateKeyField } : {}),
      navigationProperties
    };
  });
};

/** Find an entity type by name. */
export const getEntityType = (schema: CsdlSchema, name: string): CsdlEntityType | undefined =>
  schema.entityTypes.find(et => et.name === name);

/** Find an enum type by name. */
export const getEnumType = (schema: CsdlSchema, name: string): CsdlEnumType | undefined => schema.enumTypes.find(et => et.name === name);

/** Find a complex type by name. */
export const getComplexType = (schema: CsdlSchema, name: string): CsdlComplexType | undefined => schema.complexTypes.find(ct => ct.name === name);

/** The RESO annotation term that indicates a field uses the Lookup Resource. */
const LOOKUP_NAME_TERM = 'RESO.OData.Metadata.LookupName';

/** Check if a CSDL type is an Edm primitive. */
const isEdmPrimitive = (type: string): boolean => {
  const unwrapped = isCollectionType(type) ? unwrapCollectionType(type) : type;
  return unwrapped.startsWith('Edm.');
};

/** Convert CSDL annotations record to FieldAnnotation array. */
const toAnnotations = (annotations?: Readonly<Record<string, string>>): ReadonlyArray<FieldAnnotation> =>
  annotations ? Object.entries(annotations).map(([term, value]) => ({ term, value })) : [];

/** Convert a single CSDL property to a FieldInfo. */
const propertyToFieldInfo = (resourceName: string, prop: CsdlProperty, namespace: string): FieldInfo => {
  const rawType = isCollectionType(prop.type) ? unwrapCollectionType(prop.type) : prop.type;
  const lookupName = prop.annotations?.[LOOKUP_NAME_TERM];
  const isCsdlEnum = !isEdmPrimitive(prop.type) && !prop.type.startsWith('Collection(Edm.');

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

/**
 * Extract field metadata for all properties and navigation properties
 * of a CSDL entity type.
 */
export const getFieldsForEntityType = (
  schema: CsdlSchema,
  entityType: CsdlEntityType,
  resourceName: string
): ReadonlyArray<FieldInfo> => {
  const fields = entityType.properties.map(p =>
    propertyToFieldInfo(resourceName, p, schema.namespace)
  );

  const navFields: ReadonlyArray<FieldInfo> = entityType.navigationProperties.map(nav => ({
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

/**
 * Extract field metadata for a resource (entity set) by name.
 * Returns all properties and navigation properties as FieldInfo.
 *
 * @throws {Error} if the schema has no EntityContainer or the resource is not found
 */
export const getFieldsForResource = (schema: CsdlSchema, resourceName: string): ReadonlyArray<FieldInfo> => {
  if (!schema.entityContainer) throw new Error('No EntityContainer found in metadata');

  const entitySet = schema.entityContainer.entitySets.find(es => es.name === resourceName);
  if (!entitySet) throw new Error(`Resource "${resourceName}" not found in metadata`);

  const typeName = extractTypeName(entitySet.entityType);
  const entityType = schema.entityTypes.find(et => et.name === typeName);
  if (!entityType) throw new Error(`Entity type "${typeName}" not found in metadata`);

  return getFieldsForEntityType(schema, entityType, resourceName);
};

/**
 * Extract field metadata for all resources in a schema.
 * Returns a record keyed by entity set name.
 */
export const getAllFields = (schema: CsdlSchema): Readonly<Record<string, ReadonlyArray<FieldInfo>>> => {
  if (!schema.entityContainer) return {};

  const entityTypeMap = new Map(schema.entityTypes.map(et => [et.name, et]));

  return Object.fromEntries(
    schema.entityContainer.entitySets.map(es => {
      const typeName = extractTypeName(es.entityType);
      const entityType = entityTypeMap.get(typeName);
      if (!entityType) return [es.name, []];
      return [es.name, getFieldsForEntityType(schema, entityType, es.name)];
    })
  );
};
