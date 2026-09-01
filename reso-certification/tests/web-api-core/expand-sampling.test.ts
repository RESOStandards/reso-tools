import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { EntityType } from '../../src/test-runner/types.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import { buildScenarioQuery } from '../../src/web-api-core/queries.js';
import { resolveTestParams } from '../../src/web-api-core/sampling.js';
import type { StandardMap } from '../../src/web-api-core/standard-map.js';
import type { ExpandScenario } from '../../src/web-api-core/scenarios.js';

// The 2.1.0 $expand scenario was dormant: resolveTestParams never populated `expandField`, so buildExpandUrl
// returned undefined and the scenario always skipped. Selection = the FIRST COLLECTION navigation property of
// the resource's entity type (a collection is what `$top=5` and the RRK child-collection check expect).

// A StandardMap stub — expand selection is off the entity type's navigation properties, not the DD reference,
// so nothing here needs a real DD map.
const noopStandardMap: StandardMap = {
  isStandardField: () => false,
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
};

// One record is enough that resolveTestParams doesn't take its no-records early return (which never reaches the
// expand selection). expandField is chosen from the entity type, not the records.
const oneRecordResponse: ODataResponse = {
  status: 200,
  headers: { 'odata-version': '4.01' },
  body: { value: [{ ListingKey: 'P1', BedroomsTotal: 3 }] },
  rawBody: JSON.stringify({ value: [{ ListingKey: 'P1', BedroomsTotal: 3 }] }),
};

const scriptedRequester: ODataRequester = { request: async () => oneRecordResponse };

const makeEntityType = (
  navigationProperties?: EntityType['navigationProperties'],
): EntityType => ({
  name: 'Property',
  keyProperties: ['ListingKey'],
  properties: [
    { name: 'ListingKey', type: 'Edm.String' },
    { name: 'BedroomsTotal', type: 'Edm.Int64' },
  ],
  ...(navigationProperties && { navigationProperties }),
});

const resolve = (entityType: EntityType) =>
  resolveTestParams('http://x', 'Property', entityType, 'tok', [], noopStandardMap, undefined, scriptedRequester);

// The exact 2.1.0 catalog entry (scenarios.ts) — dispatched through buildScenarioQuery to buildExpandUrl.
const expandScenario: ExpandScenario = {
  tag: 'expand',
  name: '$expand navigation property',
  category: 'expand',
  fieldParam: 'expandField',
  minVersion: '2.1.0',
};

describe('resolveTestParams — $expand navigation selection', () => {
  it('sets expandField to the FIRST collection nav, skipping an earlier single-valued nav', async () => {
    // ListOffice (single) is declared before Media (collection) — selection must skip it and pick Media.
    const params = await resolve(
      makeEntityType([
        { name: 'ListOffice', isCollection: false, targetType: 'Office' },
        { name: 'Media', isCollection: true, targetType: 'Media' },
      ]),
    );
    expect(params.expandField).toBe('Media');
  });

  it('picks the FIRST collection nav in declaration order when several exist (deterministic)', async () => {
    const params = await resolve(
      makeEntityType([
        { name: 'Media', isCollection: true, targetType: 'Media' },
        { name: 'Rooms', isCollection: true, targetType: 'Room' },
      ]),
    );
    expect(params.expandField).toBe('Media');
  });

  it('leaves expandField unset when only single-valued navs exist', async () => {
    const params = await resolve(makeEntityType([{ name: 'ListOffice', isCollection: false, targetType: 'Office' }]));
    expect(params.expandField).toBeUndefined();
  });

  it('leaves expandField unset when the entity type declares no navigation properties', async () => {
    const params = await resolve(makeEntityType(undefined));
    expect(params.expandField).toBeUndefined();
  });
});

describe('$expand scenario activation — end to end through buildScenarioQuery', () => {
  it('a resource WITH a collection nav runs: buildScenarioQuery emits the expand URL (not skipped)', async () => {
    const params = await resolve(makeEntityType([{ name: 'Media', isCollection: true, targetType: 'Media' }]));
    const query = buildScenarioQuery('http://x', 'Property', expandScenario, params);
    expect(query).toBeDefined();
    expect(query?.url).toBe('http://x/Property?$expand=Media&$top=5');
  });

  it('a resource WITHOUT a collection nav still skips: buildScenarioQuery returns undefined', async () => {
    const params = await resolve(makeEntityType([{ name: 'ListOffice', isCollection: false, targetType: 'Office' }]));
    expect(buildScenarioQuery('http://x', 'Property', expandScenario, params)).toBeUndefined();
  });
});
