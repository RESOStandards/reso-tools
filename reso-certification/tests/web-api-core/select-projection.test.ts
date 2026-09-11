import { describe, expect, it } from 'vitest';
import { buildScenarioQuery } from '../../src/web-api-core/queries.js';
import { runStructuralScenario } from '../../src/web-api-core/test-runner.js';
import type { StructuralScenario } from '../../src/web-api-core/scenarios.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';

// $select must project a MULTI-field list (key + a real data field) and verify the server HONORED it. A key-only
// $select + a 200/has-results check degenerates to "a key projection returns rows" and passes a server that
// mishandles a multi-field projection (the Commander selects key + a data field and checks the data comes back).

const selectScenario: StructuralScenario = { tag: 'select', name: '$select query support', category: 'structural', assertion: 'select', minVersion: '2.0.0' };

const baseParams: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
  timestampField: 'ModificationTimestamp', // a sampled, known-populated data field
};

const requesterReturning = (records: ReadonlyArray<Record<string, unknown>>): ODataRequester => ({
  request: async (): Promise<ODataResponse> => ({ status: 200, headers: { 'odata-version': '4.01' }, body: { value: records }, rawBody: '' }),
});

describe('$select — multi-field projection built + the server must honor it', () => {
  it('the query projects a MULTI-field list (key + a sampled data field), not just the key', () => {
    const q = buildScenarioQuery('http://x', 'Property', selectScenario, baseParams);
    expect(q?.selectFields).toContain('ListingKey');
    expect(q?.selectFields).toContain('ModificationTimestamp');
    expect(decodeURIComponent(q?.url ?? '')).toContain('$select=ListingKey,ModificationTimestamp');
  });

  it('PASSES + confirms when the server carries the projected data field', async () => {
    const q = buildScenarioQuery('http://x', 'Property', selectScenario, baseParams);
    const req = requesterReturning([{ ListingKey: '1', ModificationTimestamp: '2026-01-01T00:00:00Z' }]);
    const r = await runStructuralScenario('http://x', 'Property', 'select', q!, baseParams, 'tok', 0, req);
    expect(r.passed).toBe(true);
    expect(r.assertions.some((a) => a.passed && a.message.includes('projected fields present') && a.message.includes('ModificationTimestamp'))).toBe(true);
  });

  it('PERMITS a field OUTSIDE the $select list — no fail, no warning (OData 4.01 §11.2.5.1 allows returning more)', async () => {
    // OData 4.01 §11.2.5.1: $select "requests that the service return only the properties … and MAY return
    // additional information." Returning fields beyond the select list is EXPLICITLY PERMITTED — not a defect and
    // not even warning-worthy (which is also why the Commander, the oracle for this 2.0.0 element, never checked
    // it). A $select-ignoring server that carries the projected field simply passes, no warning.
    const q = buildScenarioQuery('http://x', 'Property', selectScenario, baseParams);
    const req = requesterReturning([{ ListingKey: '1', ModificationTimestamp: '2026-01-01T00:00:00Z', ListPrice: 500000 }]);
    const r = await runStructuralScenario('http://x', 'Property', 'select', q!, baseParams, 'tok', 0, req);
    expect(r.passed).toBe(true);
    expect(r.assertions.every((a) => a.passed)).toBe(true);
    expect(r.warnings ?? []).toHaveLength(0); // the extra field is spec-permitted → NOT flagged at all
    expect(r.assertions.some((a) => a.message.includes('projected fields present'))).toBe(true);
  });

  it('does NOT false-fail when the projected field is null/omitted (sparse field or null-omitting server)', async () => {
    // The regression the adversarial review flagged: a legitimately-sparse projected field (null across the page,
    // which OData permits a server to omit) must NOT fail — a key-only response is indistinguishable from null-omit.
    const q = buildScenarioQuery('http://x', 'Property', selectScenario, baseParams);
    const req = requesterReturning([{ ListingKey: '1' }, { ListingKey: '2' }]);
    const r = await runStructuralScenario('http://x', 'Property', 'select', q!, baseParams, 'tok', 0, req);
    expect(r.passed).toBe(true);
    expect(r.assertions.some((a) => a.passed && a.message.includes('null/omitted'))).toBe(true);
  });

  it('a resource with no sampled data field → key-only projection, not exercised (non-failing note)', async () => {
    const keyOnly: TestParams = { ...baseParams, timestampField: undefined };
    const q = buildScenarioQuery('http://x', 'Property', selectScenario, keyOnly);
    expect(q?.selectFields).toEqual(['ListingKey']);
    const req = requesterReturning([{ ListingKey: '1' }]);
    const r = await runStructuralScenario('http://x', 'Property', 'select', q!, keyOnly, 'tok', 0, req);
    expect(r.passed).toBe(true);
    expect(r.assertions.some((a) => a.message.includes('not exercised'))).toBe(true);
  });
});
