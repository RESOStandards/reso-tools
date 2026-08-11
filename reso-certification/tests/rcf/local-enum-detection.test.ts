import { describe, it, expect } from 'vitest';
import { stringFieldStats, classifyStringField, ENUM_MIN_SAMPLE } from '../../src/rcf/local-enum-detection.js';

describe('stringFieldStats', () => {
  it('keeps non-blank strings and counts total vs distinct', () => {
    expect(stringFieldStats(['A', 'B', 'A', 'C'])).toEqual({ total: 4, distinct: 3 });
  });
  it('drops null, undefined, and blank/whitespace strings', () => {
    expect(stringFieldStats(['A', 'A', '', '   ', null, undefined])).toEqual({ total: 2, distinct: 1 });
  });
  it('drops numeric-looking strings (numbers-as-strings are not enum members)', () => {
    expect(stringFieldStats(['1', '2', 'Residential', '3.5'])).toEqual({ total: 1, distinct: 1 });
  });
  it('ignores non-string values entirely', () => {
    expect(stringFieldStats([1, 2, true, 'Active', { a: 1 }])).toEqual({ total: 1, distinct: 1 });
  });
});

describe('classifyStringField — conservative enum-vs-free-text', () => {
  it('bounded + heavily repeating → enum', () => {
    expect(classifyStringField({ total: 100, distinct: 10 })).toBe('enum');
  });
  it('near-unique values → free text', () => {
    expect(classifyStringField({ total: 100, distinct: 95 })).toBe('free-text');
  });
  it('too small a sample → free text (no verdict on thin evidence)', () => {
    expect(classifyStringField({ total: 20, distinct: 5 })).toBe('free-text');
  });
  it('a single constant value → free text (not a useful enum)', () => {
    expect(classifyStringField({ total: 100, distinct: 1 })).toBe('free-text');
  });
  it('unbounded distinct set (> cap) → free text', () => {
    expect(classifyStringField({ total: 1000, distinct: 300 })).toBe('free-text');
  });

  describe('boundaries', () => {
    it(`exactly the min sample (${ENUM_MIN_SAMPLE}) with low ratio → enum`, () => {
      expect(classifyStringField({ total: ENUM_MIN_SAMPLE, distinct: 5 })).toBe('enum');
    });
    it('one below the min sample → free text', () => {
      expect(classifyStringField({ total: ENUM_MIN_SAMPLE - 1, distinct: 5 })).toBe('free-text');
    });
    it('distinct ratio exactly at the cutoff (0.5) → enum', () => {
      expect(classifyStringField({ total: 100, distinct: 50 })).toBe('enum');
    });
    it('distinct ratio just over the cutoff → free text', () => {
      expect(classifyStringField({ total: 100, distinct: 51 })).toBe('free-text');
    });
  });
});
