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
    entityContainer: 'https://docs.oasis-open.org/odata/odata/v4.0/csd01/part3-csdl/odata-v4.0-csd01-part3-csdl.html#_Toc355092911',
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
    entityContainer: 'https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/odata-csdl-xml-v4.01.html#sec_EntityContainer',
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
  readonly entityContainer: string;
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
 * 0. A single entity container is present (a service metadata document must expose one)
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

  // Require an entity container. A metadata document that describes an OData service must define one (commonly
  // named "Default") — it declares the entity sets a client can query, so a service without one exposes no
  // resources. The serializer enforces the same requirement downstream; catching it here gives the provider a
  // clear reason at the validation step instead of an opaque serialization failure later.
  if (!schema.entityContainer) {
    errors.push({
      path: 'EntityContainer',
      message:
        'No EntityContainer was found in the metadata. An OData service metadata document must contain a single ' +
        'entity container (commonly named "Default") that defines the resources the service exposes. Add a ' +
        '<Schema> containing an <EntityContainer> whose <EntitySet> entries list your resources (Property, Member, …).',
      specUrl: spec.entityContainer,
    });
  }

  // The FQDN a declared type is registered under: its OWN namespace when it carries one (multi-schema
  // EDMX splits types across namespaces — a provider may put enums in a separate namespace, e.g.
  // org.reso.metadata.enums distinct from org.reso.metadata), else the schema namespace (a
  // single-namespace document). The namespace strings are provider-chosen; RESO fixes no vocabulary of
  // FQDNs — an FQDN is just the key that links a reference to its declaration.
  const fqdn = (t: { readonly name: string; readonly namespace?: string }): string => `${t.namespace ?? schema.namespace}.${t.name}`;

  // Every type this document declares — entity, enum, complex — registered under its true FQDN. This
  // drives a referential-integrity check, NOT a check against any known/blessed FQDN set (there is none
  // for RESO): a reference is valid iff it links to a declaration here. Registering all kinds
  // symmetrically under their own namespace keeps this set consistent with declaredNamespaces below.
  const declaredTypeFqdns = new Set([
    ...schema.entityTypes.map(fqdn),
    ...schema.enumTypes.map(fqdn),
    ...schema.complexTypes.map(fqdn)
  ]);

  // The namespaces this document actually declares a type in — the primary namespace plus every distinct
  // namespace any entity, enum, or complex type is declared in. A reference qualified with one of these
  // SHOULD link to a declaration here; if it links to nothing it's dangling — a broken internal link. A
  // reference in any OTHER namespace is external — declared in some schema this document doesn't contain,
  // which the validator can't see — so it's left alone. Building this from ALL type kinds (not enums
  // alone) is what keeps a conformant provider that co-locates, say, a complex type with its enums in a
  // non-primary namespace from false-failing.
  const declaredNamespaces = new Set<string>([
    schema.namespace,
    ...schema.entityTypes.map(et => et.namespace ?? schema.namespace),
    ...schema.enumTypes.map(et => et.namespace ?? schema.namespace),
    ...schema.complexTypes.map(ct => ct.namespace ?? schema.namespace)
  ]);

  /**
   * A type reference is a DANGLING reference when it points into a namespace this document declares
   * types in (or is a bare, implicitly-primary name) yet links to no type declared here — a broken
   * internal link (a typo'd or renamed target). A reference into a namespace this document declares
   * NOTHING in is EXTERNAL — resolved by some schema this validator can't see — and is left alone. This
   * is internal referential integrity, not conformance to any canonical FQDN: the FQDN is only the
   * provider-chosen key that links a reference to its declaration.
   */
  const isDanglingReference = (typeName: string): boolean => {
    if (declaredTypeFqdns.has(typeName)) return false; // links to a type declared here
    const lastDot = typeName.lastIndexOf('.');
    if (lastDot === -1) return true; // bare name → implicitly the primary namespace → must be declared here
    return declaredNamespaces.has(typeName.slice(0, lastDot)); // a declared namespace but no such type → broken link
  };

  /**
   * Check whether a property type is valid: either an Edm primitive,
   * a known schema type, or an externally namespace-qualified type.
   */
  const validatePropertyType = (propType: string, propPath: string): void => {
    const typeToCheck = isCollectionType(propType) ? unwrapCollection(propType) : propType;

    if (!isEdmPrimitive(typeToCheck) && isDanglingReference(typeToCheck)) {
      // A reference into a declared namespace that links to no type here is dangling (a broken link); a
      // reference into a namespace this document doesn't declare is external, and this validator allows it.
      errors.push({
        path: propPath,
        message: `Property type '${propType}' is not a valid Edm primitive or known type`,
      });
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
      if (isDanglingReference(targetType)) {
        errors.push({
          path: `${etPath}/NavigationProperty(${navProp.name})`,
          message: `Navigation property references unknown entity type '${targetType}'`,
          specUrl: spec.navPropertyType,
        });
      }
    }

    if (entityType.baseType && isDanglingReference(entityType.baseType)) {
      errors.push({
        path: etPath,
        message: `BaseType '${entityType.baseType}' is not a known entity type`,
        specUrl: spec.entityTypeBaseType,
      });
    }
  }

  // --- Rule 3: Complex type BaseType must be resolvable ---
  for (const complexType of schema.complexTypes) {
    const ctPath = `ComplexType(${complexType.name})`;

    if (complexType.baseType && isDanglingReference(complexType.baseType)) {
      errors.push({
        path: ctPath,
        message: `BaseType '${complexType.baseType}' is not a known complex type`,
        specUrl: spec.complexTypeBaseType,
      });
    }

    for (const prop of complexType.properties) {
      validatePropertyType(prop.type, `${ctPath}/Property(${prop.name})`);
    }

    for (const navProp of complexType.navigationProperties) {
      const targetType = isCollectionType(navProp.type) ? unwrapCollection(navProp.type) : navProp.type;
      if (isDanglingReference(targetType)) {
        errors.push({
          path: `${ctPath}/NavigationProperty(${navProp.name})`,
          message: `Navigation property references unknown entity type '${targetType}'`,
          specUrl: spec.navPropertyType,
        });
      }
    }
  }

  // Build lookup maps for entity container validation (keyed by each entity's true FQDN, so a binding
  // or referential-constraint reference into a non-primary namespace resolves to the declared type).
  const entityTypeMap = new Map(
    schema.entityTypes.map(et => [fqdn(et), et])
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

      if (isDanglingReference(entitySet.entityType)) {
        errors.push({
          path: esPath,
          message: `Entity set references unknown entity type '${entitySet.entityType}'`,
          specUrl: spec.entitySetEntityType,
        });
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
