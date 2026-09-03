import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { EntityType, ODataResponse } from '../../src/test-runner/types.js';
import { buildScenarioQuery } from '../../src/web-api-core/queries.js';
import { resolveTestParams } from '../../src/web-api-core/sampling.js';
import type { StandardMap } from '../../src/web-api-core/standard-map.js';
import type { FilterScenario } from '../../src/web-api-core/scenarios.js';

// Resource-aware OriginatingSystem (OSN/OSID) scoping: resolveTestParams applies the recipient-org filter ONLY
// to resources whose metadata carries the field, both to its own sample fetch AND (via the returned params) to
// every resource-data scenario query. A resource without the field is NEVER scoped — that would 400 it.

const noopStandardMap: StandardMap = {
  isStandardField: () => false,
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
  standardValuesForField: () => undefined,
  isPurelyOpenEnumField: () => false,
};

const sampleResponse: ODataResponse = {
  status: 200,
  headers: { 'odata-version': '4.01' },
  body: { value: [{ ListingKey: 'P1', OriginatingSystemName: 'MyMLS', OriginatingSystemID: 'MLS-42', ListPrice: 100 }] },
  rawBody: '{}',
};

/** A requester that records every requested URL into `urls`, so a test can assert the sample fetch's scoping. */
const capturingRequester = (urls: string[]): ODataRequester => ({
  request: async ({ url }) => {
    urls.push(url);
    return sampleResponse;
  },
});

const KEY = { name: 'ListingKey', type: 'Edm.String' } as const;
const PRICE = { name: 'ListPrice', type: 'Edm.Int64' } as const;
const OSN = { name: 'OriginatingSystemName', type: 'Edm.String' } as const;
const OSID = { name: 'OriginatingSystemID', type: 'Edm.String' } as const;

const entityType = (properties: EntityType['properties']): EntityType => ({
  name: 'Property',
  keyProperties: ['ListingKey'],
  properties,
});

const resolve = (
  et: EntityType,
  originatingSystem: { readonly name?: string; readonly id?: string } | undefined,
  urls: string[],
) => resolveTestParams('http://x', 'Property', et, 'tok', [], noopStandardMap, undefined, capturingRequester(urls), originatingSystem);

describe('resolveTestParams — resource-aware OriginatingSystem scoping', () => {
  it('scopes the sample fetch AND sets params when the resource carries OriginatingSystemName', async () => {
    const urls: string[] = [];
    const params = await resolve(entityType([KEY, OSN, PRICE]), { name: 'MyMLS' }, urls);
    expect(decodeURIComponent(urls[0])).toContain("$filter=OriginatingSystemName eq 'MyMLS'");
    expect(params.originatingSystemName).toBe('MyMLS');
    expect(params.originatingSystemId).toBeUndefined();
  });

  it('does NOT scope when the resource lacks the field (resource-aware — never 400 a field-less resource)', async () => {
    const urls: string[] = [];
    const params = await resolve(entityType([KEY, PRICE]), { name: 'MyMLS' }, urls);
    expect(urls[0]).not.toContain('$filter=');
    expect(urls[0]).not.toContain('OriginatingSystem');
    expect(params.originatingSystemName).toBeUndefined();
  });

  it('uses OriginatingSystemID when only OSID is configured and the resource carries the ID field', async () => {
    const urls: string[] = [];
    const params = await resolve(entityType([KEY, OSID, PRICE]), { id: 'MLS-42' }, urls);
    expect(decodeURIComponent(urls[0])).toContain("$filter=OriginatingSystemID eq 'MLS-42'");
    expect(params.originatingSystemId).toBe('MLS-42');
  });

  it('falls back to OSID when OSN is configured but only the ID field exists on the resource', async () => {
    // OSN preferred in general, but resource-awareness wins: no OSN field here, so scope by the OSID that is present.
    const urls: string[] = [];
    const params = await resolve(entityType([KEY, OSID, PRICE]), { name: 'MyMLS', id: 'MLS-42' }, urls);
    expect(decodeURIComponent(urls[0])).toContain("$filter=OriginatingSystemID eq 'MLS-42'");
    expect(params.originatingSystemName).toBeUndefined();
    expect(params.originatingSystemId).toBe('MLS-42');
  });

  it('is inert (no $filter, no OSN params) when no OriginatingSystem is configured', async () => {
    const urls: string[] = [];
    const params = await resolve(entityType([KEY, OSN, PRICE]), undefined, urls);
    expect(urls[0]).not.toContain('$filter=');
    expect(params.originatingSystemName).toBeUndefined();
    expect(params.originatingSystemId).toBeUndefined();
  });

  it('the OSN it set flows end-to-end: buildScenarioQuery scopes a resource-data filter query', async () => {
    const urls: string[] = [];
    const params = await resolve(entityType([KEY, OSN, PRICE]), { name: 'MyMLS' }, urls);
    const scenario: FilterScenario = { tag: 'filter-int-gt', name: 'Int gt', category: 'filter', dataType: 'integer', op: 'gt', fieldParam: 'integerField', valueParam: 'integerValueMin', minVersion: '2.0.0' };
    const query = buildScenarioQuery('http://x', 'Property', scenario, params);
    expect(decodeURIComponent(query?.url ?? '')).toContain("and OriginatingSystemName eq 'MyMLS'");
  });
});
