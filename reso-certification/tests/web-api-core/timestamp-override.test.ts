import { describe, expect, it } from 'vitest';
import { parseFieldOverrides } from '../../src/web-api-core/field-override.js';
import { selectTimestampFields } from '../../src/web-api-core/sampling.js';
import type { StandardMap } from '../../src/web-api-core/standard-map.js';

/**
 * The timestamp slot defaults to ModificationTimestamp and a provider may name another, as the Commander's
 * `TimestampField` allowed (Josh, 2026-11-03: "we should always default to ModificationTimestamp but still let them
 * modify. DD tests the ModTS rule explicitly.").
 */

const standardMapFor = (standardFields: ReadonlyArray<string>): StandardMap => ({
  isStandardField: (_resource, field) => standardFields.includes(field),
  isStandardValue: () => false,
  standardValues: () => new Set<string>(),
  standardValuesForField: () => undefined,
  isClosedEnumField: () => false
});

const NOW = Date.parse('2026-06-01T00:00:00Z');
const FIELDS = ['ModificationTimestamp', 'OriginalEntryTimestamp', 'PhotosChangeTimestamp', 'LocalStamp'];
const RECORDS = [
  {
    ModificationTimestamp: '2026-01-01T00:00:00Z',
    OriginalEntryTimestamp: '2025-01-01T00:00:00Z',
    PhotosChangeTimestamp: '2099-01-01T00:00:00Z',
    LocalStamp: '2026-02-01T00:00:00Z'
  },
  {
    ModificationTimestamp: '2026-01-02T00:00:00Z',
    OriginalEntryTimestamp: '2025-01-02T00:00:00Z',
    PhotosChangeTimestamp: '2099-01-02T00:00:00Z',
    LocalStamp: '2026-02-01T00:00:00Z'
  }
];
const STANDARD = standardMapFor(['ModificationTimestamp', 'OriginalEntryTimestamp', 'PhotosChangeTimestamp']);
const select = (overrides: ReadonlyArray<string> = []) =>
  selectTimestampFields(FIELDS, RECORDS, STANDARD, 'Property', parseFieldOverrides(overrides), NOW);

describe('the timestamp field a run tests', () => {
  it('is ModificationTimestamp when no one names another', () => {
    expect(select()).toEqual({
      timestampField: 'ModificationTimestamp',
      timestampFieldForNow: 'ModificationTimestamp',
      appliedOverrides: []
    });
  });

  it('is the field a provider names, for every timestamp scenario, and the run records the override', () => {
    expect(select(['Property.OriginalEntryTimestamp'])).toEqual({
      timestampField: 'OriginalEntryTimestamp',
      timestampFieldForNow: 'OriginalEntryTimestamp',
      appliedOverrides: ['Property.OriginalEntryTimestamp']
    });
  });

  it.each([
    // Its now() comparisons would rightly return nothing and pass having compared nothing: the vacuous pass that kept
    // timestamps out of overriding on 2026-10-03.
    ['a field with no past value, on which lt now() and le now() could compare nothing', 'Property.PhotosChangeTimestamp'],
    ['a field with a single value, which cannot exercise the comparisons', 'Property.LocalStamp'],
    ['a field the resource does not have', 'Property.CloseTimestamp'],
    ['a field on another resource', 'Member.OriginalEntryTimestamp']
  ])('stays ModificationTimestamp for %s, and records no override', (_label, named) => {
    expect(select([named])).toEqual({
      timestampField: 'ModificationTimestamp',
      timestampFieldForNow: 'ModificationTimestamp',
      appliedOverrides: []
    });
  });
});
