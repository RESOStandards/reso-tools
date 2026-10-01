import { describe, expect, it } from 'vitest';
import { emptyVerdict } from '../src/web-api-core/empty-verdict.js';
import type { CoreScenario } from '../src/web-api-core/scenarios.js';

// Minimal scenario fixtures (only the fields emptyVerdict reads).
const filter = (op: string, extra: Record<string, unknown> = {}): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'filter', dataType: 'integer', op, fieldParam: 'integerField', valueParam: 'integerValueLow', minVersion: '2.0.0', ...extra }) as CoreScenario;
const enumS = (op: string, extra: Record<string, unknown> = {}): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'enum', enumType: 'single', op, fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.0.0', ...extra }) as CoreScenario;
const coll = (lambda: string): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'collection', lambda, fieldParam: 'multiLookupField', valueParam: 'multiLookupValue1', minVersion: '2.0.0' }) as CoreScenario;
const strEnum = (op: string, extra: Record<string, unknown> = {}): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'string-enum', enumType: 'single', op, fieldParam: 'singleLookupField', valueParam: 'singleLookupValue', minVersion: '2.1.0', ...extra }) as CoreScenario;
const inOp = (): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'in-operator', enumType: 'single', fieldParam: 'singleLookupField', valueParams: ['a', 'b'], minVersion: '2.1.0' }) as CoreScenario;
const structural = (): CoreScenario =>
  ({ tag: 't', name: 'n', category: 'structural', assertion: 'metadata', minVersion: '2.0.0' }) as CoreScenario;

const NONE = {};

describe('emptyVerdict — guaranteed-match operators fail on empty', () => {
  it('scalar eq / ge / le → fail (the sampled value’s own record must satisfy them)', () => {
    // gt/lt are NOT here — they compare against the sampled min/max and are data-gated like ne (see below).
    for (const op of ['eq', 'ge', 'le']) {
      expect(emptyVerdict(filter(op), NONE)).toBe('fail');
    }
  });
  it('any now() comparison (lt/le/ne now()) → fail (matches every past record)', () => {
    for (const op of ['lt', 'le', 'ne']) {
      expect(emptyVerdict(filter(op, { valueParam: 'now', dataType: 'datetime', fieldParam: 'timestampField' }), NONE)).toBe('fail');
    }
  });
  it('enum eq and single-value has → fail', () => {
    expect(emptyVerdict(enumS('eq'), NONE)).toBe('fail');
    expect(emptyVerdict(enumS('has'), NONE)).toBe('fail');
  });
  it('collection any, string-enum eq/any, in, and the sentinel not → fail', () => {
    expect(emptyVerdict(coll('any'), NONE)).toBe('fail');
    expect(emptyVerdict(strEnum('eq'), NONE)).toBe('fail');
    expect(emptyVerdict(strEnum('any'), NONE)).toBe('fail');
    expect(emptyVerdict(inOp(), NONE)).toBe('fail');
    expect(emptyVerdict(filter('ne', { negated: true }), NONE)).toBe('fail'); // not(field le -1)
  });
});

describe('emptyVerdict — legitimately-empty operators skip', () => {
  it('collection all and string-enum all → skip', () => {
    expect(emptyVerdict(coll('all'), NONE)).toBe('skip');
    expect(emptyVerdict(strEnum('all'), NONE)).toBe('skip');
  });
  it('enum has A and has B (two values) → skip', () => {
    expect(emptyVerdict(enumS('has', { valueParam2: 'multiLookupValue2' }), NONE)).toBe('skip');
  });
  it('compound filter (gt X and/or lt Y) → skip (two conditions, legitimately often empty)', () => {
    expect(emptyVerdict(filter('gt', { compound: { op2: 'lt', valueParam2: 'integerValueHigh', logical: 'and' } }), NONE)).toBe('skip');
    expect(emptyVerdict(filter('gt', { compound: { op2: 'lt', valueParam2: 'integerValueHigh', logical: 'or' } }), NONE)).toBe('skip'); // same branch — keys on scenario.compound, not the connector
  });
  it('non-filter scenarios (structural, etc.) → skip', () => {
    expect(emptyVerdict(structural(), NONE)).toBe('skip');
  });
});

describe('emptyVerdict — RECORD-DERIVED all() / has-and flips skip → fail (the guaranteeing record must return)', () => {
  it('collection all() over a record-derived set → fail on empty (was skip)', () => {
    expect(emptyVerdict(coll('all'), { recordDerivedSet: true })).toBe('fail');
    expect(emptyVerdict(coll('all'), NONE)).toBe('skip'); // arbitrary value → still legitimately-empty skip
  });
  it('string-enum all() over a record-derived set → fail on empty (was skip)', () => {
    expect(emptyVerdict(strEnum('all'), { recordDerivedSet: true })).toBe('fail');
    expect(emptyVerdict(strEnum('all'), NONE)).toBe('skip');
  });
  it('enum has A and has B over a record-derived (co-present) pair → fail on empty (was skip)', () => {
    const hasAnd = enumS('has', { valueParam2: 'multiLookupValue2' });
    expect(emptyVerdict(hasAnd, { recordDerivedSet: true })).toBe('fail');
    expect(emptyVerdict(hasAnd, NONE)).toBe('skip');
  });
  it('recordDerivedSet does NOT change guaranteed-match operators (any / eq) — they already fail', () => {
    expect(emptyVerdict(coll('any'), { recordDerivedSet: true })).toBe('fail');
    expect(emptyVerdict(strEnum('eq'), { recordDerivedSet: true })).toBe('fail');
    expect(emptyVerdict(enumS('has'), { recordDerivedSet: true })).toBe('fail'); // single has (no valueParam2)
  });
  it('recordDerivedSet is inert to ne / scalar / compound (never a record-derived set there)', () => {
    expect(emptyVerdict(enumS('ne'), { recordDerivedSet: true })).toBe('skip'); // ne with no distinct info → skip
    expect(emptyVerdict(filter('gt', { compound: { op2: 'lt', valueParam2: 'integerValueHigh', logical: 'and' } }), { recordDerivedSet: true })).toBe('skip');
  });
});

describe('emptyVerdict — ne / gt / lt depend on distinct count + completeness', () => {
  it('≥2 distinct → fail (the field provably holds another value beyond the sampled bound)', () => {
    expect(emptyVerdict(filter('ne'), { distinctValueCount: 3 })).toBe('fail');
    expect(emptyVerdict(filter('gt'), { distinctValueCount: 2 })).toBe('fail'); // gt sampledMin, another value above it
    expect(emptyVerdict(filter('lt'), { distinctValueCount: 2 })).toBe('fail'); // lt sampledMax, another value below it
    expect(emptyVerdict(enumS('ne'), { distinctValueCount: 2 })).toBe('fail');
    expect(emptyVerdict(strEnum('ne'), { distinctValueCount: 5, complete: false })).toBe('fail');
  });
  it('1 distinct + complete resource → pass (empty is the correct answer)', () => {
    expect(emptyVerdict(filter('ne'), { distinctValueCount: 1, complete: true })).toBe('pass');
    expect(emptyVerdict(enumS('ne'), { distinctValueCount: 1, complete: true })).toBe('pass');
  });
  it('THE REGRESSION FIX — single-valued field: gt/lt empty is correct, NEVER a false fail', () => {
    // A field with one distinct value across the COMPLETE resource: `field gt min` / `field lt max` legitimately
    // return nothing (no value beyond the bound). The old gate false-failed this; now it's pass (complete) / skip.
    expect(emptyVerdict(filter('gt'), { distinctValueCount: 1, complete: true })).toBe('pass');
    expect(emptyVerdict(filter('lt'), { distinctValueCount: 1, complete: true })).toBe('pass');
    expect(emptyVerdict(filter('gt'), { distinctValueCount: 1, complete: false })).toBe('skip');
    expect(emptyVerdict(filter('lt'), { distinctValueCount: 1 })).toBe('skip');
  });
  it('1 distinct + incomplete (or unknown) sample → skip', () => {
    expect(emptyVerdict(filter('ne'), { distinctValueCount: 1, complete: false })).toBe('skip');
    expect(emptyVerdict(enumS('ne'), { distinctValueCount: 1 })).toBe('skip');
  });
  it('no distinct info → skip (conservative) for ne / gt / lt', () => {
    expect(emptyVerdict(filter('ne'), NONE)).toBe('skip');
    expect(emptyVerdict(filter('gt'), NONE)).toBe('skip');
    expect(emptyVerdict(filter('lt'), NONE)).toBe('skip');
  });

  it('ne now() is a guaranteed match → fail, NOT the sampled-value distinct logic', () => {
    // The timestamp `ne now()` scenario compares against the query instant, not a sampled value; every record
    // differs from now(), so empty is a defect even for a single-distinct complete resource (which ne() would pass).
    const neNow = filter('ne', { valueParam: 'now', dataType: 'datetime', fieldParam: 'timestampField' });
    expect(emptyVerdict(neNow, { distinctValueCount: 1, complete: true })).toBe('fail');
    expect(emptyVerdict(neNow, NONE)).toBe('fail');
  });
});

// #315 / Josh, 2026-10-01: "lt-now and le-now would just be false on a future date, which is correct."
// A field whose sampled values are ALL in the future legitimately matches nothing for `lt/le now()`, so failing it
// false-fails a compliant server. `ne now()` is the exception that proves the rule: a future value IS ≠ now, so it
// matches, and an empty result there is still a real defect.
describe('emptyVerdict — lt/le now() over an all-future field is the server being right', () => {
  const nowFilter = (op: string) => filter(op, { valueParam: 'now', dataType: 'datetime', fieldParam: 'timestampField' });

  it('lt/le now() → SKIP when the queried field carried no past value', () => {
    for (const op of ['lt', 'le']) {
      expect(emptyVerdict(nowFilter(op), { fieldHasPastValues: false })).toBe('skip');
    }
  });

  it('lt/le now() → fail when the field DID carry a past value (a hit was mandatory)', () => {
    for (const op of ['lt', 'le']) {
      expect(emptyVerdict(nowFilter(op), { fieldHasPastValues: true })).toBe('fail');
    }
  });

  it('lt/le now() → fail when past-ness is UNKNOWN — fail-closed, unknown never excuses a server', () => {
    for (const op of ['lt', 'le']) {
      expect(emptyVerdict(nowFilter(op), NONE)).toBe('fail');
    }
  });

  it('ne now() → fail even on an all-future field: every value other than now satisfies it', () => {
    expect(emptyVerdict(nowFilter('ne'), { fieldHasPastValues: false })).toBe('fail');
  });

  it('the carve-out does not leak to a sampled-value datetime comparison', () => {
    // `lt datetimeValueMax` keeps the distinct-count logic; fieldHasPastValues is not consulted.
    const sampled = filter('lt', { dataType: 'datetime', fieldParam: 'timestampField', valueParam: 'datetimeValueMax' });
    expect(emptyVerdict(sampled, { fieldHasPastValues: false, distinctValueCount: 2 })).toBe('fail');
  });
});
