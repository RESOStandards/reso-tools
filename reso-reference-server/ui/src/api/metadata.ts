import type { CsdlSchema } from '@reso/odata-client';
import { buildResourceLookups, entityTypeToFields, schemaToLookups } from './metadata-adapter';
import type { ResoField, ResoLookup } from '../types';

/** Cache for the local server's custom metadata endpoints. */
const fieldsCache = new Map<string, ReadonlyArray<ResoField>>();
const lookupsCache = new Map<string, ReadonlyArray<ResoLookup>>();
const resourceLookupsCache = new Map<string, Readonly<Record<string, ReadonlyArray<ResoLookup>>>>();

/** Cache for external server CSDL-based metadata. Keyed by baseUrl. */
const csdlSchemaCache = new Map<string, CsdlSchema>();
const csdlFieldsCache = new Map<string, ReadonlyArray<ResoField>>();
const csdlLookupsCache = new Map<string, Readonly<Record<string, ReadonlyArray<ResoLookup>>>>();

/** Cache for Lookup Resource values, keyed by LookupName. Shared across all servers. */
const lookupResourceCache = new Map<string, ReadonlyArray<ResoLookup>>();

/** Clear all metadata caches. Called when switching servers. */
export const clearMetadataCache = (): void => {
  fieldsCache.clear();
  lookupsCache.clear();
  resourceLookupsCache.clear();
  csdlSchemaCache.clear();
  csdlFieldsCache.clear();
  csdlLookupsCache.clear();
  lookupResourceCache.clear();
};

/** Check whether a URL points to localhost. */
const isLocalhostUrl = (url: string): boolean => {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname); }
  catch { return false; }
};

/** Resolve a URL for fetching — direct for localhost, proxied for remote. */
const resolveUrl = (url: string): string =>
  isLocalhostUrl(url) ? url : `/api/proxy?url=${encodeURIComponent(url)}`;

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

/** Fetches lookup values for a specific enum type. Only available on local server. */
export const fetchLookupsForType = async (type: string): Promise<ReadonlyArray<ResoLookup>> => {
  const cached = lookupsCache.get(type);
  if (cached) return cached;
  const res = await fetch(`/api/metadata/lookups?type=${encodeURIComponent(type)}`);
  if (!res.ok) throw new Error(`Failed to fetch lookups for ${type}: ${res.statusText}`);
  const lookups: ReadonlyArray<ResoLookup> = await res.json();
  lookupsCache.set(type, lookups);
  return lookups;
};

/**
 * Lazily fetch lookup values from the Lookup Resource for a given LookupName.
 * Fetches from GET /Lookup?$filter=LookupName eq '{name}'&$orderby=LookupValue asc
 * and caches the result by LookupName.
 */
export const fetchLookupResourceValues = async (
  lookupName: string,
  options: { baseUrl: string; token?: string }
): Promise<ReadonlyArray<ResoLookup>> => {
  const cached = lookupResourceCache.get(lookupName);
  if (cached) return cached;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const filter = encodeURIComponent(`LookupName eq '${lookupName}'`);
  const rawUrl = `${options.baseUrl}/Lookup?$filter=${filter}&$orderby=LookupValue asc&$top=1000`;
  const fetchUrl = resolveUrl(rawUrl);
  const needsCacheBust = fetchUrl.startsWith('/api/proxy');
  const res = await fetch(fetchUrl, {
    headers,
    ...(needsCacheBust ? { cache: 'no-store' as const } : {})
  });
  if (!res.ok) throw new Error(`Failed to fetch Lookup values for ${lookupName}: ${res.status}`);

  const body = await res.json();
  const records: ReadonlyArray<Record<string, unknown>> = body?.value ?? [];

  const lookups: ReadonlyArray<ResoLookup> = records.map(r => ({
    lookupName: String(r.LookupName ?? lookupName),
    lookupValue: String(r.LookupValue ?? ''),
    type: lookupName,
    annotations: []
  }));

  lookupResourceCache.set(lookupName, lookups);
  return lookups;
};

/** Fetches all lookup values for all enum fields in a resource. */
export const fetchLookupsForResource = async (
  resource: string,
  options?: { baseUrl?: string; token?: string; hasLookupResource?: boolean }
): Promise<Readonly<Record<string, ReadonlyArray<ResoLookup>>>> => {
  // External server path — derive from CSDL enums + Lookup Resource
  if (options?.baseUrl) {
    const cacheKey = `${options.baseUrl}:${resource}`;
    const cached = csdlLookupsCache.get(cacheKey);
    if (cached) return cached;

    const schema = await fetchCsdlSchema(options.baseUrl, options.token);
    const csdlLookups = schemaToLookups(schema);
    const fields = await fetchFieldsForResource(resource, options);

    // For fields with lookupName (Lookup Resource), lazy-fetch from Lookup entity set
    // For fields with typeName only (CSDL enums), use CSDL-derived lookups
    const lookupResourceFields = fields.filter(f => f.lookupName && options.hasLookupResource);
    const lookupResourceResults = await Promise.all(
      lookupResourceFields.map(async f => {
        const values = await fetchLookupResourceValues(f.lookupName!, { baseUrl: options.baseUrl!, token: options.token });
        return [f.fieldName, values] as const;
      })
    );
    const lookupResourceMap = Object.fromEntries(lookupResourceResults);

    // Merge: Lookup Resource values take precedence over CSDL enum values
    const csdlBasedLookups = buildResourceLookups(fields, csdlLookups);
    const resourceLookups = { ...csdlBasedLookups, ...lookupResourceMap };
    csdlLookupsCache.set(cacheKey, resourceLookups);
    return resourceLookups;
  }

  // Local server path
  const cached = resourceLookupsCache.get(resource);
  if (cached) return cached;
  const res = await fetch(`/api/metadata/lookups-for-resource?resource=${encodeURIComponent(resource)}`);
  if (!res.ok) throw new Error(`Failed to fetch lookups for ${resource}: ${res.statusText}`);
  const lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>> = await res.json();
  resourceLookupsCache.set(resource, lookups);
  return lookups;
};
