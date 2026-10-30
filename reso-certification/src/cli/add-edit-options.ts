import { planAddEditTests } from '../add-edit/plan.js';
import type { AddEditConfig } from '../sdk/types.js';

/** The command-line flags that choose what an Add/Edit run tests. */
export interface AddEditSelectionFlags {
  readonly actions?: string;
  readonly createFormats?: string;
  readonly updateFormats?: string;
}

/** A comma-separated option as a list, or undefined when it was not given. An empty list is the plan's to refuse. */
export const listOption = (value: string | undefined): ReadonlyArray<string> | undefined =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map(item => item.trim())
        .filter(item => item !== '');

/**
 * The actions and formats the flags select, read by the rules the run applies, or the reasons they cannot run. Only
 * what was given is carried, so an entry's own selection stands where a flag says nothing.
 */
export const addEditSelectionOf = (opts: AddEditSelectionFlags): Pick<AddEditConfig, 'actions' | 'formats'> => {
  const actions = listOption(opts.actions);
  const create = listOption(opts.createFormats);
  const update = listOption(opts.updateFormats);
  const planned = planAddEditTests({
    ...(actions ? { actions } : {}),
    formats: { ...(create ? { create } : {}), ...(update ? { update } : {}) }
  });
  if ('problems' in planned) throw new Error(planned.problems.join(' '));
  const { plan } = planned;
  return {
    ...(actions ? { actions: plan.actions } : {}),
    ...(create || update
      ? { formats: { ...(create ? { create: plan.formats.create } : {}), ...(update ? { update: plan.formats.update } : {}) } }
      : {})
  };
};
