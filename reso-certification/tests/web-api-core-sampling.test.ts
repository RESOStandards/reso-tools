import { describe, expect, it } from 'vitest';
import { dateStats, integerNotSentinelFor, isSampleComplete, numericStats, selectTimestampField } from '../src/web-api-core/sampling.js';

// The `ne` empty-verdict may only rule "empty is correct / pass" when the sample WAS the whole resource.
// Core 2.1.0 signals "more results exist" with a forward @odata.nextLink, so its absence is our completeness proof.
describe('isSampleComplete — @odata.nextLink completeness', () => {
  it('is complete when the response carries no nextLink (the whole resource fit in the page)', () => {
    expect(isSampleComplete({ value: [{ a: 1 }] })).toBe(true);
    expect(isSampleComplete({ value: [] })).toBe(true); // empty-but-valid resource is fully sampled
  });

  it('is INCOMPLETE when a nextLink points past the sampled page', () => {
    expect(isSampleComplete({ value: [{ a: 1 }], '@odata.nextLink': 'https://x/Property?$skip=1000' })).toBe(false);
  });

  it('treats an explicit null nextLink as complete (no further pages)', () => {
    expect(isSampleComplete({ value: [{ a: 1 }], '@odata.nextLink': null })).toBe(true);
  });

  it('treats a null / absent body as incomplete (unknowable → conservative skip, never a false pass)', () => {
    expect(isSampleComplete(null)).toBe(false);
    expect(isSampleComplete(undefined)).toBe(false);
  });
});

// `not(field le sentinel)` must return every record. The sentinel therefore has to sit strictly below the
// field's floor — -1 for the non-negative fields Josh cited (beds/baths/price), lower still for a signed one.
describe('integerNotSentinelFor — the not() sentinel sits below the field floor', () => {
  it('is exactly -1 for a non-negative field (the old Commander value)', () => {
    expect(integerNotSentinelFor([3, 1, 4, 1, 5])).toBe(-1); // min 1 → clamp to -1
    expect(integerNotSentinelFor([0, 2, 4])).toBe(-1); // min 0 → 0-1 = -1
  });

  it('drops below the sampled minimum for a signed field so not() still matches all', () => {
    expect(integerNotSentinelFor([-5, -2, 3])).toBe(-6); // min -5 → -6, which is < every record
  });

  it('is undefined when there are no finite values (its scenario is skipped)', () => {
    expect(integerNotSentinelFor([])).toBeUndefined();
    expect(integerNotSentinelFor([null, undefined, 'x'])).toBeUndefined();
  });
});

// gt uses min, lt uses max; the empty-verdict gates them on distinct. Getting min/max/distinct right is what
// makes `gt min`/`lt max` provably non-empty at ≥2 distinct and correctly empty (skip/pass) when single-valued.
describe('numericStats — min / max / median and NUMERIC distinct dedup', () => {
  it('reports min, max, median over the distinct sampled values', () => {
    const s = numericStats([5, 1, 3, 3, 2, 4])!;
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.distinct).toBe(5); // 1,2,3,4,5
  });

  it('dedups NUMERICALLY so IEEE754Compatible string forms of one value count once (fixes ne overcount)', () => {
    // "100" and "100.00" are one numeric value — a numerically single-valued field must report distinct 1,
    // so its `ne`/`gt`/`lt` empty is skip/pass, never a false fail.
    const s = numericStats(['100', '100.00', '100.000'])!;
    expect(s.distinct).toBe(1);
    expect(s.min).toBe(100);
    expect(s.max).toBe(100);
  });

  it('drops non-finite values and returns undefined when nothing finite remains', () => {
    expect(numericStats(['abc', null, undefined])).toBeUndefined();
    expect(numericStats([])).toBeUndefined();
    expect(numericStats([NaN, Number.POSITIVE_INFINITY, 7]).distinct).toBe(1); // only 7 survives
  });
});

describe('dateStats — chronological min / max and date-only dedup', () => {
  it('takes the earliest as min and latest as max, normalizing datetime-shaped values', () => {
    const s = dateStats(['2024-06-15T10:00:00Z', '2024-01-01', '2024-12-31', '2024-06-15'])!;
    expect(s.min).toBe('2024-01-01');
    expect(s.max).toBe('2024-12-31');
    expect(s.distinct).toBe(3); // 2024-01-01, 2024-06-15 (both forms collapse), 2024-12-31
  });
});

describe('selectTimestampField — grounds the now() scenarios on an always-<=-now field (F1)', () => {
  it('prefers ModificationTimestamp even when a future-dated datetime is populated first', () => {
    // OpenHouse-style: a future-dated field leads the datetime list; picking it would false-fail `lt now()`.
    const datetimeFields = ['OpenHouseStartTime', 'OpenHouseEndTime', 'ModificationTimestamp'];
    const records = [
      { OpenHouseStartTime: '2099-06-01T10:00:00Z', OpenHouseEndTime: '2099-06-01T12:00:00Z', ModificationTimestamp: '2026-01-01T00:00:00Z' },
      { OpenHouseStartTime: '2099-07-01T10:00:00Z', OpenHouseEndTime: '2099-07-01T12:00:00Z', ModificationTimestamp: '2026-02-01T00:00:00Z' },
    ];
    expect(selectTimestampField(datetimeFields, records)).toBe('ModificationTimestamp');
  });

  it('falls back to another standard *Timestamp field when ModificationTimestamp is absent', () => {
    // ShowingStartTime is future-dated (ends in "Time", not "Timestamp") → excluded; OriginalEntryTimestamp wins.
    const datetimeFields = ['ShowingStartTime', 'OriginalEntryTimestamp'];
    const records = [{ ShowingStartTime: '2099-06-01T10:00:00Z', OriginalEntryTimestamp: '2026-01-01T00:00:00Z' }];
    expect(selectTimestampField(datetimeFields, records)).toBe('OriginalEntryTimestamp');
  });

  it('falls back to another *Timestamp when ModificationTimestamp is present but unpopulated', () => {
    const datetimeFields = ['ModificationTimestamp', 'PhotosChangeTimestamp'];
    const records = [{ ModificationTimestamp: null, PhotosChangeTimestamp: '2026-01-01T00:00:00Z' }];
    expect(selectTimestampField(datetimeFields, records)).toBe('PhotosChangeTimestamp');
  });

  it('last resort: a generic populated datetime when the resource has no *Timestamp field', () => {
    const datetimeFields = ['SomeLocalDateTime'];
    const records = [{ SomeLocalDateTime: '2026-01-01T00:00:00Z' }];
    expect(selectTimestampField(datetimeFields, records)).toBe('SomeLocalDateTime');
  });

  it('returns undefined when no datetime field is populated', () => {
    expect(selectTimestampField(['ModificationTimestamp'], [{ ModificationTimestamp: null }])).toBeUndefined();
  });
});
