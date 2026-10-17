import { describe, expect, it } from 'vitest';
import { overrideRenameNotice, removedPreferFields } from '../../src/cli/deprecations.js';

/**
 * `--prefer-fields` and `coreOptions.preferFields` were removed in 0.11.1 and replaced by
 * `--field-overrides` / `coreOptions.fieldOverrides`. The spelling is the smaller half of that change: the
 * behavior went from re-ordering a candidate list to REPLACING it, so a named field now owns its outcome and
 * fails its test instead of falling through to an automatic choice.
 *
 * The old value is deliberately NOT carried over. Rerouting it would apply the new binding behavior to a list
 * written for the old one, which changes what the run certifies without anyone looking. So the only job left
 * is to notice the old spelling and explain it, and these are the two functions that do that.
 *
 * They live under `src/cli/` because the engine and the SDK must not know the old names exist.
 */
describe('removedPreferFields', () => {
  it('reads the array shape a config file carries', () => {
    expect(removedPreferFields({ preferFields: ['Property.ListPrice', 'Office.FeedTypes'] })).toEqual([
      'Property.ListPrice',
      'Office.FeedTypes'
    ]);
  });

  it('also reads a STRING, which is the shape the old flag took', () => {
    // Read only the array form and a string-valued key goes through in silence: the run is fully automatic
    // and says nothing about the entry, which is the single outcome the notice exists to prevent.
    expect(removedPreferFields({ preferFields: 'Property.ListPrice,Office.FeedTypes' })).toEqual([
      'Property.ListPrice',
      'Office.FeedTypes'
    ]);
  });

  it('trims the spacing people actually type and drops blank entries', () => {
    expect(removedPreferFields({ preferFields: '  Property.ListPrice ,  , Office.FeedTypes  ' })).toEqual([
      'Property.ListPrice',
      'Office.FeedTypes'
    ]);
    expect(removedPreferFields({ preferFields: ['  ', ''] })).toEqual([]);
  });

  it('reports nothing for a config that never used the old key', () => {
    expect(removedPreferFields({ version: '2.1.0', fieldOverrides: ['Property.ListPrice'] })).toEqual([]);
    expect(removedPreferFields({})).toEqual([]);
  });

  it('is safe on every shape a hand-written config can actually be', () => {
    expect(removedPreferFields(undefined)).toEqual([]);
    expect(removedPreferFields(null)).toEqual([]);
    expect(removedPreferFields('nonsense')).toEqual([]);
    expect(removedPreferFields(42)).toEqual([]);
    expect(removedPreferFields({ preferFields: null })).toEqual([]);
    expect(removedPreferFields({ preferFields: 7 })).toEqual([]);
    expect(removedPreferFields({ preferFields: [1, 2, null] })).toEqual([]);
  });
});

describe('overrideRenameNotice', () => {
  const flagNotice = overrideRenameNotice('--prefer-fields', '--field-overrides', ['Property.ListPrice']);

  it('names what was ignored, so the operator can see their own entry', () => {
    expect(flagNotice).toContain('--prefer-fields was removed in 0.11.1');
    expect(flagNotice).toContain('Property.ListPrice');
  });

  it('names the replacement and its required form', () => {
    expect(flagNotice).toContain('--field-overrides');
    expect(flagNotice).toContain('Resource.Field');
    expect(flagNotice).toContain('bare field name is no longer accepted');
  });

  it('says the BEHAVIOR changed, not only the spelling', () => {
    // An operator who reads "renamed" retypes the same list and gets a run that certifies something
    // different from what their old list certified. That is the fact worth guarding.
    expect(flagNotice).toContain('REPLACES');
    expect(flagNotice).toMatch(/fails that test instead/);
  });

  it('says why the value was not carried over for them', () => {
    expect(flagNotice).toContain('not carried over');
    expect(flagNotice).toContain('what your run certifies');
  });

  it('carries no em dash, which the certification style check forbids in operator-facing text', () => {
    expect(flagNotice).not.toContain('—');
  });

  it('works for the config spelling with the same text, so the two paths cannot drift', () => {
    const configNotice = overrideRenameNotice('coreOptions.preferFields', 'coreOptions.fieldOverrides', ['Property.ListPrice']);
    expect(configNotice).toContain('coreOptions.preferFields was removed');
    expect(configNotice).toContain('coreOptions.fieldOverrides');
    // Everything after the first two lines is the shared explanation.
    expect(configNotice.split('\n').slice(2)).toEqual(flagNotice.split('\n').slice(2));
  });

  it('lists several ignored entries rather than only the first', () => {
    const notice = overrideRenameNotice('coreOptions.preferFields', 'coreOptions.fieldOverrides', ['A.B', 'C.D']);
    expect(notice).toContain('A.B, C.D');
  });
});
