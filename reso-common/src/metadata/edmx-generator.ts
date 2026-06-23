import { getFieldsForResource, getKeyFieldForResource, getLookupsForType, isEnumType } from './helpers.js';
import type { EnumMode, ResoField, ResoMetadata } from './model.js';

/** Escapes special XML characters in attribute values. */
const escapeXml = (str: string): string => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** OData SimpleIdentifier: starts with letter or underscore, then letters/digits/underscores, max 128 chars. */
const SIMPLE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Checks whether a string is a valid OData SimpleIdentifier. */
const isValidSimpleIdentifier = (name: string): boolean => SIMPLE_IDENTIFIER_RE.test(name);

/** Unwrap Collection(X) → X */
const unwrapCollection = (type: string): string =>
  type.startsWith('Collection(') && type.endsWith(')') ? type.slice('Collection('.length, -1) : type;

/**
 * Whether a field is an enumeration for EDMX generation: a nominal (non-Edm) enum type, or the string
 * representation (Edm.String + isEnumeration). A PRIMITIVE type carrying a spurious isEnumeration flag
 * (e.g. the DD 2.1 Boolean quirk BuiltPre1978YN — a Boolean with a LookupStatus) is NOT an enum; the
 * declared type wins, matching the DD field-type check.
 */
const isEnumField = (field: ResoField, rawType: string): boolean =>
  isEnumType(rawType) || (field.isEnumeration === true && rawType === 'Edm.String');

/** Maps a RESO field type to an EDMX Property type string. */
const toEdmxType = (field: ResoField, enumMode: EnumMode): string => {
  const rawType = unwrapCollection(field.type);
  const isEnum = isEnumField(field, rawType);
  const isCol = field.isCollection || field.type.startsWith('Collection(');

  if (isEnum) {
    if (enumMode === 'enum-type') {
      return isCol ? `Collection(${rawType})` : rawType;
    }
    // String mode: enums become Edm.String or Collection(Edm.String)
    return isCol ? 'Collection(Edm.String)' : 'Edm.String';
  }

  // DD numeric with scale 0 is an Integer — the DD's precision/scale columns don't map cleanly to
  // OData, and an empty Suggested Max Precision (our scale 0) denotes a whole number. Emit Edm.Int64,
  // matching the Commander's EDMXProcessor; the exact bucket is not significant (data capacity is the
  // schema-validation step's concern). scale > 0 stays a true Decimal.
  if ((rawType === 'Edm.Decimal' || rawType === 'Edm.Double') && (field.scale ?? 0) === 0) {
    return isCol ? 'Collection(Edm.Int64)' : 'Edm.Int64';
  }

  return field.type;
};

/** Generates an EDMX Property element string for a field. */
const generateProperty = (field: ResoField, enumMode: EnumMode): string => {
  const type = toEdmxType(field, enumMode);
  const attrs: string[] = [`Name="${escapeXml(field.fieldName)}"`, `Type="${escapeXml(type)}"`];

  if (field.isCollection) {
    // Collections return [] not null — always Nullable="false"
    attrs.push('Nullable="false"');
  } else if (field.nullable === false) {
    // Nullable="true" is the OData default for non-collection properties — only emit when false
    attrs.push('Nullable="false"');
  }
  // Emit facets only on the types that carry them, keyed off the EMITTED type — a DD Decimal with
  // scale 0 is emitted as Edm.Int64, which must not carry Precision/Scale/MaxLength.
  const emittedBase = unwrapCollection(type);
  if (emittedBase === 'Edm.String' && field.maxLength !== undefined) {
    attrs.push(`MaxLength="${field.maxLength}"`);
  }
  if (emittedBase === 'Edm.Decimal' && field.precision !== undefined) {
    attrs.push(`Precision="${field.precision}"`);
  }
  if (emittedBase === 'Edm.Decimal' && field.scale !== undefined) {
    attrs.push(`Scale="${field.scale}"`);
  }

  // LookupName annotation: only in string mode for enum fields
  const rawType = unwrapCollection(field.type);
  const isEnum = isEnumField(field, rawType);
  const lookupShortName = field.typeName ?? (rawType.includes('.') ? rawType.slice(rawType.lastIndexOf('.') + 1) : null);
  const lookupAnnotation =
    enumMode === 'string' && isEnum && lookupShortName
      ? `\n          <Annotation Term="RESO.OData.Metadata.LookupName" String="${escapeXml(lookupShortName)}"/>`
      : '';

  if (lookupAnnotation) {
    return `        <Property ${attrs.join(' ')}>${lookupAnnotation}\n        </Property>`;
  }

  return `        <Property ${attrs.join(' ')}/>`;
};

/** Generates an EDMX NavigationProperty element for an expansion field. */
const generateNavigationProperty = (field: ResoField): string => {
  // Don't double-wrap Collection() — the type may already include it from the metadata report
  const type = field.type.startsWith('Collection(') ? field.type : (field.isCollection ? `Collection(${field.type})` : field.type);
  return `        <NavigationProperty Name="${escapeXml(field.fieldName)}" Type="${escapeXml(type)}"/>`;
};

/** Generates an EDMX EntityType element for a resource. */
const generateEntityType = (
  resourceName: string,
  keyFields: ReadonlyArray<string>,
  fields: ReadonlyArray<ResoField>,
  targetResourceSet: ReadonlySet<string>,
  enumMode: EnumMode
): string => {
  const regularFields = fields.filter(f => !f.isExpansion);
  // Only emit NavigationProperty for types that exist in the schema
  const expansionFields = fields.filter(f => f.isExpansion && f.typeName && targetResourceSet.has(f.typeName));

  const properties = regularFields.map(f => generateProperty(f, enumMode)).join('\n');
  const navProperties = expansionFields.map(generateNavigationProperty).join('\n');

  // One PropertyRef per key field — compound keys carry every field the data marks as primary.
  const keyRefs = keyFields.map(k => `          <PropertyRef Name="${escapeXml(k)}"/>`).join('\n');

  return `      <EntityType Name="${escapeXml(resourceName)}">
        <Key>
${keyRefs}
        </Key>
${properties}
${navProperties ? `${navProperties}\n` : ''}      </EntityType>`;
};

/** Generates an EntitySet element with NavigationPropertyBinding entries. */
const generateEntitySet = (resourceName: string, fields: ReadonlyArray<ResoField>, targetResourceSet: ReadonlySet<string>): string => {
  const namespace = 'org.reso.metadata';
  const expansionFields = fields.filter(f => f.isExpansion && f.typeName && targetResourceSet.has(f.typeName));

  if (expansionFields.length === 0) {
    return `        <EntitySet Name="${escapeXml(resourceName)}" EntityType="${namespace}.${escapeXml(resourceName)}"/>`;
  }

  const bindings = expansionFields
    .map(f => `          <NavigationPropertyBinding Path="${escapeXml(f.fieldName)}" Target="${escapeXml(f.typeName!)}"/>`)
    .join('\n');

  return `        <EntitySet Name="${escapeXml(resourceName)}" EntityType="${namespace}.${escapeXml(resourceName)}">\n${bindings}\n        </EntitySet>`;
};

/** Collected EnumType definition for EDMX generation. */
interface EnumTypeDefinition {
  readonly enumTypeName: string;
  readonly members: ReadonlyArray<{ readonly name: string; readonly value: number; readonly standardName?: string }>;
}

/** Enum namespace prefix used in the RESO metadata. */
const ENUM_PREFIX = 'org.reso.metadata.enums.';

/** The annotation term carrying a lookup's human-friendly display name. */
const ANNOTATION_STANDARD_NAME = 'RESO.OData.Metadata.StandardName';

/**
 * Collects all unique enum types referenced by the active resources and
 * builds EnumType definitions with sequential member values.
 * Skips any lookup whose lookupValue is not a valid OData SimpleIdentifier.
 */
const collectEnumTypes = (metadata: ResoMetadata, targetResources: ReadonlyArray<string>): ReadonlyArray<EnumTypeDefinition> => {
  const enumTypeNames = new Set<string>();
  for (const resource of targetResources) {
    const fields = getFieldsForResource(metadata, resource);
    for (const field of fields) {
      if (!field.isExpansion && isEnumType(field.type)) {
        enumTypeNames.add(field.type);
      }
    }
  }

  return [...enumTypeNames]
    .sort()
    .map(fqn => {
      const lookups = getLookupsForType(metadata, fqn);
      const shortName = fqn.startsWith(ENUM_PREFIX) ? fqn.slice(ENUM_PREFIX.length) : fqn;

      // Skip members whose value is not a valid OData SimpleIdentifier (they cannot be
      // emitted as EnumType members). Filtered silently — no logging in a pure lib.
      const members = lookups
        .filter(l => isValidSimpleIdentifier(l.lookupValue))
        .map((l, index) => ({
          name: l.lookupValue,
          value: index,
          standardName: l.annotations.find(a => a.term === ANNOTATION_STANDARD_NAME)?.value,
        }));

      return { enumTypeName: shortName, members };
    })
    .filter(e => e.members.length > 0);
};

/** Renders a single EnumType XML element. */
const generateEnumTypeXml = (enumType: EnumTypeDefinition): string => {
  const memberElements = enumType.members
    .map(m =>
      m.standardName
        ? `        <Member Name="${escapeXml(m.name)}" Value="${m.value}">\n          <Annotation Term="${ANNOTATION_STANDARD_NAME}" String="${escapeXml(m.standardName)}"/>\n        </Member>`
        : `        <Member Name="${escapeXml(m.name)}" Value="${m.value}"/>`,
    )
    .join('\n');

  return `      <EnumType Name="${escapeXml(enumType.enumTypeName)}">\n${memberElements}\n      </EnumType>`;
};

/**
 * Generates a complete EDMX 4.0 XML metadata document from RESO JSON metadata.
 *
 * The output is compatible with fast-xml-parser using the same options as the
 * certification add/edit metadata parser (attributeNamePrefix: "@_",
 * isArray for EntityType/Property/PropertyRef/Annotation).
 *
 * In enum-type mode, a second Schema block with namespace "org.reso.metadata.enums"
 * contains EnumType definitions referenced by entity properties. In string mode,
 * enum fields become Edm.String with a RESO.OData.Metadata.LookupName annotation.
 *
 * Pure and universal — builds the XML by string concatenation, no Node or DOM APIs.
 */
export const generateEdmx = (metadata: ResoMetadata, targetResources: ReadonlyArray<string>, enumMode: EnumMode = 'string'): string => {
  const targetResourceSet: ReadonlySet<string> = new Set(targetResources);
  const resourceData = targetResources
    .map(resource => {
      const fields = getFieldsForResource(metadata, resource);
      if (fields.length === 0) return null;
      // Prefer keys the data carries (the live-server / generated CSDL <Key>, compound-safe); fall
      // back to the single DD convention via getKeyFieldForResource (the DD does not encode keys
      // through 2.1).
      const dataKeys = fields.filter(f => f.isPrimaryKey).map(f => f.fieldName);
      const keyFields = dataKeys.length > 0 ? dataKeys : [getKeyFieldForResource(resource)];
      return { resource, keyFields, fields };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  const entityTypes = resourceData.map(d => generateEntityType(d.resource, d.keyFields, d.fields, targetResourceSet, enumMode)).join('\n');

  const entitySets = resourceData.map(d => generateEntitySet(d.resource, d.fields, targetResourceSet)).join('\n');

  // Generate enum schema block only in enum-type mode
  const enumSchemaBlock =
    enumMode === 'enum-type'
      ? (() => {
          const enumTypes = collectEnumTypes(metadata, targetResources);
          if (enumTypes.length === 0) return '';
          const enumTypeXml = enumTypes.map(generateEnumTypeXml).join('\n');
          return `\n    <Schema Namespace="org.reso.metadata.enums" xmlns="http://docs.oasis-open.org/odata/ns/edm">\n${enumTypeXml}\n    </Schema>`;
        })()
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
${entityTypes}
      <EntityContainer Name="Default">
${entitySets}
      </EntityContainer>
    </Schema>${enumSchemaBlock}
  </edmx:DataServices>
</edmx:Edmx>`;
};
