import type { CsdlSchema, LookupResolver, LookupValue } from '@reso/odata-client';
import { entityTypeToFields } from './metadata-adapter';
import type { ResoField, ResoLookup } from '../types';
import { isEnumType } from '../types';

/** Cache for the local server's custom metadata endpoints. */
const fieldsCache = new Map<string, ReadonlyArray<ResoField>>();
const resourceLookupsCache = new Map<string, Readonly<Record<string, ReadonlyArray<ResoLookup>>>>();

/** Cache for external server CSDL-based metadata. Keyed by baseUrl. */
const csdlSchemaCache = new Map<string, CsdlSchema>();
const csdlFieldsCache = new Map<string, ReadonlyArray<ResoField>>();

/** Cache for lookup resolvers, keyed by baseUrl. */
const lookupResolverCache = new Map<string, LookupResolver>();

/** Clear all metadata caches. Called when switching servers. */
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

/** Fetch and cache the CSDL schema for a server. */
const fetchCsdlSchema = async (baseUrl: string, token?: string): Promise<CsdlSchema> => {
  const cacheKey = baseUrl || '__local__';
  const cached = csdlSchemaCache.get(cacheKey);
  if (cached) return cached;

  const { parseCsdlXml } = await import('@reso/odata-client');

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
  csdlSchemaCache.set(cacheKey, schema);
  return schema;
};

/** Get or create a LookupResolver for an external server. */
const getResolver = async (baseUrl: string, token?: string): Promise<LookupResolver> => {
  const cached = lookupResolverCache.get(baseUrl);
  if (cached) return cached;

  const { createLookupResolver } = await import('@reso/odata-client');
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

/** Convert LookupValue (odata-client) to ResoLookup (UI type). */
const toLookup = (lv: LookupValue): ResoLookup => ({
  lookupName: lv.lookupName,
  lookupValue: lv.lookupValue,
  type: lv.lookupName,
  annotations: []
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

/**
 * Fetches all lookup values for all enum/lookup fields in a resource.
 * Always returns lookups keyed by **field name**.
 */
export const fetchLookupsForResource = async (
  resource: string,
  options?: { baseUrl?: string; token?: string }
): Promise<Readonly<Record<string, ReadonlyArray<ResoLookup>>>> => {
  // External server path — use the odata-client lookup resolver
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

  // Local server path — remap from type-keyed to fieldName-keyed
  const cached = resourceLookupsCache.get(resource);
  if (cached) return cached;

  const [fieldsResult, lookupsRes] = await Promise.all([
    fetchFieldsForResource(resource),
    fetch(`/api/metadata/lookups-for-resource?resource=${encodeURIComponent(resource)}`)
  ]);

  if (!lookupsRes.ok) throw new Error(`Failed to fetch lookups for ${resource}: ${lookupsRes.statusText}`);
  const typeKeyedLookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>> = await lookupsRes.json();

  // Remap: for each enum field, map fieldName → lookups[field.type]
  const fieldNameKeyed = Object.fromEntries(
    fieldsResult
      .filter(f => isEnumType(f.type) && typeKeyedLookups[f.type])
      .map(f => [f.fieldName, typeKeyedLookups[f.type]])
  );

  resourceLookupsCache.set(resource, fieldNameKeyed);
  return fieldNameKeyed;
};
