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

/** Parse a Lookup Resource record into a LookupValue. */
const toLookupValue = (r: Record<string, unknown>, fallbackName: string): LookupValue => {
  const standardLookupValue = r.StandardLookupValue != null ? String(r.StandardLookupValue) : undefined;
  const legacyODataValue = r.LegacyODataValue != null ? String(r.LegacyODataValue) : undefined;
  return {
    lookupName: String(r.LookupName ?? fallbackName),
    lookupValue: String(r.LookupValue ?? ''),
    ...(standardLookupValue !== undefined ? { standardLookupValue } : {}),
    ...(legacyODataValue !== undefined ? { legacyODataValue } : {})
  };
};

/** Fetch lookup values for a single LookupName from the Lookup Resource. */
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
  return records.map(r => toLookupValue(r, lookupName));
};

/**
 * Batch-fetch lookup values for multiple LookupNames in a single request
 * using `$filter=LookupName in ('A','B','C')`. Returns a map of LookupName → values.
 */
const fetchBatchFromLookupResource = async (
  lookupNames: ReadonlyArray<string>,
  baseUrl: string,
  token: string | undefined,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  maxPageSize = 1000
): Promise<ReadonlyMap<string, ReadonlyArray<LookupValue>>> => {
  if (lookupNames.length === 0) return new Map();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Prefer: `odata.maxpagesize=${maxPageSize}`,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const nameList = lookupNames.map(n => `'${n}'`).join(',');
  const filter = encodeURIComponent(`LookupName in (${nameList})`);
  const normalizedBase = baseUrl.replace(/\/$/, '');

  // Fetch all pages via @odata.nextLink
  const allRecords: Record<string, unknown>[] = [];
  let nextUrl: string | null = `${normalizedBase}/Lookup?$filter=${filter}&$orderby=LookupName asc,LookupValue asc`;

  while (nextUrl) {
    const fetchUrl = nextUrl.startsWith('http') ? nextUrl : `${normalizedBase}${nextUrl}`;
    const res = await fetchFn(fetchUrl, { headers });
    if (!res.ok) throw new Error(`Failed to batch-fetch Lookup values: ${res.status}`);
    const body = await res.json();
    const records: ReadonlyArray<Record<string, unknown>> = body?.value ?? [];
    allRecords.push(...records);
    nextUrl = body?.['@odata.nextLink'] ?? null;
  }

  // Group by LookupName
  const grouped = new Map<string, LookupValue[]>();
  for (const name of lookupNames) grouped.set(name, []);
  for (const r of allRecords) {
    const name = String(r.LookupName ?? '');
    const bucket = grouped.get(name);
    if (bucket) bucket.push(toLookupValue(r, name));
  }

  return grouped;
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
  const { schema, baseUrl, token, maxPageSize = 1000 } = config;
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

  const resolveLookupsBatch = async (
    lookupNames: ReadonlyArray<string>
  ): Promise<Readonly<Record<string, ReadonlyArray<LookupValue>>>> => {
    if (lookupNames.length === 0) return {};

    const uncachedNames = lookupNames.filter(name => !cache.has(name));

    // Batch-fetch uncached names from the Lookup Resource
    if (uncachedNames.length > 0 && hasLookupResource && baseUrl) {
      try {
        const batchResults = await fetchBatchFromLookupResource(uncachedNames, baseUrl, token, fetchFn, maxPageSize);
        for (const [name, values] of batchResults) {
          if (values.length > 0) cache.set(name, values);
        }
      } catch {
        // Fall through to per-name CSDL enum fallback below
      }
    }

    // Resolve each name — cache hits for batch-fetched, CSDL enum fallback for the rest
    const entries = await Promise.all(
      lookupNames.map(async (name) => {
        const values = await resolveLookups(name);
        return [name, values] as const;
      })
    );

    return Object.fromEntries(entries.filter(([, values]) => values.length > 0));
  };

  const resolveLookupsForResource = async (
    resourceName: string
  ): Promise<Readonly<Record<string, ReadonlyArray<LookupValue>>>> => {
    const entityType = resolveEntityType(resourceName, schema);
    if (!entityType) return {};

    const lookupFields = resolveLookupFields(entityType);
    if (lookupFields.length === 0) return {};

    // Deduplicate lookup names and identify which need fetching vs are cached
    const uniqueNames = [...new Set(lookupFields.map(([, name]) => name))];
    const uncachedNames = uniqueNames.filter(name => !cache.has(name));

    // Batch-fetch all uncached lookups from the Lookup Resource in one request
    if (uncachedNames.length > 0 && hasLookupResource && baseUrl) {
      try {
        const batchResults = await fetchBatchFromLookupResource(uncachedNames, baseUrl, token, fetchFn, maxPageSize);
        for (const [name, values] of batchResults) {
          if (values.length > 0) cache.set(name, values);
        }
      } catch {
        // Fall through to per-name CSDL enum fallback below
      }
    }

    // Resolve each field — hits cache for batch-fetched names, falls back to CSDL enums
    const entries = await Promise.all(
      lookupFields.map(async ([fieldName, lookupName]) => {
        const values = await resolveLookups(lookupName);
        return [fieldName, values] as const;
      })
    );

    return Object.fromEntries(entries.filter(([, values]) => values.length > 0));
  };

  return { hasLookupResource, resolveLookups, resolveLookupsBatch, resolveLookupsForResource };
};
