import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedSchema, setCachedSchema, clearSchemaCache } from '../src/api/schema-cache';

// CompressionStream/DecompressionStream are not available in jsdom.
// These tests verify the cache gracefully handles missing compression
// (getCachedSchema/setCachedSchema catch errors and return null / no-op).
// Full compression tests require a browser or Node 18+ environment.

describe('schema-cache', () => {
  beforeEach(async () => {
    await clearSchemaCache();
  });

  it('returns null for uncached keys', async () => {
    const result = await getCachedSchema('nonexistent');
    expect(result).toBeNull();
  });

  it('gracefully handles missing CompressionStream', async () => {
    // setCachedSchema should not throw even without compression support
    await expect(setCachedSchema('test', { a: 1 })).resolves.toBeUndefined();
  });

  it('returns null when compression is unavailable', async () => {
    await setCachedSchema('test', { a: 1 });
    const result = await getCachedSchema('test');
    // Without CompressionStream, the data can't be stored/retrieved
    expect(result).toBeNull();
  });
});
