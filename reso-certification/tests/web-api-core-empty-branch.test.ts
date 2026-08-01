import { describe, expect, it } from 'vitest';
import { complementOp, emptyContextFor, emptyOutcome, rebaseNextLink } from '../src/web-api-core/test-runner.js';
import type { TestParams } from '../src/web-api-core/sampling.js';
import type { ComparisonOp, CoreScenario } from '../src/web-api-core/scenarios.js';

// Piece 3 — the two pure pieces of the runner's 200-empty branch. Together with the emptyVerdict matrix they
// fully specify what a 200-with-no-rows means, without needing to mock the network.

const params = (extra: Partial<TestParams> = {}): TestParams =>
  ({ resource: 'Property', keyField: 'ListingKey', keyValue: '1', enumMode: 'string', integerValueHigh: 0, sampleComplete: true, skippedTypes: [], ...extra }) as TestParams;

const filter = (dataType: string): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'filter', dataType, op: 'ne', fieldParam: 'f', valueParam: 'v', minVersion: '2.0.0' }) as CoreScenario;
const enumS = (slot: 'single' | 'multi'): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'enum', enumType: slot, op: 'ne', fieldParam: slot === 'multi' ? 'multiLookupField' : 'singleLookupField', valueParam: 'v', minVersion: '2.0.0' }) as CoreScenario;
const structural = (): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'structural', assertion: 'metadata', minVersion: '2.0.0' }) as CoreScenario;

describe('emptyContextFor — picks the distinct count of the field this scenario queried', () => {
  it('routes each scalar dataType to its own sampled distinct count', () => {
    const p = params({ integerDistinctCount: 5, decimalDistinctCount: 4, dateDistinctCount: 3 });
    expect(emptyContextFor(filter('integer'), p).distinctValueCount).toBe(5);
    expect(emptyContextFor(filter('decimal'), p).distinctValueCount).toBe(4);
    expect(emptyContextFor(filter('date'), p).distinctValueCount).toBe(3);
  });

  it('leaves datetime (ne now()) countless — its verdict ignores the count', () => {
    expect(emptyContextFor(filter('datetime'), params({ integerDistinctCount: 5 })).distinctValueCount).toBeUndefined();
  });

  it('reads the enum count from the slot the substituted candidate populated', () => {
    const p = params({ singleLookupDistinctCount: 2, multiLookupDistinctCount: 7 });
    expect(emptyContextFor(enumS('single'), p).distinctValueCount).toBe(2);
    expect(emptyContextFor(enumS('multi'), p).distinctValueCount).toBe(7);
  });

  it('threads sample completeness through unchanged', () => {
    expect(emptyContextFor(filter('integer'), params({ sampleComplete: false })).complete).toBe(false);
    expect(emptyContextFor(structural(), params({ sampleComplete: true })).complete).toBe(true);
  });
});

describe('emptyOutcome — verdict → result flags', () => {
  it('fail is a determinate failure (never retried, so it cannot be masked by another field)', () => {
    const o = emptyOutcome('fail');
    expect(o).toMatchObject({ passed: false, skipped: false, retryable: false });
  });

  it('pass is a determinate pass (the empty ne was correct)', () => {
    expect(emptyOutcome('pass')).toMatchObject({ passed: true, skipped: false, retryable: false });
  });

  it('skip stays retryable so the next candidate field is tried', () => {
    expect(emptyOutcome('skip')).toMatchObject({ passed: true, skipped: true, retryable: true });
  });
});

describe('complementOp — the assertion op for a negated filter', () => {
  it('maps each operator to its logical negation', () => {
    const pairs: ReadonlyArray<readonly [ComparisonOp, ComparisonOp]> = [
      ['le', 'gt'], // not(field le -1) → records satisfy field gt -1 (the -1 sentinel case)
      ['gt', 'le'],
      ['ge', 'lt'],
      ['lt', 'ge'],
      ['eq', 'ne'],
      ['ne', 'eq'],
    ];
    for (const [op, negated] of pairs) expect(complementOp(op)).toBe(negated);
  });

  it('is an involution — negating twice returns the original', () => {
    for (const op of ['eq', 'ne', 'gt', 'ge', 'lt', 'le'] as const) {
      expect(complementOp(complementOp(op))).toBe(op);
    }
  });
});

describe('rebaseNextLink — follow a proxy/wrong-host @odata.nextLink safely', () => {
  it('restores the dropped port from the request origin (the live desktop-server bug)', () => {
    // Server emitted `http://localhost/Lookup?...$skip=100` (no :60812) → a blind fetch hits port 80 → fails.
    // (URL.toString normalizes the apostrophe to %27 — the server decodes it identically, so this is harmless.)
    const next = "http://localhost/Lookup?$filter=LookupName%20eq%20'Country'&$skip=100";
    const req = "http://localhost:60812/Lookup?$filter=LookupName%20eq%20'Country'";
    const out = new URL(rebaseNextLink(next, req));
    expect(out.host).toBe('localhost:60812');
    expect(out.pathname).toBe('/Lookup');
    expect(out.searchParams.get('$skip')).toBe('100');
    expect(out.searchParams.get('$filter')).toBe("LookupName eq 'Country'");
  });

  it('swaps an entirely different host/proxy origin (and clears its port) for the one we queried', () => {
    expect(rebaseNextLink('http://internal-proxy:9000/Property?$skip=2', 'https://api.example.com/Property')).toBe(
      'https://api.example.com/Property?$skip=2',
    );
  });

  it('resolves a relative nextLink against the request origin', () => {
    expect(rebaseNextLink('/Lookup?$skip=100', 'http://localhost:60812/Lookup')).toBe('http://localhost:60812/Lookup?$skip=100');
  });

  it('returns the nextLink as-is when the request base is unparseable (caller attempts it)', () => {
    expect(rebaseNextLink('/Lookup?$skip=100', 'not-a-valid-base-url')).toBe('/Lookup?$skip=100');
  });
});
