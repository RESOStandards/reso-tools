import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { EntityType } from '../../src/test-runner/types.js';
import { NO_KEY_DECLARED, resolveTestParams } from '../../src/web-api-core/sampling.js';
import { noKeyDeclaredReport } from '../../src/sdk/core.js';
import type { StandardMap } from '../../src/web-api-core/standard-map.js';

/**
 * #315: the key comes from the provider's CSDL `<Key>` and nowhere else.
 *
 * The sampler used to fall back to the literal `'ListingKey'`. That hid a metadata defect the CSDL validator
 * already reports, and supplied a name that is wrong for every well-known resource except Property — so on a
 * keyless Member, Office, Media, OpenHouse or Showing EntityType, every scenario would have projected
 * `$select=ListingKey` and 400, blaming the server for the sampler's invention.
 *
 * Josh, 2026-10-01: "we should just get their key and fail if their resource doesn't have a key definition,
 * standard or local, if we try and do anything that requires a key."
 */

const standardMap: StandardMap = {
  isStandardField: () => true,
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
  standardValuesForField: () => undefined,
  isClosedEnumField: () => false,
};

const entityType = (keyProperties: ReadonlyArray<string>): EntityType => ({
  name: 'Member',
  keyProperties,
  properties: [
    { name: 'MemberKey', type: 'Edm.String' },
    { name: 'MemberFirstName', type: 'Edm.String' },
  ],
});

// Records a server would return, plus a count of how many requests were actually issued.
const countingRequester = (): { requester: ODataRequester; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    requester: {
      request: async ({ url }) => {
        calls.push(url);
        return {
          status: 200,
          headers: { 'odata-version': '4.01' },
          body: { value: [{ MemberKey: 'M1', MemberFirstName: 'Ada' }] },
          rawBody: '',
        };
      },
    },
  };
};

const resolve = (keyProperties: ReadonlyArray<string>, rec = countingRequester()) =>
  resolveTestParams('http://x', 'Member', entityType(keyProperties), 'tok', [], standardMap, undefined, rec.requester).then(p => ({
    params: p,
    calls: rec.calls,
  }));

describe('the key is read from the CSDL, never substituted (#315)', () => {
  it('uses the key the EntityType declares', async () => {
    const { params } = await resolve(['MemberKey']);
    expect(params.keyField).toBe('MemberKey');
    expect(params.skippedTypes).not.toContain(NO_KEY_DECLARED);
  });

  it('does NOT fall back to ListingKey on a keyless EntityType — it marks the resource instead', async () => {
    const { params } = await resolve([]);
    expect(params.keyField).not.toBe('ListingKey');
    expect(params.skippedTypes).toContain(NO_KEY_DECLARED);
  });

  it('issues NO request for a resource it is about to fail', async () => {
    // Nothing to sample when the resource cannot be certified; the old path queried it and then used a fake key.
    const { calls } = await resolve([]);
    expect(calls).toEqual([]);
  });

  it('still samples normally when a key IS declared', async () => {
    const { calls } = await resolve(['MemberKey']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/Member');
  });

  it('takes the FIRST declared key property for a compound key, and does not mark the resource', async () => {
    // A compound key is legal OData ("there can be more than one"). It is a key, so the resource is testable here;
    // addressing a single entity by a compound key is tracked separately.
    const { params } = await resolve(['MemberKey', 'MemberMlsId']);
    expect(params.keyField).toBe('MemberKey');
    expect(params.skippedTypes).not.toContain(NO_KEY_DECLARED);
  });
});

describe('noKeyDeclaredReport — a failure, not a skip', () => {
  const report = noKeyDeclaredReport('Member');

  it('fails the resource rather than skipping it', () => {
    expect(report.summary.failed).toBe(1);
    expect(report.summary.skipped).toBe(0);
    expect(report.scenarios[0].passed).toBe(false);
    expect(report.scenarios[0].skipped).toBe(false);
  });

  it('says what is wrong and that the key is never substituted', () => {
    const message = report.scenarios[0].assertions[0].message;
    expect(message).toContain('no key property');
    expect(message).toContain('never substitutes');
    expect(message).toContain('metadata validation report');
  });

  it('reports no coverage and never claims a deadline was reached', () => {
    expect(report.coverage).toEqual([]);
    expect(report.deadlineReached).toBeUndefined();
  });
});
