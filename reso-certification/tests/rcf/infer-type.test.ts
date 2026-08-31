import { describe, it, expect } from 'vitest';
import { inferType, analyzeNumber, isValidIsoDate, isValidIsoDateTimeOffset } from '../../src/rcf/infer-type.js';

describe('analyzeNumber — integer width by range', () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [0, 'Edm.Int16'],
    [32767, 'Edm.Int16'],
    [-32768, 'Edm.Int16'],
    [32768, 'Edm.Int32'],
    [-32769, 'Edm.Int32'],
    [2147483647, 'Edm.Int32'],
    [-2147483648, 'Edm.Int32'],
    [2147483648, 'Edm.Int64'],
    [-2147483649, 'Edm.Int64'],
    [5_000_000_000, 'Edm.Int64'],
  ];
  it.each(cases)('%d → %s', (n, expected) => {
    expect(analyzeNumber(n)).toEqual({ type: expected });
  });
});

describe('analyzeNumber — decimals carry scale + precision', () => {
  it('123.45 → Decimal scale 2 precision 5', () => {
    expect(analyzeNumber(123.45)).toEqual({ type: 'Edm.Decimal', scale: 2, precision: 5 });
  });
  it('0.5 → Decimal scale 1 precision 2 (dot-removed digit count)', () => {
    expect(analyzeNumber(0.5)).toEqual({ type: 'Edm.Decimal', scale: 1, precision: 2 });
  });
  it('-12.5 → Decimal scale 1 precision 3 (sign ignored)', () => {
    expect(analyzeNumber(-12.5)).toEqual({ type: 'Edm.Decimal', scale: 1, precision: 3 });
  });
});

describe('isValidIsoDate', () => {
  it.each(['2023-01-15', '2000-02-29', '1999-12-31'])('accepts real date %s', d => {
    expect(isValidIsoDate(d)).toBe(true);
  });
  it.each([
    '2023-02-30', // not a real calendar day
    '2023-13-01', // month 13
    '2023-1-5', // not zero-padded
    '2023/01/15', // wrong separators
    '2023-01-15T00:00:00Z', // a datetime, not a date
    'Residential', // plain string
  ])('rejects %s', s => {
    expect(isValidIsoDate(s)).toBe(false);
  });
});

describe('isValidIsoDateTimeOffset', () => {
  it.each(['2023-01-15T10:30:00Z', '2023-01-15T10:30:00.123Z', '2023-01-15T10:30:00+05:00', '2023-01-15T10:30:00-08:00'])(
    'accepts %s',
    s => {
      expect(isValidIsoDateTimeOffset(s)).toBe(true);
    },
  );
  it.each([
    '2023-01-15T10:30:00', // no offset
    '2023-01-15', // date only
    '2023-13-15T10:30:00Z', // invalid month → NaN
    '2023-02-30T10:30:00Z', // impossible calendar date — Date.parse silently rolls Feb 30 over
    '2023-04-31T10:30:00Z', // April has 30 days
    'not-a-date',
  ])('rejects %s', s => {
    expect(isValidIsoDateTimeOffset(s)).toBe(false);
  });
  it('does not mis-type an impossible-calendar datetime as Edm.DateTimeOffset', () => {
    expect(inferType('2023-02-30T10:30:00Z')).toEqual({ type: 'Edm.String' });
  });
});

describe('inferType — scalars', () => {
  it('boolean → Edm.Boolean', () => expect(inferType(true)).toEqual({ type: 'Edm.Boolean' }));
  it('integer → Edm.Int16', () => expect(inferType(42)).toEqual({ type: 'Edm.Int16' }));
  it('decimal → Edm.Decimal', () => expect(inferType(1.25)).toEqual({ type: 'Edm.Decimal', scale: 2, precision: 3 }));
  it('ISO date string → Edm.Date', () => expect(inferType('2023-01-15')).toEqual({ type: 'Edm.Date' }));
  it('ISO datetime string → Edm.DateTimeOffset', () =>
    expect(inferType('2023-01-15T10:30:00Z')).toEqual({ type: 'Edm.DateTimeOffset' }));
  it('plain string → Edm.String', () => expect(inferType('Residential')).toEqual({ type: 'Edm.String' }));
  it('null → nullable null sentinel', () => expect(inferType(null)).toEqual({ type: 'null', nullable: true }));
  it('nested object → expansion candidate', () => expect(inferType({ a: 1 })).toEqual({ type: 'object', isExpansion: true }));
});

describe('inferType — collections', () => {
  it('array of scalars → isCollection, non-expansion', () => {
    expect(inferType([1, 2])).toEqual({
      isCollection: true,
      types: [{ type: 'Edm.Int16' }, { type: 'Edm.Int16' }],
      isExpansion: false,
    });
  });
  it('array of objects → isCollection + isExpansion', () => {
    expect(inferType([{ a: 1 }])).toEqual({
      isCollection: true,
      types: [{ type: 'object', isExpansion: true }],
      isExpansion: true,
    });
  });
  it('empty array → isCollection, no element types, non-expansion', () => {
    expect(inferType([])).toEqual({ isCollection: true, types: [], isExpansion: false });
  });
});
