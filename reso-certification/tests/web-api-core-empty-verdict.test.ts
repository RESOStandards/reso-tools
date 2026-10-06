import { describe, expect, it } from 'vitest';
import { emptyVerdict } from '../src/web-api-core/empty-verdict.js';
import type { CoreScenario } from '../src/web-api-core/scenarios.js';

// Minimal scenario fixtures (only the fields emptyVerdict reads).
const filter = (op: string, extra: Record<string, unknown> = {}): CoreScenario =>
  ({
    tag: 't',
    name: 'n',
    category: 'filter',
    dataType: 'integer',
    op,
    fieldParam: 'integerField',
    valueParam: 'integerValueLow',
    minVersion: '2.0.0',
    ...extra
  }) as CoreScenario;
const enumS = (op: string, extra: Record<string, unknown> = {}): CoreScenario =>
  ({
    tag: 't',
    name: 'n',
    category: 'enum',
    enumType: 'single',
    op,
    fieldParam: 'singleLookupField',
    valueParam: 'singleLookupValue',
    minVersion: '2.0.0',
    ...extra
  }) as CoreScenario;
const coll = (lambda: string): CoreScenario =>
  ({
    tag: 't',
    name: 'n',
    category: 'collection',
    lambda,
    fieldParam: 'multiLookupField',
    valueParam: 'multiLookupValue1',
    minVersion: '2.0.0'
  }) as CoreScenario;
const strEnum = (op: string, extra: Record<string, unknown> = {}): CoreScenario =>
  ({
    tag: 't',
    name: 'n',
    category: 'string-enum',
    enumType: 'single',
    op,
    fieldParam: 'singleLookupField',
    valueParam: 'singleLookupValue',
    minVersion: '2.1.0',
    ...extra
  }) as CoreScenario;
const inOp = (): CoreScenario =>
  ({
    tag: 't',
    name: 'n',
    category: 'in-operator',
    enumType: 'single',
    fieldParam: 'singleLookupField',
    valueParams: ['a', 'b'],
    minVersion: '2.1.0'
  }) as CoreScenario;
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
    expect(
      emptyVerdict(filter('gt', { compound: { op2: 'lt', valueParam2: 'integerValueHigh', logical: 'and' } }), { recordDerivedSet: true })
    ).toBe('skip');
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

// #315 / Josh, 2026-10-01. Two rulings, both about what an EMPTY result means for `lt/le now()`:
//   "lt-now and le-now would just be false on a future date, which is correct."  → empty must not fail there, and
//   because we can prove it, the operator is still certified: empty is a PASS.
//   "a set with null everything across the board that checks logically still shouldn't be issued a cert, we didn't
//   actually compare anything."                                                   → and that pass must never be
//   reachable when nothing was compared.
// `ne now()` is the exception that proves the rule: a future value IS != now, so it matches, and empty stays a defect.
describe('emptyVerdict — what empty means for lt/le now() is decided by the field\u2019s own sampled data', () => {
  const nowFilter = (op: string) => filter(op, { valueParam: 'now', dataType: 'datetime', fieldParam: 'timestampField' });

  it('has-past → fail: a value at or before now exists, so a hit was mandatory', () => {
    for (const op of ['lt', 'le']) {
      expect(emptyVerdict(nowFilter(op), { nowFieldPastness: 'has-past', complete: true })).toBe('fail');
    }
  });

  it('all-future over a COMPLETE sample → PASS: empty is provably the correct answer, so the operator is certified', () => {
    for (const op of ['lt', 'le']) {
      expect(emptyVerdict(nowFilter(op), { nowFieldPastness: 'all-future', complete: true })).toBe('pass');
    }
  });

  it('all-future over a PARTIAL sample → skip: a past value may exist beyond the sample, so empty is unknowable', () => {
    for (const op of ['lt', 'le']) {
      expect(emptyVerdict(nowFilter(op), { nowFieldPastness: 'all-future', complete: false })).toBe('skip');
      expect(emptyVerdict(nowFilter(op), { nowFieldPastness: 'all-future' })).toBe('skip');
    }
  });

  it('no-values → skip, NEVER pass, even over a complete sample: nothing was compared, so nothing is certified', () => {
    // The all-null (or unparseable) field. A filter over it returns empty and "checks out logically", which is
    // exactly the cert that must not be issued.
    for (const op of ['lt', 'le']) {
      expect(emptyVerdict(nowFilter(op), { nowFieldPastness: 'no-values', complete: true })).toBe('skip');
    }
  });

  it('unknown pastness → fail: unknown never excuses a server', () => {
    for (const op of ['lt', 'le']) {
      expect(emptyVerdict(nowFilter(op), NONE)).toBe('fail');
      expect(emptyVerdict(nowFilter(op), { complete: true })).toBe('fail');
    }
  });

  it('ne now() → fail in EVERY pastness state, including all-future and no-values', () => {
    // Every value other than now satisfies ne, future ones included, so it can never be legitimately empty.
    for (const pastness of ['has-past', 'all-future', 'no-values'] as const) {
      expect(emptyVerdict(nowFilter('ne'), { nowFieldPastness: pastness, complete: true })).toBe('fail');
    }
  });

  it('the carve-out does not leak to a sampled-value datetime comparison', () => {
    // `lt datetimeValueMax` keeps the distinct-count logic; pastness is not consulted.
    const sampled = filter('lt', { dataType: 'datetime', fieldParam: 'timestampField', valueParam: 'datetimeValueMax' });
    expect(emptyVerdict(sampled, { nowFieldPastness: 'all-future', complete: true, distinctValueCount: 2 })).toBe('fail');
  });

  it('the carve-out does not leak to a non-datetime now-less filter', () => {
    expect(emptyVerdict(filter('eq'), { nowFieldPastness: 'all-future', complete: true })).toBe('fail');
  });
});
