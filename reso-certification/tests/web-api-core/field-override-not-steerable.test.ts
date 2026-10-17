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
 * Overrides apply to the Integer, Decimal, Date and enumeration families. **Timestamp selection is
 * deliberately not overridable**: it has its own ranker with semantics an override would quietly break —
 * `ModificationTimestamp` first, then DD-standard by usage, and `lt/le now()` additionally requires a field
 * carrying a PAST value. Widening overriding into it was declined on 2026-10-03, the same day an override on a
 * scalar family was found able to convert a determinate failure into a vacuous pass.
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

describe('timestamp selection is not overridable', () => {
  it('does not report a datetime override as applied', async () => {
    // ModificationTimestamp is a real field on the resource and is genuinely used by the timestamp scenarios,
    // so "absent" and "wrong type" are both false explanations. It simply is not an overridable family.
    const params = await resolve(['Property.ModificationTimestamp']);
    expect(params.appliedFieldOverrides ?? []).not.toContain('Property.ModificationTimestamp');
  });

  it('does not let a datetime override disturb timestamp selection', async () => {
    const overridden = await resolve(['Property.ModificationTimestamp']);
    const automatic = await resolve([]);
    expect(overridden.timestampField).toBe(automatic.timestampField);
    expect(overridden.timestampFieldForNow).toBe(automatic.timestampFieldForNow);
  });

  it('still honors an override on an overridable family in the same run', async () => {
    // So the refusal is scoped to the family rather than being a blanket failure: one unoverridable spec must
    // not suppress an overridable one beside it. This is the per-slot sparseness the whole feature rests on.
    const params = await resolve(['Property.ModificationTimestamp', 'Property.ListPrice']);
    expect(params.appliedFieldOverrides ?? []).toContain('Property.ListPrice');
    expect(params.appliedFieldOverrides ?? []).not.toContain('Property.ModificationTimestamp');
  });

  it('ignores a bare field name on an overridable family too, rather than guessing the resource', async () => {
    // `ListPrice` would have been honored under 0.11.0. It is now malformed, so the integer slot stays
    // automatic — which on this fixture happens to pick the same field, so the assertion is on the REPORT.
    const params = await resolve(['ListPrice']);
    expect(params.appliedFieldOverrides ?? []).toEqual([]);
  });
});
