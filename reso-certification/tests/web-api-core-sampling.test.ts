import { describe, expect, it } from 'vitest';
import {
  dateStats,
  integerNotSentinelFor,
  isSampleComplete,
  modificationTimestampWarning,
  nowFieldPastnessFor,
  numericStats,
  rankDatetimeFields,
  selectTimestampField,
  selectTimestampFieldForNow
} from '../src/web-api-core/sampling.js';
import type { StandardMap } from '../src/web-api-core/standard-map.js';

// Only isStandardField matters to timestamp ranking; the value-level members are inert here.
const standardMapFor = (standardFields: ReadonlyArray<string>): StandardMap => ({
  isStandardField: (_resource, field) => standardFields.includes(field),
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
  standardValuesForField: () => undefined,
  isClosedEnumField: () => false
});

// A fixed "now" so past/future classification is deterministic.
const NOW = Date.parse('2026-06-01T00:00:00Z');
const PAST = '2026-01-01T00:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';

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
    expect(numericStats([Number.NaN, Number.POSITIVE_INFINITY, 7])?.distinct).toBe(1); // only 7 survives
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

describe('timestamp selection — the general slot (#315: standard-first, most-used, name-shape gone)', () => {
  it('prefers ModificationTimestamp even when a future-dated datetime is populated first', () => {
    // OpenHouse-style: a future-dated field leads the datetime list. ModificationTimestamp is RESO-required and is
    // the semantically correct change-tracking field, so it wins whenever it carries a value.
    const fields = ['OpenHouseStartTime', 'OpenHouseEndTime', 'ModificationTimestamp'];
    const records = [
      { OpenHouseStartTime: FUTURE, OpenHouseEndTime: FUTURE, ModificationTimestamp: PAST },
      { OpenHouseStartTime: FUTURE, OpenHouseEndTime: FUTURE, ModificationTimestamp: PAST }
    ];
    expect(selectTimestampField(fields, records, standardMapFor(fields), 'OpenHouse')).toBe('ModificationTimestamp');
  });

  it('ranks a DD-standard field ahead of a local one even when the local is FULLER', () => {
    // The filter precedes the ranking, exactly as for the scalar groups: usage never promotes a local field.
    const fields = ['LocalAuditTime', 'OriginalEntryTimestamp'];
    const records = [
      { LocalAuditTime: PAST, OriginalEntryTimestamp: PAST },
      { LocalAuditTime: PAST, OriginalEntryTimestamp: null }
    ];
    expect(selectTimestampField(fields, records, standardMapFor(['OriginalEntryTimestamp']), 'Property')).toBe('OriginalEntryTimestamp');
  });

  it('ranks the standard fields by usage among themselves', () => {
    const fields = ['PhotosChangeTimestamp', 'OriginalEntryTimestamp'];
    const records = [
      { PhotosChangeTimestamp: null, OriginalEntryTimestamp: PAST },
      { PhotosChangeTimestamp: PAST, OriginalEntryTimestamp: PAST }
    ];
    expect(rankDatetimeFields(fields, records, standardMapFor(fields), 'Property')).toEqual([
      'OriginalEntryTimestamp',
      'PhotosChangeTimestamp'
    ]);
  });

  it('no longer ranks on the field NAME: a local "*Timestamp" does not outrank a standard field without the suffix', () => {
    // The old implementation tested endsWith('Timestamp'), so a local MyCustomTimestamp ranked as though the DD
    // defined it. Standard-ness now comes from the DD reference only.
    const fields = ['MyCustomTimestamp', 'CloseDate'];
    const records = [{ MyCustomTimestamp: PAST, CloseDate: PAST }];
    expect(selectTimestampField(fields, records, standardMapFor(['CloseDate']), 'Property')).toBe('CloseDate');
  });

  it('may be a FUTURE-dated field — the nine non-now() scenarios work the same on it', () => {
    // Only lt/le now() need a past value. Excluding future-dated fields from the whole family would leave a
    // well-populated standard field untested.
    const fields = ['ShowingStartTime'];
    const records = [{ ShowingStartTime: FUTURE }, { ShowingStartTime: FUTURE }];
    expect(selectTimestampField(fields, records, standardMapFor(fields), 'Showing')).toBe('ShowingStartTime');
  });

  it('skips ModificationTimestamp when it is declared but unpopulated', () => {
    const fields = ['ModificationTimestamp', 'PhotosChangeTimestamp'];
    const records = [{ ModificationTimestamp: null, PhotosChangeTimestamp: PAST }];
    expect(selectTimestampField(fields, records, standardMapFor(fields), 'Property')).toBe('PhotosChangeTimestamp');
  });

  it('falls through to a local field when no standard one is populated', () => {
    const fields = ['SomeLocalDateTime'];
    const records = [{ SomeLocalDateTime: PAST }];
    expect(selectTimestampField(fields, records, standardMapFor([]), 'LocalResource')).toBe('SomeLocalDateTime');
  });

  it('returns undefined when no datetime field is populated', () => {
    expect(
      selectTimestampField(
        ['ModificationTimestamp'],
        [{ ModificationTimestamp: null }],
        standardMapFor(['ModificationTimestamp']),
        'Property'
      )
    ).toBeUndefined();
  });
});

describe('timestamp selection — the lt/le now() slot needs a field carrying a PAST value (#315)', () => {
  it('skips an all-future field for the now() slot even though it leads the general ranking', () => {
    const fields = ['ShowingStartTime', 'OriginalEntryTimestamp'];
    const records = [{ ShowingStartTime: FUTURE, OriginalEntryTimestamp: PAST }];
    const map = standardMapFor(fields);
    expect(selectTimestampField(fields, records, map, 'Showing')).toBe('ShowingStartTime');
    expect(selectTimestampFieldForNow(fields, records, map, 'Showing', NOW)).toBe('OriginalEntryTimestamp');
  });

  it('accepts a MIXED past/future field — lt now() returns its past rows, so the operator is testable', () => {
    // The criterion is "has a past value", not "is entirely past": a mixed field is a valid target.
    const fields = ['AuctionStartTime'];
    const records = [{ AuctionStartTime: FUTURE }, { AuctionStartTime: PAST }];
    expect(selectTimestampFieldForNow(fields, records, standardMapFor(fields), 'Property', NOW)).toBe('AuctionStartTime');
  });

  it('excludes a standard field that ENDS in Timestamp but holds only future values', () => {
    // InternetTrackingSummary.StartTimestamp / EndTimestamp are real DD fields: the name said "past", the data
    // says otherwise, which is why the suffix test had to go.
    const fields = ['StartTimestamp', 'EndTimestamp'];
    const records = [{ StartTimestamp: FUTURE, EndTimestamp: FUTURE }];
    expect(selectTimestampFieldForNow(fields, records, standardMapFor(fields), 'InternetTrackingSummary', NOW)).toBeUndefined();
  });

  it('is undefined when every datetime field on the resource is all-future (the verdict then stops asserting a hit)', () => {
    const fields = ['OpenHouseStartTime', 'OpenHouseEndTime'];
    const records = [{ OpenHouseStartTime: FUTURE, OpenHouseEndTime: FUTURE }];
    expect(selectTimestampFieldForNow(fields, records, standardMapFor(fields), 'OpenHouse', NOW)).toBeUndefined();
  });
});

describe('modificationTimestampWarning — reported, never failed by Core (#315)', () => {
  it('is undefined when ModificationTimestamp is present and populated', () => {
    expect(
      modificationTimestampWarning(['ModificationTimestamp'], [{ ModificationTimestamp: PAST }], 'Property', 'ModificationTimestamp')
    ).toBeUndefined();
  });

  it('warns and names the substitute when the resource does not declare it', () => {
    const w = modificationTimestampWarning(
      ['OriginalEntryTimestamp'],
      [{ OriginalEntryTimestamp: PAST }],
      'Property',
      'OriginalEntryTimestamp'
    );
    expect(w).toContain('does not declare it');
    expect(w).toContain("'OriginalEntryTimestamp'");
    expect(w).toContain('Data Dictionary');
  });

  it('distinguishes declared-but-unpopulated from not declared at all', () => {
    const w = modificationTimestampWarning(
      ['ModificationTimestamp', 'PhotosChangeTimestamp'],
      [{ ModificationTimestamp: null, PhotosChangeTimestamp: PAST }],
      'Property',
      'PhotosChangeTimestamp'
    );
    expect(w).toContain('sampled no value for it');
  });
});

// Drive resolveTestParams end to end for the pastness fields: a scripted single-page sample, all fields standard.
const sampleForPastness = async (records: ReadonlyArray<Record<string, unknown>>) => {
  const { resolveTestParams } = await import('../src/web-api-core/sampling.js');
  const names = [...new Set(records.flatMap(r => Object.keys(r)))].filter(n => n !== 'ListingKey');
  const entityType = {
    name: 'OpenHouse',
    keyProperties: ['ListingKey'],
    properties: [{ name: 'ListingKey', type: 'Edm.String' }, ...names.map(n => ({ name: n, type: 'Edm.DateTimeOffset' }))]
  };
  const page = { status: 200, headers: { 'odata-version': '4.01' }, body: { value: records }, rawBody: '' };
  return resolveTestParams('http://x', 'OpenHouse', entityType as never, 'tok', [], standardMapFor([...names]), undefined, {
    request: async () => page as never
  });
};

// The classifier that keeps "every value is in the future" apart from "there was nothing to compare". An
// Array.some returns false for both, and they demand opposite verdicts — the first certifies the operator, the
// second certifies nothing (Josh: a set of nulls that "checks out logically" must not be issued a cert).
describe('nowFieldPastnessFor — three states, never two (#315)', () => {
  it('has-past when sampling already steered the now() scenarios onto a past-capable field', () => {
    expect(nowFieldPastnessFor('ShowingStartTime', 'OriginalEntryTimestamp', [{ OriginalEntryTimestamp: PAST }], NOW)).toBe('has-past');
  });

  it('all-future when the queried field has parseable values and every one is after now', () => {
    const records = [{ OpenHouseStartTime: FUTURE }, { OpenHouseStartTime: FUTURE }];
    expect(nowFieldPastnessFor('OpenHouseStartTime', undefined, records, NOW)).toBe('all-future');
  });

  it('has-past when even ONE sampled value is at or before now — a mixed field is testable', () => {
    const records = [{ AuctionStartTime: FUTURE }, { AuctionStartTime: PAST }];
    expect(nowFieldPastnessFor('AuctionStartTime', undefined, records, NOW)).toBe('has-past');
  });

  it('no-values when the field is null across the board — the cert that must not be issued', () => {
    const records = [{ SomeTime: null }, { SomeTime: null }];
    expect(nowFieldPastnessFor('SomeTime', undefined, records, NOW)).toBe('no-values');
  });

  it('no-values when the field is POPULATED but holds nothing parseable as a timestamp', () => {
    // "populated" means some record is non-null, which is not the same as carrying a timestamp. A field serving
    // 'N/A' would otherwise read as all-future and pass on empty, having compared nothing.
    const records = [{ SomeTime: 'N/A' }, { SomeTime: 'unknown' }];
    expect(nowFieldPastnessFor('SomeTime', undefined, records, NOW)).toBe('no-values');
  });

  it('no-values when the resource has no timestamp field at all', () => {
    expect(nowFieldPastnessFor(undefined, undefined, [{ ListingKey: '1' }], NOW)).toBe('no-values');
  });

  it('ignores unparseable values alongside real ones rather than letting them mask the classification', () => {
    const records = [{ SomeTime: 'N/A' }, { SomeTime: PAST }];
    expect(nowFieldPastnessFor('SomeTime', undefined, records, NOW)).toBe('has-past');
  });
});

describe('resolveTestParams carries the pastness of the field the now() scenarios will query (#315)', () => {
  it('reports all-future for a resource whose only datetime field is future-dated', async () => {
    const params = await sampleForPastness([{ ListingKey: 'P1', OpenHouseStartTime: FUTURE }]);
    expect(params.timestampField).toBe('OpenHouseStartTime');
    expect(params.timestampFieldForNow).toBeUndefined();
    expect(params.nowFieldPastness).toBe('all-future');
  });

  it('reports has-past once any datetime field carries a past value', async () => {
    const params = await sampleForPastness([{ ListingKey: 'P1', OpenHouseStartTime: FUTURE, ModificationTimestamp: PAST }]);
    expect(params.nowFieldPastness).toBe('has-past');
  });
});
