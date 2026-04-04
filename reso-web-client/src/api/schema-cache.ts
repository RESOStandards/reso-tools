/**
 * IndexedDB cache for parsed CSDL schemas and lookup values.
 *
 * Schemas: compressed JSON, 24-hour TTL (large metadata documents).
 * Lookups: compressed JSON, 1-hour TTL (per lookup name, keyed by server+name).
 * Expired entries are flushed on access — no auto-refetch.
 */

/** Default TTL for cached schemas (24 hours). */
const SCHEMA_TTL_MS = 24 * 60 * 60 * 1000;

/** Default TTL for cached lookups (1 hour). */
const LOOKUP_TTL_MS = 60 * 60 * 1000;

const DB_NAME = 'reso-cache';
const DB_VERSION = 2;
const SCHEMA_STORE = 'schemas';
const LOOKUP_STORE = 'lookups';

/** Shape of a cached entry in IndexedDB. */
interface CacheEntry {
  readonly key: string;
  readonly data: ArrayBuffer;
  readonly timestamp: number;
}

/** Open (or create) the IndexedDB database. */
const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SCHEMA_STORE)) {
        db.createObjectStore(SCHEMA_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(LOOKUP_STORE)) {
        db.createObjectStore(LOOKUP_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Compress a string using gzip via the Compression Streams API. */
const compress = async (text: string): Promise<ArrayBuffer> => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
};

/** Decompress gzipped data back to a string. */
const decompress = async (data: ArrayBuffer): Promise<string> => {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
};

// ── Generic IndexedDB operations ──

/** Get a cached entry from a store. Returns null if not found or expired. */
const getEntry = async <T>(storeName: string, key: string, ttlMs: number): Promise<T | null> => {
  try {
    const db = await openDb();
    const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result as CacheEntry | undefined);
      request.onerror = () => reject(request.error);
    });

    if (!entry) return null;

    if (Date.now() - entry.timestamp > ttlMs) {
      deleteEntry(storeName, key).catch(() => {});
      return null;
    }

    const json = await decompress(entry.data);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};

/** Store a compressed entry in a store. */
const setEntry = async <T>(storeName: string, key: string, value: T): Promise<void> => {
  try {
    const json = JSON.stringify(value);
    const compressed = await compress(json);
    const db = await openDb();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const entry: CacheEntry = { key, data: compressed, timestamp: Date.now() };
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Best-effort
  }
};

/** Delete a single entry from a store. */
const deleteEntry = async (storeName: string, key: string): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

/** Clear all entries in a store. */
const clearStore = async (storeName: string): Promise<void> => {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail
  }
};

// ── Schema cache (24-hour TTL) ──

export const getCachedSchema = async <T>(key: string, ttlMs = SCHEMA_TTL_MS): Promise<T | null> =>
  getEntry<T>(SCHEMA_STORE, key, ttlMs);

export const setCachedSchema = async <T>(key: string, schema: T): Promise<void> =>
  setEntry(SCHEMA_STORE, key, schema);

export const clearSchemaCache = async (): Promise<void> =>
  clearStore(SCHEMA_STORE);

/** Get the timestamp of when a schema was cached. Returns null if not found. */
export const getSchemaTimestamp = async (key: string): Promise<number | null> => {
  try {
    const db = await openDb();
    const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(SCHEMA_STORE, 'readonly');
      const store = tx.objectStore(SCHEMA_STORE);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result as CacheEntry | undefined);
      request.onerror = () => reject(request.error);
    });
    return entry?.timestamp ?? null;
  } catch {
    return null;
  }
};

// ── Lookup cache (1-hour TTL, keyed by "serverBaseUrl:lookupName") ──

/** Build a cache key for a lookup: "baseUrl:lookupName". */
const lookupCacheKey = (baseUrl: string, lookupName: string): string =>
  `${baseUrl}:${lookupName}`;

export const getCachedLookup = async <T>(baseUrl: string, lookupName: string, ttlMs = LOOKUP_TTL_MS): Promise<T | null> =>
  getEntry<T>(LOOKUP_STORE, lookupCacheKey(baseUrl, lookupName), ttlMs);

export const setCachedLookup = async <T>(baseUrl: string, lookupName: string, values: T): Promise<void> =>
  setEntry(LOOKUP_STORE, lookupCacheKey(baseUrl, lookupName), values);

export const clearLookupCache = async (): Promise<void> =>
  clearStore(LOOKUP_STORE);

// ── Clear all caches ──

export const clearAllCaches = async (): Promise<void> => {
  await Promise.all([clearSchemaCache(), clearLookupCache()]);
};
