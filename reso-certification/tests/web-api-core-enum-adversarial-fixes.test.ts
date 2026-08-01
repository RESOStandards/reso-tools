import { describe, expect, it } from 'vitest';
import { decodeFlagsValue } from '@reso-standards/reso-metadata-utils';
import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import { assertCollectionLambda, assertEnumMatch } from '../src/web-api-core/assertions.js';
import { buildScenarioQuery } from '../src/web-api-core/queries.js';
import type { TestParams } from '../src/web-api-core/sampling.js';
import type { CoreScenario } from '../src/web-api-core/scenarios.js';

// Regression tests for the step-3c adversarial findings.

describe('#6/#9 — `has` across multiple values is AND, not OR', () => {
  it('requires EVERY requested flag present', () => {
    expect(assertCollectionLambda([{ f: ['Active', 'Pending'] }], 'f', 'has', ['Active', 'Pending']).passed).toBe(true);
    // A record with only one of the two must fail (was a false-pass under the old `.some`).
    expect(assertCollectionLambda([{ f: ['Active'] }], 'f', 'has', ['Active', 'Pending']).passed).toBe(false);
  });
});

describe('#5/#10 — `all()` is subset containment (record ⊆ values), the inverted-set bug', () => {
  it('passes when every element is within the requested values', () => {
    // The reversed quantifier would FALSE-FAIL this (it checked B ∈ [A], which is false).
    expect(assertCollectionLambda([{ f: ['A'] }], 'f', 'all', ['A', 'B']).passed).toBe(true);
  });

  it('FAILS a record that contains all requested values but also an extra one', () => {
    // The decisive inversion case: the reversed quantifier FALSE-PASSED this ([A,B] ⊆ [A,B,C] is true),
    // but all(x: x eq A or x eq B) requires the record's collection ⊆ {A,B}, and C is outside it.
    expect(assertCollectionLambda([{ f: ['A', 'B', 'C'] }], 'f', 'all', ['A', 'B']).passed).toBe(false);
  });

  it('fails a record with an element outside the requested values', () => {
    expect(assertCollectionLambda([{ f: ['A', 'C'] }], 'f', 'all', ['A', 'B']).passed).toBe(false);
  });

  it('passes on an empty collection (vacuously within any set)', () => {
    expect(assertCollectionLambda([{ f: [] }], 'f', 'all', ['A', 'B']).passed).toBe(true);
  });
});

describe('#11 — flags bitmask response decoded before matching', () => {
  const enumType: CsdlEnumType = {
    name: 'AF',
    isFlags: true,
    members: [
      { name: 'None', value: '0' },
      { name: 'Active', value: '1' },
      { name: 'Pending', value: '2' },
    ],
  };
  const decode = (raw: unknown) =>
    decodeFlagsValue(enumType, typeof raw === 'string' || typeof raw === 'number' ? raw : undefined);

  it('an integer-bitmask response matches only after decoding', () => {
    // Bitmask 3 = Active(1) | Pending(2). Naive String(3) → ['3'] → no match (the pre-fix false-fail).
    expect(assertCollectionLambda([{ f: 3 }], 'f', 'has', ['Active']).passed).toBe(false);
    expect(assertCollectionLambda([{ f: 3 }], 'f', 'has', ['Active'], decode).passed).toBe(true);
  });

  it('assertEnumMatch `has` decodes a bitmask too', () => {
    expect(assertEnumMatch([{ f: 1 }], 'f', 'has', 'Active', decode).passed).toBe(true);
  });
});

describe('#8 — empty / literal-"undefined" comparison values are dropped', () => {
  it('drops them instead of false-failing every record', () => {
    expect(assertCollectionLambda([{ f: ['A'] }], 'f', 'all', ['A', 'undefined']).passed).toBe(true);
    expect(assertCollectionLambda([{ f: ['A'] }], 'f', 'has', ['undefined', '']).passed).toBe(false); // no valid values → fail
  });
});

describe('#7 — OData single-quote escaping in query builders', () => {
  it('doubles an embedded apostrophe in an enum filter value', () => {
    const scenario = {
      tag: 't',
      name: 'n',
      category: 'enum',
      enumType: 'single',
      op: 'eq',
      fieldParam: 'singleLookupField',
      valueParam: 'singleLookupValue',
      minVersion: '2.0.0',
    } as CoreScenario;
    const params = {
      resource: 'Property',
      keyField: 'ListingKey',
      keyValue: '1',
      enumMode: 'string',
      singleLookupField: 'AttributionContact',
      singleLookupValue: "O'Brien",
      integerValueHigh: 0,
      skippedTypes: [],
    } as unknown as TestParams;
    const q = buildScenarioQuery('http://x', 'Property', scenario, params);
    expect(q && decodeURIComponent(q.url)).toContain("AttributionContact eq 'O''Brien'");
  });
});
