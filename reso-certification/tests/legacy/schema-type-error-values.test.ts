import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { updateCacheAndStats } = require(resolve(import.meta.dirname, '../../src/legacy/lib/schema/utils.js'));

/**
 * A type-mismatch finding records the field and a count but never the offending VALUE, so a report can say
 * "56 strings in CeilingHeight" and leave an operator unable to act on it: `""`, `"8.5"` and `"N/A"` are three
 * different conversations with a provider. The value was computed to build the message
 * (`MUST be number or null but found string`) and then discarded.
 *
 * The enum classes already record provider values — a `City` finding lists `Indianapolis` and 144 others — and
 * the report already carries record keys, so recording the offending string is consistent with what is there.
 *
 * `failedTypeValue` is a dedicated channel rather than a reuse of `failedItemValue`, because other keywords
 * deliberately blank that field (`additional-properties` sets it to `''`) and must not start recording values.
 */

interface FieldNode {
  readonly values?: Record<string, { readonly count: number }>;
  readonly valuesOmitted?: number;
  readonly lookups?: Record<string, { readonly count: number }>;
}
type Cache = Record<string, { resources: Record<string, { fields: Record<string, FieldNode>; count: number }> }>;

const TYPE_MSG = 'MUST be number or null but found string';

/** One finding as `validate.js` hands it over. `failedEnum` is absent, which is what makes it a type error. */
const record = (cache: Cache, failedTypeValue: unknown, field = 'CeilingHeight') =>
  updateCacheAndStats({
    cache,
    resourceName: 'Property',
    failedItemName: field,
    message: TYPE_MSG,
    fileName: 'page-1',
    stats: { totalErrors: 0, totalWarnings: 0 },
    isWarning: false,
    failedTypeValue
  });

const fieldOf = (cache: Cache, field = 'CeilingHeight'): FieldNode => cache[TYPE_MSG]?.resources?.Property?.fields?.[field] ?? {};

describe('a type-mismatch finding records the offending value', () => {
  it('records the value with a count', () => {
    const cache: Cache = {};
    record(cache, '8.5');
    expect(fieldOf(cache).values).toEqual({ '8.5': { count: 1 } });
  });

  it('tallies repeats of the same value rather than listing it twice', () => {
    const cache: Cache = {};
    record(cache, '8.5');
    record(cache, '8.5');
    record(cache, '9');
    expect(fieldOf(cache).values).toEqual({ '8.5': { count: 2 }, '9': { count: 1 } });
  });

  it('records the EMPTY STRING, which is the single most likely offender', () => {
    // A provider serving "" for an absent number is the classic case, and `if (!value)` would drop it.
    const cache: Cache = {};
    record(cache, '');
    expect(fieldOf(cache).values).toEqual({ '': { count: 1 } });
  });

  it('records a non-primitive as its type name rather than "[object Object]"', () => {
    const cache: Cache = {};
    record(cache, { a: 1 });
    record(cache, [1, 2]);
    expect(Object.keys(fieldOf(cache).values ?? {}).sort()).toEqual(['(array)', '(object)']);
  });

  it('keeps each field’s values separate', () => {
    const cache: Cache = {};
    record(cache, '8.5', 'CeilingHeight');
    record(cache, 'N/A', 'MaximumContiguousSquareFeet');
    expect(fieldOf(cache, 'CeilingHeight').values).toEqual({ '8.5': { count: 1 } });
    expect(fieldOf(cache, 'MaximumContiguousSquareFeet').values).toEqual({ 'N/A': { count: 1 } });
  });

  describe('the distinct-value list is bounded', () => {
    // An enum field's values come from a picklist and stay small. A type error can be on free text, so the
    // distinct set is unbounded and an uncapped tally could put hundreds of thousands of strings in a report.
    it('stops recording new values past the cap and counts what it omitted', () => {
      const cache: Cache = {};
      for (let i = 0; i < 40; i++) record(cache, `v${i}`);
      const node = fieldOf(cache);
      expect(Object.keys(node.values ?? {})).toHaveLength(25);
      expect(node.valuesOmitted).toBe(15);
    });

    it('still tallies a value it has already seen after the cap is reached', () => {
      const cache: Cache = {};
      for (let i = 0; i < 40; i++) record(cache, `v${i}`);
      record(cache, 'v0');
      expect(fieldOf(cache).values?.v0).toEqual({ count: 2 });
      expect(fieldOf(cache).valuesOmitted).toBe(15);
    });
  });

  it('does not record values for a finding that carries no type value', () => {
    // The enum path records through `failedEnum`, and `additional-properties` deliberately carries no value.
    // Neither should grow a `values` node.
    const cache: Cache = {};
    updateCacheAndStats({
      cache,
      resourceName: 'Property',
      failedItemName: 'SomeField',
      message: 'Fields MUST be advertised in the metadata',
      fileName: 'page-1',
      stats: { totalErrors: 0, totalWarnings: 0 },
      isWarning: false
    });
    const node = (cache['Fields MUST be advertised in the metadata']?.resources?.Property?.fields?.SomeField ?? {}) as FieldNode;
    expect(node).not.toHaveProperty('values');
    expect(node).not.toHaveProperty('valuesOmitted');
  });
});
