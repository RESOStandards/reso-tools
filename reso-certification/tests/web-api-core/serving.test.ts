/**
 * Serving detection — the Core 2.1.0 "declared-but-not-served" carve-out.
 *
 * These are the pure-function invariants behind the masking decision. A FALSE PASS (masking a resource that
 * is actually broken) is worse than a FALSE FAIL, so every path that isn't determinately-absent-on-both-
 * surfaces must resolve to `run`.
 */

import { describe, expect, it } from 'vitest';
import {
  declaredPresence,
  parseServiceDocument,
  resolveServingDecision,
  servedPresence,
} from '../../src/web-api-core/serving.js';
import type { EntityType, ParsedEntitySet } from '../../src/test-runner/types.js';

const entityType = (name: string): EntityType => ({ name, keyProperties: [`${name}Key`], properties: [] });

const goodDoc = (names: ReadonlyArray<string>): Record<string, unknown> => ({
  '@odata.context': 'https://api.example.com/odata/$metadata',
  value: names.map(n => ({ name: n, kind: 'EntitySet', url: n })),
});

// ── parseServiceDocument ──
describe('parseServiceDocument', () => {
  it('accepts a good, complete service document → the served EntitySet names', () => {
    const served = parseServiceDocument(goodDoc(['Property', 'Member', 'Office']));
    expect(served).toBeInstanceOf(Set);
    expect([...(served ?? [])].sort()).toEqual(['Member', 'Office', 'Property']);
  });

  it('rejects a non-object body (string / null / number / array) → undefined', () => {
    for (const bad of ['{}', null, 42, [], undefined]) {
      expect(parseServiceDocument(bad)).toBeUndefined();
    }
  });

  it('rejects a bad @odata.context (missing / non-string / not ending in $metadata) → undefined', () => {
    expect(parseServiceDocument({ value: [{ name: 'Property' }] })).toBeUndefined(); // missing context
    expect(parseServiceDocument({ '@odata.context': 123, value: [{ name: 'Property' }] })).toBeUndefined(); // non-string
    expect(parseServiceDocument({ '@odata.context': 'https://x/odata/Property', value: [{ name: 'Property' }] })).toBeUndefined(); // wrong tail
  });

  it('rejects a non-array value → undefined', () => {
    expect(parseServiceDocument({ '@odata.context': 'https://x/$metadata', value: { name: 'Property' } })).toBeUndefined();
  });

  it('rejects an EMPTY value[] → undefined (an empty doc can never prove a resource absent)', () => {
    expect(parseServiceDocument({ '@odata.context': 'https://x/$metadata', value: [] })).toBeUndefined();
  });

  it('rejects a paged doc carrying @odata.nextLink → undefined (incomplete, can\'t prove absence)', () => {
    expect(parseServiceDocument({
      '@odata.context': 'https://x/$metadata',
      value: [{ name: 'Property' }],
      '@odata.nextLink': 'https://x/$metadata/next',
    })).toBeUndefined();
  });

  it('rejects a non-empty value[] with no usable names → undefined (malformed, not an empty served set)', () => {
    expect(parseServiceDocument({ '@odata.context': 'https://x/$metadata', value: [{ url: 'Property' }, { name: 42 }] })).toBeUndefined();
  });
});

// ── the two surfaces ──
describe('servedPresence (Surface 1 — service document)', () => {
  it('undefined served-set ⇒ indeterminate', () => {
    expect(servedPresence(undefined, 'Property')).toBe('indeterminate');
  });
  it('present when named, absent when not', () => {
    const served = new Set(['Property', 'Member']);
    expect(servedPresence(served, 'Property')).toBe('present');
    expect(servedPresence(served, 'Media')).toBe('absent');
  });
});

describe('declaredPresence (Surface 2 — EntityContainer, resolved through EntityType)', () => {
  const sets: ReadonlyArray<ParsedEntitySet> = [
    { name: 'Properties', entityType: 'Property' }, // set name ≠ type name — membership is by TYPE
    { name: 'Member', entityType: 'Member' },
  ];
  it('undefined / empty entitySets ⇒ indeterminate', () => {
    expect(declaredPresence(undefined, entityType('Property'))).toBe('indeterminate');
    expect(declaredPresence([], entityType('Property'))).toBe('indeterminate');
  });
  it('present when a declared set exposes the resource\'s EntityType (NOT by set name)', () => {
    expect(declaredPresence(sets, entityType('Property'))).toBe('present');
    expect(declaredPresence(sets, entityType('Member'))).toBe('present');
  });
  it('absent when no declared set exposes the resource\'s EntityType', () => {
    expect(declaredPresence(sets, entityType('Media'))).toBe('absent');
  });
});

// ── resolveServingDecision truth table ──
describe('resolveServingDecision', () => {
  const served = (...names: string[]) => new Set(names);
  const sets = (...pairs: Array<[string, string]>): ReadonlyArray<ParsedEntitySet> =>
    pairs.map(([name, type]) => ({ name, entityType: type }));

  const decide = (
    resource: string,
    version: '2.0.0' | '2.1.0',
    servedEntitySets: ReadonlySet<string> | undefined,
    declaredEntitySets: ReadonlyArray<ParsedEntitySet> | undefined,
  ) => resolveServingDecision({ resource, entityType: entityType(resource), version, servedEntitySets, declaredEntitySets });

  it('2.0.0 ALWAYS runs — the carve-out is 2.1.0+ only (even both-absent)', () => {
    expect(decide('Property', '2.0.0', served('Member'), sets(['Member', 'Member']))).toBe('run');
    expect(decide('Media', '2.0.0', served('Member'), sets(['Member', 'Member']))).toBe('run');
  });

  it('a resource we do not recognize always runs (never masked)', () => {
    expect(decide('InternetTracking', '2.1.0', served('Property'), sets(['Property', 'Property']))).toBe('run');
  });

  it('both surfaces determinate + ABSENT → FAIL for a required resource (P/M/O/F/L + EntityEvent)', () => {
    for (const req of ['Property', 'Member', 'Office', 'Field', 'Lookup', 'EntityEvent']) {
      expect(decide(req, '2.1.0', served('Other'), sets(['Other', 'Other']))).toBe('fail');
    }
  });

  it('both surfaces determinate + ABSENT → NA for a non-required well-known resource', () => {
    for (const wk of ['Media', 'OpenHouse', 'Showing']) {
      expect(decide(wk, '2.1.0', served('Property'), sets(['Property', 'Property']))).toBe('na');
    }
  });

  it('surfaces DISAGREE (served present / declared absent) → run (anti-false-PASS)', () => {
    expect(decide('Property', '2.1.0', served('Property'), sets(['Member', 'Member']))).toBe('run');
  });

  it('surfaces DISAGREE (served absent / declared present) → run — the drifted-service-doc 404 case', () => {
    // Declared as an EntitySet but omitted from the service document: stays in the run and fails for real.
    expect(decide('Property', '2.1.0', served('Member'), sets(['Property', 'Property']))).toBe('run');
  });

  it('either surface INDETERMINATE → run', () => {
    expect(decide('Property', '2.1.0', undefined, sets(['Member', 'Member']))).toBe('run'); // served indeterminate
    expect(decide('Property', '2.1.0', served('Member'), undefined)).toBe('run'); // declared indeterminate (no container)
    expect(decide('Property', '2.1.0', served('Member'), [])).toBe('run'); // declared indeterminate (zero sets)
    expect(decide('Property', '2.1.0', undefined, undefined)).toBe('run'); // both indeterminate
  });

  it('both surfaces PRESENT → run (the normal served resource)', () => {
    expect(decide('Property', '2.1.0', served('Property'), sets(['Property', 'Property']))).toBe('run');
  });
});
