/**
 * Metadata loading, parsing, and validation — delegates XML parsing to
 * @reso-standards/reso-metadata-utils's CSDL parser and type validation to @reso-standards/validation.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchRawMetadata, fetchRawMetadataWithVersion, parseCsdlXml } from '@reso-standards/reso-metadata-utils';

// MetadataFetchError now lives in @reso-standards/reso-metadata-utils (reso-tools #221, Stage 3);
// cert callers import it from there directly — no pass-through re-export here.
import type { CsdlEntityType, CsdlProperty, CsdlSchema } from '@reso-standards/reso-metadata-utils';
import { type ResoField, type ValidationFailure, validateRecord } from '@reso-standards/reso-validation';
import type { EntityProperty, EntityType, ParsedEntitySet, ParsedMetadata } from './types.js';

// ── Type adapters (CsdlEntityType → EntityType) ──

/** Convert a CsdlProperty to the test tool's EntityProperty. */
const adaptProperty = (prop: CsdlProperty): EntityProperty => ({
  name: prop.name,
  type: prop.type,
  ...(prop.nullable !== undefined && { nullable: prop.nullable }),
  ...(prop.maxLength !== undefined && { maxLength: prop.maxLength }),
  ...(prop.precision !== undefined && { precision: prop.precision }),
  ...(prop.scale !== undefined && { scale: prop.scale }),
  ...(prop.annotations !== undefined && { annotations: prop.annotations })
});

/** Convert a CsdlEntityType to the test tool's EntityType. */
const adaptEntityType = (et: CsdlEntityType): EntityType => ({
  name: et.name,
  keyProperties: [...et.key],
  properties: et.properties.map(adaptProperty),
  // Preserve the CSDL navigation properties (also previously dropped) so the Web API Core sampler can pick an
  // expansion for the 2.1.0 $expand scenario. `targetType` is the unqualified target entity type name. Omitted
  // when the entity type declares no navigation properties — the scenario then has nothing to expand and skips.
  ...(et.navigationProperties &&
    et.navigationProperties.length > 0 && {
      navigationProperties: et.navigationProperties.map(np => ({
        name: np.name,
        isCollection: np.isCollection,
        targetType: np.entityTypeName
      }))
    })
});

/** The unqualified type name from a (possibly namespaced) CSDL type reference — `org.reso.metadata.Property`
 *  → `Property`. An EntitySet's EntityType is never a Collection(), so a plain last-segment split suffices. */
const unqualifiedTypeName = (fqType: string): string => fqType.split('.').pop() ?? fqType;

/** Convert an EntityContainer's EntitySets to the test tool's ParsedEntitySet[] (name → underlying type). */
const adaptEntitySet = (es: { readonly name: string; readonly entityType: string }): ParsedEntitySet => ({
  name: es.name,
  entityType: unqualifiedTypeName(es.entityType)
});

/** Convert a CsdlSchema to the test tool's ParsedMetadata. */
const adaptSchema = (schema: CsdlSchema): ParsedMetadata => ({
  namespace: schema.namespace,
  entityTypes: schema.entityTypes.map(adaptEntityType),
  // Preserve the CSDL enum types (they carry IsFlags + members) so the enum abstraction can classify a
  // field by its real representation. Previously dropped here, which forced Core's name-shape heuristic.
  enumTypes: schema.enumTypes,
  // Preserve the EntityContainer's EntitySet declarations (also previously dropped) so the serving
  // detection can resolve top-level membership through each set's EntityType. Absent container ⇒ undefined
  // (INDETERMINATE); a container with zero sets stays an empty array (likewise INDETERMINATE downstream).
  ...(schema.entityContainer && { entitySets: schema.entityContainer.entitySets.map(adaptEntitySet) })
});

/**
 * Converts an EntityProperty to a ResoField for use with @reso-standards/validation.
 * Handles Collection() type syntax by extracting the inner type and setting isCollection.
 */
const toResoField = (prop: EntityProperty, resourceName: string): ResoField => {
  const isCollection = prop.type.startsWith('Collection(');
  const type = isCollection ? prop.type.slice(11, -1) : prop.type;

  return {
    resourceName,
    fieldName: prop.name,
    type,
    nullable: prop.nullable,
    isCollection: isCollection || undefined,
    maxLength: prop.maxLength,
    precision: prop.precision,
    scale: prop.scale,
    annotations: prop.annotations ? Object.entries(prop.annotations).map(([term, value]) => ({ term, value })) : []
  };
};

/** Converts an EntityType's properties to ResoField[] for validation. */
export const toResoFields = (entityType: EntityType): ReadonlyArray<ResoField> =>
  entityType.properties.map(p => toResoField(p, entityType.name));

// ── Public API ──

/**
 * Fetches OData XML metadata from a server's `/$metadata` endpoint.
 * Requires a bearer token for authorization.
 * Returns the raw XML string.
 */
export const fetchMetadata = async (serverUrl: string, authToken: string, useFormatParam = true): Promise<string> =>
  fetchRawMetadata(serverUrl.replace(/\/$/, ''), authToken, { useFormatParam });

/** Fetches metadata and detects the server's OData version. */
export const fetchMetadataWithVersion = async (serverUrl: string, authToken: string, useFormatParam = true): Promise<{ xml: string; odataVersion: string | undefined }> =>
  fetchRawMetadataWithVersion(serverUrl.replace(/\/$/, ''), authToken, { useFormatParam });

/** Reads OData XML metadata from a local file. */
export const loadMetadataFromFile = async (filePath: string): Promise<string> => readFile(filePath, 'utf-8');

/**
 * Persist raw EDMX metadata XML to `metadata.xml` in the given output
 * directory. Returns the absolute path. Used by every compliance
 * pipeline's fetch-metadata step so CLI users can find the metadata
 * alongside the report files, and the desktop client's UI can wire its
 * "Download Metadata XML" button to `job.reports.metadataXml`
 * (filename mapped in `reso-desktop-client/src/main.ts`).
 */
export const persistMetadataXml = async (outputPath: string, xml: string): Promise<string> => {
  const path = join(outputPath, 'metadata.xml');
  await writeFile(path, xml);
  return path;
};

/**
 * Parses an OData EDMX XML metadata document into a structured representation.
 * Delegates to @reso-standards/reso-client's parseCsdlXml and adapts the types.
 */
export const parseMetadataXml = (xml: string): ParsedMetadata => {
  const schema = parseCsdlXml(xml);
  return adaptSchema(schema);
};

/** Finds an entity type by name in parsed metadata. Returns undefined if not found. */
export const getEntityType = (metadata: ParsedMetadata, resourceName: string): EntityType | undefined =>
  metadata.entityTypes.find(et => et.name === resourceName);

/**
 * Validates a payload against the entity type's metadata using @reso-standards/validation.
 *
 * Performs two levels of validation:
 * 1. Unknown field detection (fields not in metadata)
 * 2. Type/value validation via @reso-standards/validation (type mismatches, negative numerics,
 *    MaxLength, integer enforcement, collection/enum checks)
 *
 * Keys prefixed with `@` (OData annotations) are ignored.
 */
export const validatePayloadAgainstMetadata = (
  payload: Record<string, unknown>,
  entityType: EntityType
): {
  readonly valid: boolean;
  readonly unknownFields: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<ValidationFailure>;
} => {
  const resoFields = toResoFields(entityType);
  const failures = validateRecord(payload, resoFields);
  const unknownFields = failures.filter(f => f.reason.includes('not a recognized field')).map(f => f.field);

  return {
    valid: failures.length === 0,
    unknownFields,
    failures
  };
};
