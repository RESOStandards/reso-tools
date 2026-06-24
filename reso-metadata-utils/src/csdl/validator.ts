/**
 * CSDL schema validator — checks semantic requirements of a parsed
 * OData metadata document against rules from the OData CSDL specification.
 *
 * @see https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html
 * @see https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html
 */

import type { CsdlEntitySet, CsdlSchema, CsdlValidationError, CsdlValidationResult } from './types.js';

/** Valid OData primitive type prefixes. */
const EDM_TYPES = new Set([
  'Edm.Binary',
  'Edm.Boolean',
  'Edm.Byte',
  'Edm.Date',
  'Edm.DateTimeOffset',
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Duration',
  'Edm.Guid',
  'Edm.Int16',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.SByte',
  'Edm.Single',
  'Edm.Stream',
  'Edm.String',
  'Edm.TimeOfDay',
  'Edm.Geography',
  'Edm.GeographyPoint',
  'Edm.GeographyLineString',
  'Edm.GeographyPolygon',
  'Edm.GeographyMultiPoint',
  'Edm.GeographyMultiLineString',
  'Edm.GeographyMultiPolygon',
  'Edm.GeographyCollection',
  'Edm.Geometry',
  'Edm.GeometryPoint',
  'Edm.GeometryLineString',
  'Edm.GeometryPolygon',
  'Edm.GeometryMultiPoint',
  'Edm.GeometryMultiLineString',
  'Edm.GeometryMultiPolygon',
  'Edm.GeometryCollection'
]);

const isEdmPrimitive = (type: string): boolean => EDM_TYPES.has(type);

const isCollectionType = (type: string): boolean => type.startsWith('Collection(') && type.endsWith(')');

const unwrapCollection = (type: string): string => type.slice('Collection('.length, -1);

// ---------------------------------------------------------------------------
// OData CSDL Specification URLs
// ---------------------------------------------------------------------------

const SPEC = {
  v4: {
    entityTypeKey: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092870',
    entityTypeBaseType: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092866',
    complexTypeBaseType: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092877',
    entitySetEntityType: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092918',
    bindingPath: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092921',
    bindingTarget: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092922',
    navPropertyType: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092857',
    referentialConstraint: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092861',
  },
  v401: {
    entityTypeKey: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_Key',
    entityTypeBaseType: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_DerivedEntityType',
    complexTypeBaseType: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_DerivedComplexType',
    entitySetEntityType: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_EntitySet',
    bindingPath: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_NavigationPropertyPathBinding',
    bindingTarget: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_BindingTarget',
    navPropertyType: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_NavigationProperty',
    referentialConstraint: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_ReferentialConstraint',
  },
} as const;

interface SpecUrls {
  readonly entityTypeKey: string;
  readonly entityTypeBaseType: string;
  readonly complexTypeBaseType: string;
  readonly entitySetEntityType: string;
  readonly bindingPath: string;
  readonly bindingTarget: string;
  readonly navPropertyType: string;
  readonly referentialConstraint: string;
}

/**
 * Validate a parsed CSDL schema for semantic correctness.
 *
 * Checks (ported from Apache Olingo CsdlTypeValidator):
 * 1. Entity types have at least one key property (unless abstract or derived)
 * 2. Entity type BaseType references are resolvable
 * 3. Complex type BaseType references are resolvable
 * 4. Entity sets reference valid entity types
 * 5. NavigationPropertyBinding Path references a valid navigation property
 * 6. NavigationPropertyBinding Target references a valid entity set
 * 7. Navigation property type matches binding target entity type
 * 8. ReferentialConstraint Property exists on the source entity type
 * 9. ReferentialConstraint ReferencedProperty exists on the target entity type
 *
 * @param schema - Parsed CSDL schema.
 * @param odataVersion - OData version for spec links (defaults to '4.0').
 */
export const validateCsdl = (schema: CsdlSchema, odataVersion: '4.0' | '4.01' = '4.0'): CsdlValidationResult => {
  const errors: CsdlValidationError[] = [];
  const spec: SpecUrls = odataVersion === '4.01' ? SPEC.v401 : SPEC.v4;

  // Check namespace
  if (!schema.namespace) {
    errors.push({
      path: 'Schema',
      message: 'Schema namespace is missing or empty',
    });
  }

  // Build set of known type names for reference checking
  const knownTypeNames = new Set([
    ...schema.entityTypes.map(et => `${schema.namespace}.${et.name}`),
    ...schema.enumTypes.map(et => `${schema.namespace}.${et.name}`),
    ...schema.complexTypes.map(ct => `${schema.namespace}.${ct.name}`)
  ]);

  /**
   * Check whether a property type is valid: either an Edm primitive,
   * a known schema type, or an externally namespace-qualified type.
   */
  const validatePropertyType = (propType: string, propPath: string): void => {
    const typeToCheck = isCollectionType(propType) ? unwrapCollection(propType) : propType;

    if (!isEdmPrimitive(typeToCheck) && !knownTypeNames.has(typeToCheck)) {
      // Allow namespace-qualified types we haven't seen (external references)
      if (!typeToCheck.includes('.')) {
        errors.push({
          path: propPath,
          message: `Property type '${propType}' is not a valid Edm primitive or known type`,
        });
      }
    }
  };

  // --- Rule 1: Entity type key required ---
  // --- Rule 2: Entity type BaseType must be resolvable ---
  for (const entityType of schema.entityTypes) {
    const etPath = `EntityType('${entityType.name}')`;

    if (entityType.key.length === 0 && !entityType.abstract && !entityType.baseType) {
      errors.push({
        path: etPath,
        message: `Entity type '${entityType.name}' has no key properties defined`,
        specUrl: spec.entityTypeKey,
      });
    }

    const propertyNames = new Set(entityType.properties.map(p => p.name));

    for (const keyProp of entityType.key) {
      if (!propertyNames.has(keyProp)) {
        errors.push({
          path: `${etPath}/Key`,
          message: `Entity type '${entityType.name}' lists '${keyProp}' as a Key property but '${keyProp}' isn't declared as one of its properties.`,
          specUrl: spec.entityTypeKey,
        });
      }
    }

    for (const prop of entityType.properties) {
      validatePropertyType(prop.type, `${etPath}/Property(${prop.name})`);
    }

    for (const navProp of entityType.navigationProperties) {
      const targetType = isCollectionType(navProp.type) ? unwrapCollection(navProp.type) : navProp.type;
      if (!knownTypeNames.has(targetType) && !targetType.includes('.')) {
        errors.push({
          path: `${etPath}/NavigationProperty(${navProp.name})`,
          message: `Navigation property references unknown entity type '${targetType}'`,
          specUrl: spec.navPropertyType,
        });
      }
    }

    if (entityType.baseType && !knownTypeNames.has(entityType.baseType)) {
      if (!entityType.baseType.includes('.')) {
        errors.push({
          path: etPath,
          message: `BaseType '${entityType.baseType}' is not a known entity type`,
          specUrl: spec.entityTypeBaseType,
        });
      }
    }
  }

  // --- Rule 3: Complex type BaseType must be resolvable ---
  for (const complexType of schema.complexTypes) {
    const ctPath = `ComplexType(${complexType.name})`;

    if (complexType.baseType) {
      if (!knownTypeNames.has(complexType.baseType) && !complexType.baseType.includes('.')) {
        errors.push({
          path: ctPath,
          message: `BaseType '${complexType.baseType}' is not a known complex type`,
          specUrl: spec.complexTypeBaseType,
        });
      }
    }

    for (const prop of complexType.properties) {
      validatePropertyType(prop.type, `${ctPath}/Property(${prop.name})`);
    }

    for (const navProp of complexType.navigationProperties) {
      const targetType = isCollectionType(navProp.type) ? unwrapCollection(navProp.type) : navProp.type;
      if (!knownTypeNames.has(targetType) && !targetType.includes('.')) {
        errors.push({
          path: `${ctPath}/NavigationProperty(${navProp.name})`,
          message: `Navigation property references unknown entity type '${targetType}'`,
          specUrl: spec.navPropertyType,
        });
      }
    }
  }

  // Build lookup maps for entity container validation
  const entityTypeMap = new Map(
    schema.entityTypes.map(et => [`${schema.namespace}.${et.name}`, et])
  );
  const entitySetMap = schema.entityContainer
    ? new Map(schema.entityContainer.entitySets.map(es => [es.name, es]))
    : new Map<string, CsdlEntitySet>();

  // --- Rule 4: Entity sets reference valid entity types ---
  // --- Rule 5: Binding Path references a valid navigation property ---
  // --- Rule 6: Binding Target references a valid entity set ---
  // --- Rule 7: Nav property type matches binding target entity type ---
  if (schema.entityContainer) {
    for (const entitySet of schema.entityContainer.entitySets) {
      const esPath = `EntityContainer/EntitySet(${entitySet.name})`;

      if (!knownTypeNames.has(entitySet.entityType)) {
        if (!entitySet.entityType.includes('.')) {
          errors.push({
            path: esPath,
            message: `Entity set references unknown entity type '${entitySet.entityType}'`,
            specUrl: spec.entitySetEntityType,
          });
        }
      }

      if (entitySet.navigationPropertyBindings) {
        const sourceEntityType = entityTypeMap.get(entitySet.entityType);

        for (const binding of entitySet.navigationPropertyBindings) {
          const bindingPath = `${esPath}/NavigationPropertyBinding(Path=${binding.path}, Target=${binding.target})`;

          // Rule 5: Binding path
          if (sourceEntityType) {
            const pathSegments = binding.path.split('/');
            const navPropName = pathSegments[pathSegments.length - 1];
            const hasNavProp = sourceEntityType.navigationProperties.some(np => np.name === navPropName);
            if (!hasNavProp) {
              errors.push({
                path: bindingPath,
                message: `Binding path '${binding.path}' does not reference a navigation property on entity type '${sourceEntityType.name}'`,
                specUrl: spec.bindingPath,
              });
            }
          }

          // Rule 6: Binding target
          const targetName = binding.target.includes('/') ? binding.target.split('/').pop()! : binding.target;
          if (!entitySetMap.has(targetName)) {
            errors.push({
              path: bindingPath,
              message: `Binding target '${binding.target}' does not reference a valid entity set in the container`,
              specUrl: spec.bindingTarget,
            });
          }

          // Rule 7: Nav property type matches target
          if (sourceEntityType) {
            const pathSegments = binding.path.split('/');
            const navPropName = pathSegments[pathSegments.length - 1];
            const navProp = sourceEntityType.navigationProperties.find(np => np.name === navPropName);
            const targetEntitySet = entitySetMap.get(targetName);

            if (navProp && targetEntitySet) {
              const navTargetType = isCollectionType(navProp.type) ? unwrapCollection(navProp.type) : navProp.type;
              if (navTargetType.includes('.') && targetEntitySet.entityType.includes('.') && navTargetType !== targetEntitySet.entityType) {
                errors.push({
                  path: bindingPath,
                  message: `Navigation property type '${navTargetType}' does not match binding target entity type '${targetEntitySet.entityType}'`,
                  specUrl: spec.navPropertyType,
                });
              }
            }
          }
        }
      }
    }
  }

  // --- Rule 8: Constraint Property exists on source entity type ---
  // --- Rule 9: Constraint ReferencedProperty exists on target entity type ---
  for (const entityType of schema.entityTypes) {
    const etPath = `EntityType('${entityType.name}')`;
    const propertyNames = new Set(entityType.properties.map(p => p.name));

    for (const navProp of entityType.navigationProperties) {
      if (navProp.referentialConstraints) {
        for (const constraint of navProp.referentialConstraints) {
          if (!propertyNames.has(constraint.property)) {
            errors.push({
              path: `${etPath}/NavigationProperty(${navProp.name})/ReferentialConstraint`,
              message: `Constraint property '${constraint.property}' does not exist on entity type '${entityType.name}'`,
              specUrl: spec.referentialConstraint,
            });
          }

          const targetTypeFqn = isCollectionType(navProp.type) ? unwrapCollection(navProp.type) : navProp.type;
          const targetEntityType = entityTypeMap.get(targetTypeFqn);
          if (targetEntityType) {
            const targetPropNames = new Set(targetEntityType.properties.map(p => p.name));
            if (!targetPropNames.has(constraint.referencedProperty)) {
              errors.push({
                path: `${etPath}/NavigationProperty(${navProp.name})/ReferentialConstraint`,
                message: `Referenced property '${constraint.referencedProperty}' does not exist on target entity type '${targetEntityType.name}'`,
                specUrl: spec.referentialConstraint,
              });
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
};
