/**
 * Benchmarks for Web API Core assertion primitives.
 *
 * These are the hot path in compliance testing — every scenario runs
 * assertions against every returned record. Performance here directly
 * affects total test duration.
 */

import { bench, describe } from 'vitest';
import {
  assertScalarComparison,
  assertSortOrder,
  assertEnumMatch,
  assertCollectionLambda,
  assertODataResponse,
} from '../src/web-api-core/assertions.js';

// Generate realistic test data
const generateRecords = (count: number): ReadonlyArray<Record<string, unknown>> =>
  Array.from({ length: count }, (_, i) => ({
    ListingKey: `key-${i}`,
    ListPrice: 100000 + i * 10000,
    Latitude: 30.0 + i * 0.01,
    ListDate: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    ModificationTimestamp: `2024-06-${String((i % 28) + 1).padStart(2, '0')}T10:30:00Z`,
    StandardStatus: i % 3 === 0 ? 'Active' : i % 3 === 1 ? 'Pending' : 'Sold',
    Features: ['Pool', 'Garage', 'Deck'].slice(0, (i % 3) + 1),
  }));

const smallSet = generateRecords(10);
const mediumSet = generateRecords(100);
const largeSet = generateRecords(1000);

describe('assertScalarComparison', () => {
  bench('10 records - integer gt', () => {
    assertScalarComparison(smallSet, 'ListPrice', 'gt', 50000, 'integer');
  });

  bench('100 records - integer gt', () => {
    assertScalarComparison(mediumSet, 'ListPrice', 'gt', 50000, 'integer');
  });

  bench('1000 records - integer gt', () => {
    assertScalarComparison(largeSet, 'ListPrice', 'gt', 50000, 'integer');
  });

  bench('100 records - decimal ge', () => {
    assertScalarComparison(mediumSet, 'Latitude', 'ge', 30.0, 'decimal');
  });

  bench('100 records - date lt', () => {
    assertScalarComparison(mediumSet, 'ListDate', 'lt', '2025-01-01', 'date');
  });

  bench('100 records - datetime ne', () => {
    assertScalarComparison(mediumSet, 'ModificationTimestamp', 'ne', '2099-01-01T00:00:00Z', 'datetime');
  });
});

describe('assertSortOrder', () => {
  const sorted = [...mediumSet].sort((a, b) =>
    String(a.ModificationTimestamp) < String(b.ModificationTimestamp) ? -1 : 1
  );

  bench('100 records - ascending', () => {
    assertSortOrder(sorted, 'ModificationTimestamp', 'asc');
  });

  bench('1000 records - ascending', () => {
    const largeSorted = [...largeSet].sort((a, b) =>
      String(a.ModificationTimestamp) < String(b.ModificationTimestamp) ? -1 : 1
    );
    assertSortOrder(largeSorted, 'ModificationTimestamp', 'asc');
  });
});

describe('assertEnumMatch', () => {
  bench('100 records - eq', () => {
    assertEnumMatch(mediumSet, 'StandardStatus', 'eq', 'Active');
  });

  bench('100 records - has', () => {
    assertEnumMatch(mediumSet, 'StandardStatus', 'has', 'Active');
  });
});

describe('assertCollectionLambda', () => {
  bench('100 records - any', () => {
    assertCollectionLambda(mediumSet, 'Features', 'any', ['Pool']);
  });

  bench('100 records - all', () => {
    assertCollectionLambda(mediumSet, 'Features', 'all', ['Pool']);
  });
});

describe('assertODataResponse', () => {
  const response = {
    status: 200,
    headers: { 'odata-version': '4.01' },
    body: { value: mediumSet },
    rawBody: JSON.stringify({ value: mediumSet }),
  };

  bench('validate response', () => {
    assertODataResponse(response, 200);
  });
});
