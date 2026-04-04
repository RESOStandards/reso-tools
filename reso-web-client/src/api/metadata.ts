import type { CsdlSchema, LookupResolver, LookupValue } from '@reso-standards/reso-client';
import { entityTypeToFields } from './metadata-adapter';
import { getCachedSchema, setCachedSchema, getCachedLookup, setCachedLookup } from './schema-cache';
import type { ResoField, ResoLookup } from '../types';

/** Cache for the local server's custom metadata endpoints. */
const fieldsCache = new Map<string, ReadonlyArray<ResoField>>();
const resourceLookupsCache = new Map<string, Readonly<Record<string, ReadonlyArray<ResoLookup>>>>();

/** Cache for external server CSDL-based metadata. Keyed by baseUrl. */
const csdlSchemaCache = new Map<string, CsdlSchema>();
const csdlFieldsCache = new Map<string, ReadonlyArray<ResoField>>();

/** Cache for lookup resolvers, keyed by baseUrl. */
const lookupResolverCache = new Map<string, LookupResolver>();

/** Clear in-memory metadata caches. Called when switching servers. */
export const clearMetadataCache = (): void => {
  fieldsCache.clear();
  resourceLookupsCache.clear();
  csdlSchemaCache.clear();
  csdlFieldsCache.clear();
  lookupResolverCache.clear();
};

/** Check whether a URL points to localhost. */
const isLocalhostUrl = (url: string): boolean => {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname); }
  catch { return false; }
};

/** Resolve a URL for fetching — direct for localhost, proxied for remote. */
const resolveUrl = (url: string): string =>
  isLocalhostUrl(url) ? url : `/api/proxy?url=${encodeURIComponent(url)}`;

/**
 * Create a fetch function that routes through the proxy for remote servers.
 * Passed to createLookupResolver so it can fetch from the Lookup Resource.
 */
const createProxiedFetch = (): ((url: string, init?: RequestInit) => Promise<Response>) =>
  (url: string, init?: RequestInit) => {
    const fetchUrl = resolveUrl(url);
    const needsCacheBust = fetchUrl.startsWith('/api/proxy');
    return fetch(fetchUrl, {
      ...init,
      ...(needsCacheBust ? { cache: 'no-store' as const } : {})
    });
  };

/** Fetch and cache the CSDL schema for a server. Checks IndexedDB first, then network. */
const fetchCsdlSchema = async (baseUrl: string, token?: string): Promise<CsdlSchema> => {
  const cacheKey = baseUrl || '__local__';

  // 1. In-memory cache (instant)
  const memCached = csdlSchemaCache.get(cacheKey);
  if (memCached) return memCached;

  // 2. IndexedDB cache (fast, persists across sessions)
  const dbCached = await getCachedSchema<CsdlSchema>(cacheKey);
  if (dbCached) {
    csdlSchemaCache.set(cacheKey, dbCached);
    return dbCached;
  }

  // 3. Network fetch
  const { parseCsdlXml } = await import('@reso-standards/reso-client');

  const headers: Record<string, string> = { Accept: 'application/xml' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const rawUrl = baseUrl
    ? `${baseUrl}/$metadata?$format=application/xml`
    : '/$metadata?$format=application/xml';
  const fetchUrl = baseUrl ? resolveUrl(rawUrl) : rawUrl;
  const needsCacheBust = fetchUrl.startsWith('/api/proxy');
  const res = await fetch(fetchUrl, {
    headers,
    ...(needsCacheBust ? { cache: 'no-store' as const } : {})
  });
  if (!res.ok) throw new Error(`Failed to fetch $metadata: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const schema = parseCsdlXml(xml);

  // Store in both caches
  csdlSchemaCache.set(cacheKey, schema);
  setCachedSchema(cacheKey, schema).catch(() => {}); // Best-effort persist

  return schema;
};

/**
 * Force-refresh the CSDL schema from the network, bypassing all caches.
 * Only replaces the cached schema if the fetch succeeds and parses (stale-while-revalidate).
 * Returns the fresh schema on success, or throws on failure (existing cache is preserved).
 */
export const refreshSchema = async (baseUrl: string, token?: string): Promise<CsdlSchema> => {
  const { parseCsdlXml } = await import('@reso-standards/reso-client');
  const cacheKey = baseUrl || '__local__';

  const headers: Record<string, string> = { Accept: 'application/xml' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const rawUrl = baseUrl
    ? `${baseUrl}/$metadata?$format=application/xml`
    : '/$metadata?$format=application/xml';
  const fetchUrl = baseUrl ? resolveUrl(rawUrl) : rawUrl;
  const res = await fetch(fetchUrl, { headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch $metadata: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const schema = parseCsdlXml(xml);

  // Success — replace both caches
  csdlSchemaCache.set(cacheKey, schema);
  csdlFieldsCache.clear(); // Clear derived field caches so they rebuild from new schema
  lookupResolverCache.delete(baseUrl); // Resolver may reference old schema
  setCachedSchema(cacheKey, schema).catch(() => {});

  return schema;
};

/** Get or create a LookupResolver for an external server. */
const getResolver = async (baseUrl: string, token?: string): Promise<LookupResolver> => {
  const cached = lookupResolverCache.get(baseUrl);
  if (cached) return cached;

  const { createLookupResolver } = await import('@reso-standards/reso-client');
  const schema = await fetchCsdlSchema(baseUrl, token);
  const resolver = createLookupResolver({
    schema,
    baseUrl,
    token,
    fetchFn: createProxiedFetch()
  });
  lookupResolverCache.set(baseUrl, resolver);
  return resolver;
};

/** Convert LookupValue (reso-client) to ResoLookup (UI type). */
const toLookup = (lv: LookupValue): ResoLookup => ({
  lookupName: lv.lookupName,
  lookupValue: lv.lookupValue,
  type: lv.lookupName,
  annotations: [],
  ...(lv.standardLookupValue !== undefined ? { standardLookupValue: lv.standardLookupValue } : {}),
  ...(lv.legacyODataValue !== undefined ? { legacyODataValue: lv.legacyODataValue } : {})
});

/** Fetches field definitions for a resource. Uses local endpoints or CSDL parsing. */
export const fetchFieldsForResource = async (
  resource: string,
  options?: { baseUrl?: string; token?: string }
): Promise<ReadonlyArray<ResoField>> => {
  // External server path — use CSDL
  if (options?.baseUrl) {
    const cacheKey = `${options.baseUrl}:${resource}`;
    const cached = csdlFieldsCache.get(cacheKey);
    if (cached) return cached;

    const schema = await fetchCsdlSchema(options.baseUrl, options.token);
    if (!schema.entityContainer) throw new Error('No EntityContainer in metadata');

    const entitySet = schema.entityContainer.entitySets.find(es => es.name === resource);
    if (!entitySet) throw new Error(`Resource "${resource}" not found in metadata`);

    const typeName = entitySet.entityType.includes('.')
      ? entitySet.entityType.split('.').pop()!
      : entitySet.entityType;
    const entityType = schema.entityTypes.find(et => et.name === typeName);
    if (!entityType) throw new Error(`Entity type "${typeName}" not found in metadata`);

    const fields = entityTypeToFields(entityType, resource, schema);
    csdlFieldsCache.set(cacheKey, fields);
    return fields;
  }

  // Local server path — custom /api/metadata endpoints
  const cached = fieldsCache.get(resource);
  if (cached) return cached;
  const res = await fetch(`/api/metadata/fields?resource=${encodeURIComponent(resource)}`);
  if (!res.ok) throw new Error(`Failed to fetch fields for ${resource}: ${res.statusText}`);
  const fields: ReadonlyArray<ResoField> = await res.json();
  fieldsCache.set(resource, fields);
  return fields;
};

/** Deduplicate lookup values by lookupValue. */
const deduplicateLookups = (values: ReadonlyArray<LookupValue>): ReadonlyArray<LookupValue> => {
  const seen = new Set<string>();
  return values.filter(v => {
    if (seen.has(v.lookupValue)) return false;
    seen.add(v.lookupValue);
    return true;
  });
};

/**
 * Fetch lookup values for specific lookup names. Returns a map of lookupName → values.
 * Checks IndexedDB cache first (1-hour TTL), then batch-fetches uncached names
 * using a single `$filter=LookupName in (...)` request.
 */
export const fetchLookupsByName = async (
  lookupNames: ReadonlyArray<string>,
  options?: { baseUrl?: string; token?: string }
): Promise<Readonly<Record<string, ReadonlyArray<ResoLookup>>>> => {
  if (lookupNames.length === 0) return {};

  const baseUrl = options?.baseUrl || window.location.origin;
  const result: Record<string, ReadonlyArray<ResoLookup>> = {};

  // Check IndexedDB cache for each name
  const uncached: string[] = [];
  await Promise.all(
    lookupNames.map(async (name) => {
      const cached = await getCachedLookup<ReadonlyArray<ResoLookup>>(baseUrl, name);
      if (cached) {
        result[name] = cached;
      } else {
        uncached.push(name);
      }
    })
  );

  // Batch-fetch all uncached names in one request
  if (uncached.length > 0) {
    const resolver = await getResolver(baseUrl, options?.token);
    const batchResult = await resolver.resolveLookupsBatch(uncached);
    for (const [name, values] of Object.entries(batchResult)) {
      const unique = deduplicateLookups(values);
      const converted = unique.map(toLookup);
      // Persist to IndexedDB for future sessions
      setCachedLookup(baseUrl, name, converted).catch(() => {});
      if (converted.length > 0) result[name] = converted;
    }
  }

  return result;
};

/**
 * Fetches all lookup values for all enum/lookup fields in a resource.
 * Always returns lookups keyed by **field name**.
 */
export const fetchLookupsForResource = async (
  resource: string,
  options?: { baseUrl?: string; token?: string }
): Promise<Readonly<Record<string, ReadonlyArray<ResoLookup>>>> => {
  // External server path — use the reso-client lookup resolver
  if (options?.baseUrl) {
    const resolver = await getResolver(options.baseUrl, options.token);
    const result = await resolver.resolveLookupsForResource(resource);

    // Convert LookupValue → ResoLookup
    return Object.fromEntries(
      Object.entries(result).map(([fieldName, values]) => [
        fieldName,
        values.map(toLookup)
      ])
    );
  }

  // Local server path — use the resolver with the current origin as baseUrl.
  // The Vite proxy forwards /Lookup requests to the backend.
  const localBaseUrl = window.location.origin;
  const resolver = await getResolver(localBaseUrl);
  const result = await resolver.resolveLookupsForResource(resource);

  const converted = Object.fromEntries(
    Object.entries(result).map(([fieldName, values]) => [
      fieldName,
      values.map(toLookup)
    ])
  );

  resourceLookupsCache.set(resource, converted);
  return converted;
};
