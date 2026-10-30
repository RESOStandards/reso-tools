import { describe, expect, it } from 'vitest';
import { addEditSelectionOf, listOption } from '../../src/cli/add-edit-options.js';

/** The flags that choose what `reso-cert add-edit` tests, read by the same rules the run applies. */
describe('the Add/Edit selection flags', () => {
  it('carry only what was given, in the order the run tests it', () => {
    expect(addEditSelectionOf({})).toEqual({});
    expect(addEditSelectionOf({ actions: 'delete, create' })).toEqual({ actions: ['create', 'delete'] });
    expect(addEditSelectionOf({ createFormats: 'minimal' })).toEqual({ formats: { create: ['minimal'] } });
    expect(addEditSelectionOf({ actions: 'update', updateFormats: 'minimal,representation' })).toEqual({
      actions: ['update'],
      formats: { update: ['representation', 'minimal'] }
    });
  });

  it('refuse a selection the run could not test, before anything starts', () => {
    expect(() => addEditSelectionOf({ actions: 'create', updateFormats: 'minimal' })).toThrow('update is not among the actions');
    expect(() => addEditSelectionOf({ actions: ' , ' })).toThrow('Choose at least one action');
    expect(() => addEditSelectionOf({ createFormats: 'full' })).toThrow('Unknown format for create: full');
  });

  it('read a comma-separated list, trimmed, with empty items dropped', () => {
    expect(listOption(undefined)).toBeUndefined();
    expect(listOption(' create, ,update ')).toEqual(['create', 'update']);
  });
});
