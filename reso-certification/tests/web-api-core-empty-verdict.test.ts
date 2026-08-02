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
