import { describe, it, expect } from 'vitest';
import {
  assertScalarComparison,
  assertScalarCompoundOr,
  assertSortOrder,
  assertEnumMatch,
  assertCollectionLambda,
  assertODataResponse,
  assertHasResults,
  assertStringComparison,
  extractRecords,
  extractCount,
  extractNextLink,
} from '../../src/web-api-core/assertions.js';
import type { ODataResponse } from '../../src/test-runner/types.js';

const makeResponse = (overrides: Partial<ODataResponse> = {}): ODataResponse => ({
  status: 200,
  headers: { 'odata-version': '4.01' },
  body: { value: [] },
  rawBody: '{"value":[]}',
  ...overrides,
});

describe('assertScalarComparison', () => {
  const records = [
    { id: '1', price: 100, amount: 10.5 },
    { id: '2', price: 200, amount: 20.0 },
    { id: '3', price: 300, amount: 30.5 },
  ];

  it('passes when all records satisfy gt', () => {
    const result = assertScalarComparison(records, 'price', 'gt', 50, 'integer');
    expect(result.passed).toBe(true);
  });

  it('fails when some records do not satisfy gt', () => {
    const result = assertScalarComparison(records, 'price', 'gt', 150, 'integer');
    expect(result.passed).toBe(false);
  });

  it('handles eq comparison', () => {
    const result = assertScalarComparison(records, 'price', 'eq', 200, 'integer');
    expect(result.passed).toBe(false); // records 1 and 3 don't match
  });

  it('handles ne comparison', () => {
    const result = assertScalarComparison(records, 'price', 'ne', 999, 'integer');
    expect(result.passed).toBe(true);
  });

  it('handles decimal comparison', () => {
    const result = assertScalarComparison(records, 'amount', 'ge', 10.5, 'decimal');
    expect(result.passed).toBe(true);
  });

  it('handles date comparison', () => {
    const dateRecords = [
      { id: '1', date: '2024-06-15' },
      { id: '2', date: '2024-08-20' },
    ];
    const result = assertScalarComparison(dateRecords, 'date', 'gt', '2024-01-01', 'date');
    expect(result.passed).toBe(true);
  });

  it('skips null values', () => {
    const withNull = [...records, { id: '4', price: null, amount: null }];
    const result = assertScalarComparison(withNull as ReadonlyArray<Record<string, unknown>>, 'price', 'gt', 50, 'integer');
    expect(result.passed).toBe(true);
  });

  it('handles empty records array', () => {
    const result = assertScalarComparison([], 'price', 'gt', 50, 'integer');
    expect(result.passed).toBe(true);
  });
});

describe('assertScalarCompoundOr — per-record OR, not the aggregate check1||check2', () => {
  it('PASSES when each record satisfies at least one condition — even when NEITHER condition holds for ALL records', () => {
    // `price gt 100 OR price lt 50`: 200 satisfies gt-100, 30 satisfies lt-50. Neither "all gt 100" nor "all lt 50"
    // is true, so the old aggregate `check1.passed || check2.passed` would WRONGLY fail this; the per-record OR passes.
    const records = [{ price: 200 }, { price: 30 }];
    expect(assertScalarCompoundOr(records, 'price', 'gt', 100, 'lt', 50, 'integer').passed).toBe(true);
  });

  it('FAILS a record that satisfies NEITHER condition (the hole the old hardcoded pass masked)', () => {
    const records = [{ price: 200 }, { price: 75 }]; // 75 is neither > 100 nor < 50
    const res = assertScalarCompoundOr(records, 'price', 'gt', 100, 'lt', 50, 'integer');
    expect(res.passed).toBe(false);
    expect(res.message).toContain('neither');
  });

  it('skips null field values (consistent with assertScalarComparison)', () => {
    const records = [{ price: null }, { price: 200 }];
    expect(assertScalarCompoundOr(records, 'price', 'gt', 100, 'lt', 50, 'integer').passed).toBe(true);
  });
});

describe('assertSortOrder', () => {
  it('passes for ascending order', () => {
    const records = [{ ts: '2024-01-01' }, { ts: '2024-02-01' }, { ts: '2024-03-01' }];
    expect(assertSortOrder(records, 'ts', 'asc').passed).toBe(true);
  });

  it('passes for descending order', () => {
    const records = [{ ts: '2024-03-01' }, { ts: '2024-02-01' }, { ts: '2024-01-01' }];
    expect(assertSortOrder(records, 'ts', 'desc').passed).toBe(true);
  });

  it('fails for wrong order', () => {
    const records = [{ ts: '2024-03-01' }, { ts: '2024-01-01' }, { ts: '2024-02-01' }];
    expect(assertSortOrder(records, 'ts', 'asc').passed).toBe(false);
  });

  it('passes for equal values', () => {
    const records = [{ ts: '2024-01-01' }, { ts: '2024-01-01' }];
    expect(assertSortOrder(records, 'ts', 'asc').passed).toBe(true);
    expect(assertSortOrder(records, 'ts', 'desc').passed).toBe(true);
  });

  it('passes for single record', () => {
    expect(assertSortOrder([{ ts: '2024-01-01' }], 'ts', 'asc').passed).toBe(true);
  });
});

describe('assertEnumMatch', () => {
  const records = [
    { status: 'Active' },
    { status: 'Active' },
  ];

  it('passes for eq match', () => {
    expect(assertEnumMatch(records, 'status', 'eq', 'Active').passed).toBe(true);
  });

  it('fails for eq mismatch', () => {
    expect(assertEnumMatch(records, 'status', 'eq', 'Pending').passed).toBe(false);
  });

  it('passes for ne match', () => {
    expect(assertEnumMatch(records, 'status', 'ne', 'Pending').passed).toBe(true);
  });

  it('passes for has match', () => {
    expect(assertEnumMatch(records, 'status', 'has', 'Active').passed).toBe(true);
  });
});

describe('assertCollectionLambda', () => {
  const records = [
    { features: ['Pool', 'Garage', 'Fence'] },
    { features: ['Pool', 'Deck'] },
  ];

  it('passes for any() with matching value', () => {
    expect(assertCollectionLambda(records, 'features', 'any', ['Pool']).passed).toBe(true);
  });

  it('fails for any() with no match', () => {
    expect(assertCollectionLambda(records, 'features', 'any', ['Elevator']).passed).toBe(false);
  });

  it('passes for all() when every element of each record is within the requested values', () => {
    // Field/all(x: x eq A or x eq B …) requires each record's collection to be a SUBSET of {values}.
    expect(assertCollectionLambda(records, 'features', 'all', ['Pool', 'Garage', 'Fence', 'Deck']).passed).toBe(true);
  });

  it('fails for all() when a record has an element outside the requested values', () => {
    // ['Pool','Garage','Fence'] is not within {Pool}, so all(x: x eq Pool) is violated.
    expect(assertCollectionLambda(records, 'features', 'all', ['Pool']).passed).toBe(false);
  });

  it('handles comma-separated string values', () => {
    const stringRecords = [{ tags: 'Pool,Garage' }];
    expect(assertCollectionLambda(stringRecords, 'tags', 'any', ['Pool']).passed).toBe(true);
  });

  it('all() is vacuously TRUE for a record with an empty collection (array, string, or null)', () => {
    // web-api-core.md:107 — "a record with an empty collection satisfies this vacuously".
    expect(assertCollectionLambda([{ features: [] }], 'features', 'all', ['Pool']).passed).toBe(true); // empty array
    expect(assertCollectionLambda([{ features: '' }], 'features', 'all', ['Pool']).passed).toBe(true); // empty string → no members
    expect(assertCollectionLambda([{ features: null }], 'features', 'all', ['Pool']).passed).toBe(true); // null collection skipped, never a failure
  });

  it('all() still FAILS a record whose collection has a value outside the set (empty rows do not mask it)', () => {
    expect(assertCollectionLambda([{ features: ['Elevator'] }, { features: [] }], 'features', 'all', ['Pool']).passed).toBe(false);
  });

  it('any() is FALSE for a record with an empty collection (nothing to match)', () => {
    expect(assertCollectionLambda([{ features: [] }], 'features', 'any', ['Pool']).passed).toBe(false);
    expect(assertCollectionLambda([{ features: '' }], 'features', 'any', ['Pool']).passed).toBe(false);
  });
});

describe('assertODataResponse', () => {
  it('passes for valid 200 response', () => {
    expect(assertODataResponse(makeResponse(), 200).passed).toBe(true);
  });

  it('fails for wrong status code', () => {
    expect(assertODataResponse(makeResponse({ status: 404 }), 200).passed).toBe(false);
  });

  it('fails for missing OData-Version header', () => {
    expect(assertODataResponse(makeResponse({ headers: {} }), 200).passed).toBe(false);
  });

  it('passes for expected error status', () => {
    expect(assertODataResponse(makeResponse({ status: 400 }), 400).passed).toBe(true);
  });

  it('accepts both OData-Version 4.0 and 4.01', () => {
    expect(assertODataResponse(makeResponse({ headers: { 'odata-version': '4.0' } }), 200).passed).toBe(true);
    expect(assertODataResponse(makeResponse({ headers: { 'odata-version': '4.01' } }), 200).passed).toBe(true);
  });

  it('captures the OData error.message on a status mismatch (self-diagnosing failure)', () => {
    const res = assertODataResponse(
      makeResponse({
        status: 400,
        body: { error: { code: '', message: 'OriginatingSystemName is required.' } },
        rawBody: '{"error":{"message":"OriginatingSystemName is required."}}',
      }),
      200,
    );
    expect(res.passed).toBe(false);
    expect(res.message).toContain('got 400');
    expect(res.message).toContain('OriginatingSystemName is required.');
  });

  it('falls back to the raw body when there is no OData error.message', () => {
    const res = assertODataResponse(makeResponse({ status: 400, body: null, rawBody: 'Bad Request: invalid filter clause' }), 200);
    expect(res.passed).toBe(false);
    expect(res.message).toContain('invalid filter clause');
  });

  it('truncates an oversized error body to keep the message a single readable line', () => {
    const res = assertODataResponse(makeResponse({ status: 400, body: null, rawBody: 'x'.repeat(500) }), 200);
    expect(res.passed).toBe(false);
    expect(res.message).toContain('…');
    expect(res.message.length).toBeLessThan(400);
  });
});

describe('assertHasResults', () => {
  it('passes when value array has records', () => {
    expect(assertHasResults({ value: [{ id: '1' }] }).passed).toBe(true);
  });

  it('fails when value array is empty', () => {
    expect(assertHasResults({ value: [] }).passed).toBe(false);
  });

  it('fails when body is null', () => {
    expect(assertHasResults(null).passed).toBe(false);
  });
});

describe('extractRecords', () => {
  it('extracts from OData collection response', () => {
    expect(extractRecords({ value: [{ id: '1' }, { id: '2' }] })).toHaveLength(2);
  });

  it('returns empty for null body', () => {
    expect(extractRecords(null)).toHaveLength(0);
  });
});

describe('extractCount', () => {
  it('extracts @odata.count', () => {
    expect(extractCount({ '@odata.count': 42, value: [] })).toBe(42);
  });

  it('returns undefined when missing', () => {
    expect(extractCount({ value: [] })).toBeUndefined();
  });
});

describe('extractNextLink', () => {
  it('extracts @odata.nextLink', () => {
    expect(extractNextLink({ '@odata.nextLink': 'http://example.com/next', value: [] })).toBe('http://example.com/next');
  });

  it('returns undefined when missing', () => {
    expect(extractNextLink({ value: [] })).toBeUndefined();
  });
});
