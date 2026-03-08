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

/** Clear all metadata caches. Called when switching servers. */
export const clearMetadataCache = (): void => {
  fieldsCache.clear();
  lookupsCache.clear();
  resourceLookupsCache.clear();
};

/** Fetch and cache the CSDL schema for an external server. */
const fetchCsdlSchema = async (baseUrl: string, token?: string): Promise<CsdlSchema> => {
  const cached = csdlSchemaCache.get(baseUrl);
  if (cached) return cached;

  const { parseCsdlXml } = await import('@reso/odata-client');

  const headers: Record<string, string> = { Accept: 'application/xml' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const metadataUrl = `${baseUrl}/$metadata?$format=application/xml`;
  const isLocalhost = (() => {
    try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(metadataUrl).hostname); }
    catch { return false; }
  })();
  const fetchUrl = isLocalhost ? metadataUrl : `/api/proxy?url=${encodeURIComponent(metadataUrl)}`;
  const res = await fetch(fetchUrl, { headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch $metadata: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const schema = parseCsdlXml(xml);
  csdlSchemaCache.set(baseUrl, schema);
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

/** Fetches all lookup values for all enum fields in a resource. */
export const fetchLookupsForResource = async (
  resource: string,
  options?: { baseUrl?: string; token?: string }
): Promise<Readonly<Record<string, ReadonlyArray<ResoLookup>>>> => {
  // External server path — derive from CSDL
  if (options?.baseUrl) {
    const cacheKey = `${options.baseUrl}:${resource}`;
    const cached = csdlLookupsCache.get(cacheKey);
    if (cached) return cached;

    const schema = await fetchCsdlSchema(options.baseUrl, options.token);
    const allLookups = schemaToLookups(schema);
    const fields = await fetchFieldsForResource(resource, options);
    const resourceLookups = buildResourceLookups(fields, allLookups);
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
