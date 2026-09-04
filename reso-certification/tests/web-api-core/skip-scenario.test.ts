import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { runStructuralScenario } from '../../src/web-api-core/test-runner.js';

// A 200 page carrying the given primary-key values (ListingKey), used to script the two $skip fetches.
const page = (keys: readonly string[]): ODataResponse => ({
  status: 200,
  headers: { 'odata-version': '4.01' },
  body: { value: keys.map(k => ({ ListingKey: k })) },
  rawBody: '',
});

// Injected client — returns the scripted responses in order (page 1, then the $skip=5 page).
const queuedRequester = (responses: readonly ODataResponse[]): ODataRequester => {
  const queue = [...responses];
  return {
    request: async () => {
      const next = queue.shift();
      if (!next) throw new Error('requester queue exhausted');
      return next;
    },
  };
};

const params: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerValueHigh: 0,
  skippedTypes: [],
  sampleComplete: true,
};
const query = { url: 'http://x/Property?$top=5&$select=ListingKey', selectFields: ['ListingKey'] };

const runSkip = (responses: readonly ODataResponse[]) =>
  runStructuralScenario('http://x', 'Property', 'skip', query, params, 'tok', 0, queuedRequester(responses));

// The $skip "unique pages" / stable-ordering scenario: GET `$top=5`, then the same query `+ $skip=5`, and the two
// primary-key sets must be DISJOINT (absent $orderby, OData requires a stable ordering across $top/$skip). An
// overlap is an ordering defect → FAIL, carrying the grounded, mandatory-framed message (NO consistency hedge).
describe('runStructuralScenario — $skip stable-ordering (unique pages)', () => {
  it('disjoint pages → passes', async () => {
    const out = await runSkip([page(['1', '2', '3', '4', '5']), page(['6', '7', '8', '9', '10'])]);
    expect(out.tag).toBe('skip');
    expect(out.passed).toBe(true);
    expect(out.skipped).toBe(false);
  });

  it('overlapping pages → FAILS and returns the grounded stable-ordering message', async () => {
    const out = await runSkip([page(['1', '2', '3', '4', '5']), page(['4', '5', '6', '7', '8'])]);
    expect(out.passed).toBe(false);
    const msg = out.assertions.map(a => a.message ?? '').join(' ');
    expect(msg).toContain('$skip overlap: 2 keys appear in both pages'); // the overlap is reported by key
    expect(msg).toContain('stable sort is mandatory'); // required, never optional
    expect(msg).not.toContain('not required to guarantee consistent results'); // no softening hedge on top/skip
    expect(msg).toContain('https://docs.oasis-open.org/odata/odata/v4.0/errata03/'); // spec grounding retained
  });

  it('single overlapping key → FAILS with correct singular phrasing', async () => {
    const out = await runSkip([page(['1', '2', '3', '4', '5']), page(['5', '6', '7', '8', '9'])]);
    expect(out.passed).toBe(false);
    const msg = out.assertions.map(a => a.message ?? '').join(' ');
    expect(msg).toContain('$skip overlap: 1 key appears in both pages');
  });
});
