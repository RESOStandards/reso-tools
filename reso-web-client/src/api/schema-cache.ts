/**
 * IndexedDB cache for parsed CSDL schemas. Stores compressed JSON to handle
 * large metadata documents (10-20 MB on some servers). Cache entries expire
 * after a configurable TTL (default 24 hours).
 */

/** Default time-to-live for cached schemas (24 hours in milliseconds). */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const DB_NAME = 'reso-schema-cache';
const DB_VERSION = 1;
const STORE_NAME = 'schemas';

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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
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

/**
 * Get a cached schema from IndexedDB. Returns null if not found or expired.
 */
export const getCachedSchema = async <T>(key: string, ttlMs = DEFAULT_TTL_MS): Promise<T | null> => {
  try {
    const db = await openDb();
    const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result as CacheEntry | undefined);
      request.onerror = () => reject(request.error);
    });

    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > ttlMs) {
      // Expired — delete in background
      deleteEntry(key).catch(() => {});
      return null;
    }

    const json = await decompress(entry.data);
    return JSON.parse(json) as T;
  } catch {
    // IndexedDB unavailable or corrupt — fall through to network fetch
    return null;
  }
};

/**
 * Store a schema in IndexedDB with gzip compression.
 */
export const setCachedSchema = async <T>(key: string, schema: T): Promise<void> => {
  try {
    const json = JSON.stringify(schema);
    const compressed = await compress(json);
    const db = await openDb();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const entry: CacheEntry = { key, data: compressed, timestamp: Date.now() };
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail — caching is best-effort
  }
};

/** Delete a single cache entry. */
const deleteEntry = async (key: string): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

/** Clear all cached schemas. */
export const clearSchemaCache = async (): Promise<void> => {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail
  }
};
