import { describe, it, expect } from 'vitest';
import { aggregateFieldType } from '../../src/rcf/aggregate.js';

describe('aggregateFieldType', () => {
  it('widens integers to the largest observed width', () => {
    expect(aggregateFieldType([1, 2, 40000])).toEqual({ type: 'Edm.Int32' });
    expect(aggregateFieldType([1, 5_000_000_000])).toEqual({ type: 'Edm.Int64' });
    expect(aggregateFieldType([1, 2, 3])).toEqual({ type: 'Edm.Int16' });
  });

  it('promotes an int + decimal mix to a Decimal spanning the widest int + deepest fraction', () => {
    // 12.5 has the widest integer part (2 digits); 3.456 the deepest scale (3) ⇒ precision 2+3 = 5.
    expect(aggregateFieldType([1, 12.5, 3.456])).toEqual({ type: 'Edm.Decimal', scale: 3, precision: 5 });
    // 12345 (5 integer digits) with 1.5 (scale 1) ⇒ precision 6 — independent maxes would give 2.
    expect(aggregateFieldType([12345, 1.5])).toEqual({ type: 'Edm.Decimal', scale: 1, precision: 6 });
  });

  it('takes the max length for strings', () => {
    expect(aggregateFieldType(['ab', 'abcd', 'a'])).toEqual({ type: 'Edm.String', maxLength: 4 });
  });

  it('keeps a homogeneous temporal type', () => {
    expect(aggregateFieldType(['2023-01-01', '2024-06-15'])).toEqual({ type: 'Edm.Date' });
    expect(aggregateFieldType(['2023-01-01T00:00:00Z'])).toEqual({ type: 'Edm.DateTimeOffset' });
  });

  it('boolean stays boolean', () => {
    expect(aggregateFieldType([true, false, true])).toEqual({ type: 'Edm.Boolean' });
  });

  it('marks nullable when any value is null or blank', () => {
    expect(aggregateFieldType(['a', null, 'bb'])).toEqual({ type: 'Edm.String', maxLength: 2, nullable: true });
    expect(aggregateFieldType([1, 2, ''])).toEqual({ type: 'Edm.Int16', nullable: true });
  });

  it('detects a collection and aggregates its elements', () => {
    expect(aggregateFieldType([['A', 'BB'], ['CCC']])).toEqual({ type: 'Edm.String', maxLength: 3, isCollection: true });
  });

  it('handles a large collection without overflowing the call stack (regression)', () => {
    // A collection whose flattened element count exceeds V8's argument-count limit (~125k):
    // `Math.max(0, ...elements)` overflowed here on a real 58k-record payload; `maxOf` reduces instead.
    const bigCollection = [Array.from({ length: 200_000 }, (_, i) => (i === 0 ? 'longeststring' : 'x'))];
    expect(aggregateFieldType(bigCollection)).toEqual({ type: 'Edm.String', maxLength: 13, isCollection: true });
  });

  it('detects nested objects as an expansion / custom type', () => {
    expect(aggregateFieldType([{ a: 1 }, { a: 2 }])).toEqual({ type: 'Custom Type', isExpansion: true });
  });

  it('a temporal + free-text mix falls back to Edm.String', () => {
    expect(aggregateFieldType(['2023-01-01', 'sometime last week'])).toEqual({ type: 'Edm.String', maxLength: 18 });
  });

  it('genuinely mixed incompatible types fall back to Edm.String', () => {
    expect(aggregateFieldType([1, 'text', true])).toEqual({ type: 'Edm.String' });
  });

  it('all-null/blank observations default to a nullable Edm.String', () => {
    expect(aggregateFieldType([null, '', '   '])).toEqual({ type: 'Edm.String', nullable: true });
  });
});
