import { describe, expect, it } from 'vitest';
import type { ODataRequester } from '../../src/test-runner/requester.js';
import type { ODataResponse } from '../../src/test-runner/types.js';
import type { FilterScenario } from '../../src/web-api-core/scenarios.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import { executeStandardScenario } from '../../src/web-api-core/test-runner.js';

// A conformant 2xx needs the OData-Version header, or assertODataResponse rejects it.
const response = (status: number, value: unknown[] = []): ODataResponse => ({
  status,
  headers: { 'odata-version': '4.01' },
  body: { value },
  rawBody: JSON.stringify({ value })
});

// The injected "test client" — returns a scripted response, no vi.mock, no test-mode branch (#125).
const scriptedRequester = (res: ODataResponse): ODataRequester => ({ request: async () => res });

// A standard filter scenario (eq on an integer field). buildFilterUrl builds a query from
// integerField + integerValueHigh, so this reaches the request path (not the skip branch).
const scenario: FilterScenario = {
  tag: 'filter-int-eq',
  name: 'Integer eq',
  category: 'filter',
  dataType: 'integer',
  op: 'eq',
  fieldParam: 'integerField',
  valueParam: 'integerValueHigh',
  minVersion: '2.0.0'
};
const params: TestParams = {
  resource: 'Property',
  keyField: 'ListingKey',
  keyValue: '1',
  enumMode: 'string',
  integerField: 'BedroomsTotal',
  integerValueHigh: 3,
  skippedTypes: [],
  sampleComplete: true
};

const run = (requester: ODataRequester) =>
  executeStandardScenario('http://x', 'Property', scenario, params, 'tok', 0, requester);

// Characterization: locks executeStandardScenario's four outcomes. These assertions are the
// same ones that were green under vi.mock before the refactor — now the runner takes its client
// by injection, and behaviour is identical. That equality IS the proof the refactor is safe.
describe('executeStandardScenario (characterization — injected test client)', () => {
  it('200 with matching data → accepted + passed', async () => {
    const out = await run(scriptedRequester(response(200, [{ ListingKey: '1', BedroomsTotal: 3 }])));
    expect(out).toMatchObject({ accepted: true, rejected: false, retryable: false });
    expect(out.result.passed).toBe(true);
    expect(out.result.skipped).toBe(false);
  });

  it('non-200 → rejected (the server refused the operator), retryable', async () => {
    const out = await run(scriptedRequester(response(400)));
    expect(out).toMatchObject({ accepted: false, rejected: true, retryable: true });
    expect(out.result.passed).toBe(false);
  });

  it('200 empty → accepted, but the eq-on-sampled-value empty verdict is a determinate fail', async () => {
    const out = await run(scriptedRequester(response(200, [])));
    expect(out).toMatchObject({ accepted: true, rejected: false, retryable: false });
    expect(out.result.passed).toBe(false);
    expect(out.result.skipped).toBe(false);
  });

  it('request failure → errored, indeterminate (neither accepted nor rejected), retryable', async () => {
    // A malformed/absent response makes the runner's own response processing throw, which its
    // try/catch converts to an errored result — the same branch a transport error hits.
    const out = await run(scriptedRequester(undefined as unknown as ODataResponse));
    expect(out).toMatchObject({ accepted: false, rejected: false, retryable: true });
    expect(out.result.errored).toBe(true);
    expect(out.result.passed).toBe(false);
  });
});
