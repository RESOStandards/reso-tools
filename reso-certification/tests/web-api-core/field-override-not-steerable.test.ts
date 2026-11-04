import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { EntityType, ODataResponse } from '../../src/test-runner/types.js';
import { parseFieldOverrides } from '../../src/web-api-core/field-override.js';
import { resolveTestParams } from '../../src/web-api-core/sampling.js';
import type { StandardMap } from '../../src/web-api-core/standard-map.js';

/**
 * Not every selection is overridable, and an override naming one that is not must be reported as unmatched
 * rather than silently ignored.
 *
 * Timestamp selection has its own ranker — `ModificationTimestamp` first, then DD-standard by usage — and
 * `lt/le now()` additionally requires a field carrying a PAST value. Widening overriding into it was declined on
 * 2026-10-03, the same day an override on a scalar family was found able to convert a determinate failure into a
 * vacuous pass. It was allowed on 2026-11-03 with that guarded: a named timestamp field must hold a past value.
 *
 * The honesty half matters as much as the behavior. An operator who asks for something that cannot be honored
 * has to be told, and told something true: the run says the override matched no eligible candidate, which is a
 * fact, rather than asserting a cause it cannot know.
 *
 * These go through `parseFieldOverrides` rather than hand-building entries, so the `Resource.Field` requirement
 * is exercised on the same path a real run takes.
 */

const noopStandardMap: StandardMap = {
  isStandardField: () => true,
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
  standardValuesForField: () => undefined,
  isClosedEnumField: () => false
};

const KEY = { name: 'ListingKey', type: 'Edm.String' } as const;
const STAMP = { name: 'ModificationTimestamp', type: 'Edm.DateTimeOffset' } as const;
const PRICE = { name: 'ListPrice', type: 'Edm.Int64' } as const;

const entityType: EntityType = {
  name: 'Property',
  keyProperties: ['ListingKey'],
  properties: [KEY, STAMP, PRICE]
};

/** Two records so the integer family has an eligible candidate to pin. */
const sampleResponse: ODataResponse = {
  status: 200,
  headers: { 'odata-version': '4.01' },
  body: {
    value: [
      { ListingKey: 'P1', ModificationTimestamp: '2024-01-01T00:00:00Z', ListPrice: 100 },
      { ListingKey: 'P2', ModificationTimestamp: '2024-06-01T00:00:00Z', ListPrice: 200 }
    ]
  },
  rawBody: '{}'
};

const requester: ODataRequester = { request: async () => sampleResponse };

const resolve = (specs: ReadonlyArray<string>) =>
  resolveTestParams(
    'http://x',
    'Property',
    entityType,
    'tok',
    [],
    noopStandardMap,
    undefined,
    requester,
    undefined,
    parseFieldOverrides(specs)
  );

describe('timestamp selection is overridable, and an override cannot steer it into a vacuous pass', () => {
  // Declined on 2026-10-03, for the vacuous pass described above. Allowed on 2026-11-03 (Josh: "we should always default
  // to ModificationTimestamp but still let them modify") with the field required to hold a past value, so the now()
  // comparisons always compare something (selectTimestampFields; timestamp-override.test.ts covers the refusals).
  it('reports a datetime override as applied', async () => {
    const params = await resolve(['Property.ModificationTimestamp']);
    expect(params.appliedFieldOverrides ?? []).toContain('Property.ModificationTimestamp');
  });

  it('naming the default changes nothing about which field is tested', async () => {
    const overridden = await resolve(['Property.ModificationTimestamp']);
    const automatic = await resolve([]);
    expect(overridden.timestampField).toBe(automatic.timestampField);
    expect(overridden.timestampFieldForNow).toBe(automatic.timestampFieldForNow);
  });

  it('honors overrides on two families in the same run', async () => {
    // Per-slot sparseness: one family's override never suppresses another's beside it.
    const params = await resolve(['Property.ModificationTimestamp', 'Property.ListPrice']);
    expect(params.appliedFieldOverrides ?? []).toEqual(expect.arrayContaining(['Property.ListPrice', 'Property.ModificationTimestamp']));
  });

  it('ignores a bare field name on an overridable family too, rather than guessing the resource', async () => {
    // `ListPrice` would have been honored under 0.11.0. It is now malformed, so the integer slot stays
    // automatic — which on this fixture happens to pick the same field, so the assertion is on the REPORT.
    const params = await resolve(['ListPrice']);
    expect(params.appliedFieldOverrides ?? []).toEqual([]);
  });
});
