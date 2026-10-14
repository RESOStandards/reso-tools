import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { EntityType, ODataResponse } from '../../src/test-runner/types.js';
import { resolveTestParams } from '../../src/web-api-core/sampling.js';
import type { StandardMap } from '../../src/web-api-core/standard-map.js';

/**
 * Not every selection is steerable, and a preference naming one that is not must be reported as unmatched
 * rather than silently ignored.
 *
 * Preferences apply to the Integer, Decimal, Date and enumeration families. **Timestamp selection is
 * deliberately not steerable**: it has its own ranker with semantics a preference would quietly break —
 * `ModificationTimestamp` first, then DD-standard by usage, and `lt/le now()` additionally requires a field
 * carrying a PAST value. Widening steering into it was declined on 2026-10-03, the same day a preference on a
 * steerable family was found able to convert a determinate failure into a vacuous pass.
 *
 * The honesty half matters as much as the behavior. An operator who asks for something that cannot be honored
 * has to be told, and told something true: the run says the preference matched no steerable candidate, which
 * is a fact, rather than asserting a cause it cannot know.
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

/** Two records so the integer family has a discriminating candidate to steer toward. */
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

const resolve = (preferFields: ReadonlyArray<string>) =>
  resolveTestParams('http://x', 'Property', entityType, 'tok', [], noopStandardMap, undefined, requester, undefined, {
    entries: preferFields.map(spec => ({ field: spec.includes('.') ? spec.split('.')[1] : spec, spec }))
  });

describe('timestamp selection is not steerable', () => {
  it('does not report a datetime preference as applied', async () => {
    // ModificationTimestamp is a real field on the resource and is genuinely used by the timestamp scenarios,
    // so "absent" and "wrong type" are both false explanations. It simply is not a steerable family.
    const params = await resolve(['ModificationTimestamp']);
    expect(params.appliedFieldPreferences ?? []).not.toContain('ModificationTimestamp');
  });

  it('does not let a datetime preference disturb timestamp selection', async () => {
    const steered = await resolve(['ModificationTimestamp']);
    const unsteered = await resolve([]);
    expect(steered.timestampField).toBe(unsteered.timestampField);
    expect(steered.timestampFieldForNow).toBe(unsteered.timestampFieldForNow);
  });

  it('still honors a preference on a steerable family in the same run', async () => {
    // So the refusal is scoped to the family rather than being a blanket failure: one unsteerable spec must
    // not suppress a steerable one beside it.
    const params = await resolve(['ModificationTimestamp', 'ListPrice']);
    expect(params.appliedFieldPreferences ?? []).toContain('ListPrice');
    expect(params.appliedFieldPreferences ?? []).not.toContain('ModificationTimestamp');
  });
});
