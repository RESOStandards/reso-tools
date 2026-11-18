import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newReplicationState } from '../helpers/replication-state.js';

const require = createRequire(import.meta.url);
const { getMetadata } = require(resolve(import.meta.dirname, '../../src/etl/common.cjs'));
const { scorePayload, consolidateResults } = require(resolve(import.meta.dirname, '../../src/legacy/lib/replication/utils.js'));

/**
 * A run can expand one navigation per request or all of a resource's navigations in one request (batch expansion). The
 * two must report the same Data Availability. Found 2026-11-18 in the production reports: batched DD 2.1 runs reported
 * ListAgent, OpenHouses and the other navigations as fields of Property, counted each parent record once per navigation,
 * and recorded 0 expanded records for every child but the first (Media), while their expanded fields were present.
 */

interface State {
  readonly setMetadataMap: (report: unknown) => void;
  readonly getResourceAvailabilityMap: () => unknown;
  readonly getResponses: () => ReadonlyArray<unknown>;
}

interface Consolidated {
  readonly fields: ReadonlyArray<{ resourceName: string; fieldName: string; parentResourceName?: string; frequency: number }>;
  readonly resources: ReadonlyArray<{
    resourceName: string;
    numUniqueRecordsFetched?: number;
    expansions?: ReadonlyArray<{ resourceName: string; numExpandedRecordsFetched: number; numSamples: number }>;
  }>;
}

const LIST_AGENT = { fieldName: 'ListAgent', modelName: 'Member' };
const MEDIA = { fieldName: 'Media', modelName: 'Media' };

// Synthetic records: two listings, one agent each, three media between them.
const listings = [
  {
    ListingKey: 'L1',
    City: 'Alpha',
    ListAgent: { MemberKey: 'A1', MemberFirstName: 'Ann' },
    Media: [
      { MediaKey: 'X1', MediaURL: 'https://example.org/1.jpg' },
      { MediaKey: 'X2', MediaURL: 'https://example.org/2.jpg' }
    ]
  },
  {
    ListingKey: 'L2',
    City: 'Beta',
    ListAgent: { MemberKey: 'A2', MemberFirstName: 'Bo' },
    Media: [{ MediaKey: 'X3', MediaURL: 'https://example.org/3.jpg' }]
  }
];

/** What a server returns for `$expand` of these navigations only. */
const expandedAs = (navigations: ReadonlyArray<string>) =>
  listings.map(({ ListAgent, Media, ...listing }) => ({
    ...listing,
    ...(navigations.includes('ListAgent') ? { ListAgent } : {}),
    ...(navigations.includes('Media') ? { Media } : {})
  }));

const run = (requests: ReadonlyArray<ReadonlyArray<{ fieldName: string; modelName: string }>>): Consolidated => {
  const state = newReplicationState<State>();
  state.setMetadataMap(getMetadata('2.0'));
  for (const expansionInfo of requests) {
    scorePayload({
      requestUri: 'https://example.org/Property',
      jsonData: { value: expandedAs(expansionInfo.map(({ fieldName }) => fieldName)) },
      resourceName: 'Property',
      responseTimeMs: 100,
      responseBytes: 1000,
      expansionInfo,
      replicationStateServiceInstance: state
    });
  }
  return consolidateResults({ resourceAvailabilityMap: state.getResourceAvailabilityMap(), responses: state.getResponses() });
};

const fieldsOf = (result: Consolidated) =>
  result.fields
    .map(
      ({ resourceName, fieldName, parentResourceName, frequency }) =>
        `${parentResourceName ?? '-'}/${resourceName}.${fieldName}=${frequency}`
    )
    .sort();

const expandedOf = (result: Consolidated, child: string) =>
  result.resources.find(({ resourceName }) => resourceName === 'Property')?.expansions?.find(({ resourceName }) => resourceName === child);

describe('batch expansion reports what one expansion per request reports', () => {
  const batched = run([[LIST_AGENT, MEDIA]]);
  const oneAtATime = run([[LIST_AGENT], [MEDIA]]);

  it('keeps every navigation off the parent: none is reported as a field of Property', () => {
    const propertyFields = batched.fields.filter(field => field.resourceName === 'Property' && field.parentResourceName === undefined);
    expect(propertyFields.map(({ fieldName }) => fieldName).sort()).toEqual(['City', 'ListingKey']);
  });

  it('reports the same fields, on the same paths, with the same frequencies', () => {
    expect(fieldsOf(batched)).toEqual(fieldsOf(oneAtATime));
  });

  it('credits each child with its own expanded records, not the first child with all of them', () => {
    expect(expandedOf(batched, 'Member')?.numExpandedRecordsFetched).toBe(2);
    expect(expandedOf(batched, 'Media')?.numExpandedRecordsFetched).toBe(3);
    expect(expandedOf(oneAtATime, 'Member')?.numExpandedRecordsFetched).toBe(2);
    expect(expandedOf(oneAtATime, 'Media')?.numExpandedRecordsFetched).toBe(3);
  });

  it('counts each parent record once', () => {
    const property = (result: Consolidated) => result.resources.find(({ resourceName }) => resourceName === 'Property');
    expect(property(batched)?.numUniqueRecordsFetched).toBe(2);
    expect(property(oneAtATime)?.numUniqueRecordsFetched).toBe(2);
  });
});
