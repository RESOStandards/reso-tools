import { describe, expect, it } from 'vitest';
import { resilienceKey } from '../src/http/client.js';

/**
 * The governor/breaker key must identify a RESOURCE, not just a host — otherwise a
 * path-prefixed service root collapses every resource onto one key and a burst on one
 * resource paces/trips the breaker for all of them (the bug the #273 review surfaced).
 */
describe('resilienceKey', () => {
  it('keys per full resource path, so a path-prefixed root keeps resources distinct', () => {
    const property = resilienceKey('https://host/odata/Property?$top=1');
    const member = resilienceKey('https://host/odata/Member?$top=1');
    expect(property).toBe('host|/odata/Property');
    expect(member).toBe('host|/odata/Member');
    expect(property).not.toBe(member); // before the fix both were `host|odata`
  });

  it('folds a key predicate onto its collection (they are the same resource)', () => {
    expect(resilienceKey("https://host/odata/Property('123')")).toBe('host|/odata/Property');
    expect(resilienceKey('https://host/odata/Property')).toBe('host|/odata/Property');
  });

  it('keeps a navigation segment distinct — it strips only the key predicate, not the tail', () => {
    expect(resilienceKey("https://host/odata/Property('1')/Media")).toBe('host|/odata/Property/Media');
    expect(resilienceKey("https://host/odata/Property('1')/Media")).not.toBe('host|/odata/Property');
  });

  it('keeps resources distinct at a bare service root as well', () => {
    expect(resilienceKey('https://host/Property')).toBe('host|/Property');
    expect(resilienceKey('https://host/Member')).toBe('host|/Member');
  });

  it('falls back to the raw string when the url will not parse', () => {
    expect(resilienceKey('not a url')).toBe('not a url');
  });
});
