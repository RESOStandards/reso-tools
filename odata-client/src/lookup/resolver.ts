/**
 * Lookup resolver — unified interface for resolving enumeration values
 * from either CSDL EnumTypes (defined in $metadata XML) or the RESO
 * Lookup Resource (a queryable entity set).
 *
 * Fields connect to lookups through their LookupName annotation
 * (RESO.OData.Metadata.LookupName). When the server has a Lookup entity set,
 * values are lazy-fetched from it. Otherwise, CSDL enum members are used.
 */

import type { CsdlEntityType, CsdlSchema } from '../csdl/types.js';
import type { LookupResolver, LookupResolverConfig, LookupValue } from './types.js';

/** The RESO annotation term that indicates a field uses the Lookup Resource. */
const LOOKUP_NAME_TERM = 'RESO.OData.Metadata.LookupName';

/** Check if a CSDL type is an Edm primitive. */
const isEdmPrimitive = (type: string): boolean => {
  const unwrapped = type.startsWith('Collection(') ? type.slice('Collection('.length, -1) : type;
  return unwrapped.startsWith('Edm.');
};

/** Extract unqualified type name (e.g. "org.reso.metadata.StandardStatus" → "StandardStatus"). */
const extractTypeName = (type: string): string => {
  const unwrapped = type.startsWith('Collection(') ? type.slice('Collection('.length, -1) : type;
  const dotIndex = unwrapped.lastIndexOf('.');
  return dotIndex >= 0 ? unwrapped.slice(dotIndex + 1) : unwrapped;
};

/** Build lookup values from CSDL EnumType members. */
const enumToLookups = (enumName: string, members: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<LookupValue> =>
  members.map(m => ({ lookupName: enumName, lookupValue: m.name }));

/** Fetch lookup values from the Lookup Resource entity set. */
const fetchFromLookupResource = async (
  lookupName: string,
  baseUrl: string,
  token: string | undefined,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>
): Promise<ReadonlyArray<LookupValue>> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const filter = encodeURIComponent(`LookupName eq '${lookupName}'`);
  const url = `${baseUrl.replace(/\/$/, '')}/Lookup?$filter=${filter}&$orderby=LookupValue asc&$top=1000`;

  const res = await fetchFn(url, { headers });
  if (!res.ok) throw new Error(`Failed to fetch Lookup values for ${lookupName}: ${res.status}`);

  const body = await res.json();
  const records: ReadonlyArray<Record<string, unknown>> = body?.value ?? [];

  return records.map(r => {
    const standardLookupValue = r.StandardLookupValue != null ? String(r.StandardLookupValue) : undefined;
    const legacyODataValue = r.LegacyODataValue != null ? String(r.LegacyODataValue) : undefined;
    return {
      lookupName: String(r.LookupName ?? lookupName),
      lookupValue: String(r.LookupValue ?? ''),
      ...(standardLookupValue !== undefined ? { standardLookupValue } : {}),
      ...(legacyODataValue !== undefined ? { legacyODataValue } : {})
    };
  });
};

/**
 * Resolve the entity type for a resource (entity set), walking the
 * inheritance chain to collect all properties.
 */
const resolveEntityType = (
  resourceName: string,
  schema: CsdlSchema
): CsdlEntityType | undefined => {
  if (!schema.entityContainer) return undefined;

  const entitySet = schema.entityContainer.entitySets.find(es => es.name === resourceName);
  if (!entitySet) return undefined;

  const typeName = extractTypeName(entitySet.entityType);
  return schema.entityTypes.find(et => et.name === typeName);
};

/**
 * For each property in an entity type, determine whether it's a lookup field
 * and what its lookup name is. Returns pairs of [fieldName, lookupName].
 */
const resolveLookupFields = (
  entityType: CsdlEntityType
): ReadonlyArray<readonly [string, string]> =>
  entityType.properties
    .map(prop => {
      // Check for RESO LookupName annotation first
      const lookupName = prop.annotations?.[LOOKUP_NAME_TERM];
      if (lookupName) return [prop.name, lookupName] as const;

      // Check for CSDL enum type (non-Edm primitive)
      if (!isEdmPrimitive(prop.type)) {
        const typeName = extractTypeName(prop.type);
        return [prop.name, typeName] as const;
      }

      return null;
    })
    .filter((pair): pair is readonly [string, string] => pair !== null);

/**
 * Create a lookup resolver for a given CSDL schema.
 *
 * The resolver provides a unified `resolveLookups(lookupName)` that fetches
 * from the Lookup Resource when available, falling back to CSDL EnumType
 * members otherwise.
 */
export const createLookupResolver = (config: LookupResolverConfig): LookupResolver => {
  const { schema, baseUrl, token } = config;
  const fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);

  // Pre-index CSDL enum types by name
  const enumMap = new Map(
    schema.enumTypes.map(et => [et.name, et])
  );

  // Detect whether a Lookup entity set exists
  const hasLookupResource = schema.entityContainer?.entitySets.some(es => es.name === 'Lookup') ?? false;

  // Cache for resolved lookups (both Lookup Resource and CSDL enum)
  const cache = new Map<string, ReadonlyArray<LookupValue>>();

  const resolveLookups = async (lookupName: string): Promise<ReadonlyArray<LookupValue>> => {
    const cached = cache.get(lookupName);
    if (cached) return cached;

    let values: ReadonlyArray<LookupValue>;

    // Try Lookup Resource first when available and we have a base URL
    if (hasLookupResource && baseUrl) {
      try {
        values = await fetchFromLookupResource(lookupName, baseUrl, token, fetchFn);
        if (values.length > 0) {
          cache.set(lookupName, values);
          return values;
        }
      } catch {
        // Fall through to CSDL enum fallback
      }
    }

    // Fall back to CSDL enum type
    const enumType = enumMap.get(lookupName);
    values = enumType ? enumToLookups(lookupName, enumType.members) : [];
    cache.set(lookupName, values);
    return values;
  };

  const resolveLookupsForResource = async (
    resourceName: string
  ): Promise<Readonly<Record<string, ReadonlyArray<LookupValue>>>> => {
    const entityType = resolveEntityType(resourceName, schema);
    if (!entityType) return {};

    const lookupFields = resolveLookupFields(entityType);
    if (lookupFields.length === 0) return {};

    const entries = await Promise.all(
      lookupFields.map(async ([fieldName, lookupName]) => {
        const values = await resolveLookups(lookupName);
        return [fieldName, values] as const;
      })
    );

    // Only include fields that have lookup values
    return Object.fromEntries(entries.filter(([, values]) => values.length > 0));
  };

  return { hasLookupResource, resolveLookups, resolveLookupsForResource };
};
