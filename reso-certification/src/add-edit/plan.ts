import type { ScenarioName } from './types.js';

/**
 * What an Add/Edit run tests. RCP-010 lets a provider implement "as many or as few actions as makes sense for
 * their business case", and asks those being certified to "indicate whether they support `return=minimal` or
 * `return=representation` (or both) for each action being tested". So a run tests the actions and formats it is
 * given, and passing those is a pass. With none given it tests everything.
 */

/** The actions an Add/Edit run can test, in the order it tests them: a create comes first, so a later test can use it. */
export const ADD_EDIT_ACTIONS = ['create', 'update', 'delete'] as const;
export type AddEditAction = (typeof ADD_EDIT_ACTIONS)[number];

/** How a create or an update can answer: with the record, or with headers only (the `Prefer: return=` values). */
export const ADD_EDIT_FORMATS = ['representation', 'minimal'] as const;
export type AddEditFormat = (typeof ADD_EDIT_FORMATS)[number];

/** The actions that answer in a format. A delete answers with no record either way, so it has none. */
export const ADD_EDIT_FORMATTED_ACTIONS = ['create', 'update'] as const;
export type AddEditFormattedAction = (typeof ADD_EDIT_FORMATTED_ACTIONS)[number];

/** The formats to test, by action. An action left out tests both. */
export type AddEditFormats = Readonly<Partial<Record<AddEditFormattedAction, ReadonlyArray<AddEditFormat>>>>;

/** The six payloads, as the inline configuration names them. */
export type AddEditPayloadName = 'createSucceeds' | 'createFails' | 'updateSucceeds' | 'updateFails' | 'deleteSucceeds' | 'deleteFails';

/** Each action's two payloads: the one that should succeed and the one that should fail. */
export const ACTION_PAYLOADS: Readonly<Record<AddEditAction, readonly [AddEditPayloadName, AddEditPayloadName]>> = {
  create: ['createSucceeds', 'createFails'],
  update: ['updateSucceeds', 'updateFails'],
  delete: ['deleteSucceeds', 'deleteFails']
};

/** The file a payloads folder holds each payload in. */
export const PAYLOAD_FILES: Readonly<Record<AddEditPayloadName, string>> = {
  createSucceeds: 'create-succeeds.json',
  createFails: 'create-fails.json',
  updateSucceeds: 'update-succeeds.json',
  updateFails: 'update-fails.json',
  deleteSucceeds: 'delete-succeeds.json',
  deleteFails: 'delete-fails.json'
};

const SUCCEEDS_SCENARIO: Readonly<Record<AddEditFormattedAction, Readonly<Record<AddEditFormat, ScenarioName>>>> = {
  create: { representation: 'create-succeeds-representation', minimal: 'create-succeeds-minimal' },
  update: { representation: 'update-succeeds-representation', minimal: 'update-succeeds-minimal' }
};

const FAILS_SCENARIO: Readonly<Record<AddEditAction, ScenarioName>> = {
  create: 'create-fails',
  update: 'update-fails',
  delete: 'delete-fails'
};

/** What a run tests, once its actions and formats have been read. */
export interface AddEditTestPlan {
  readonly actions: ReadonlyArray<AddEditAction>;
  readonly formats: Readonly<Record<AddEditFormattedAction, ReadonlyArray<AddEditFormat>>>;
  /** The scenarios that follow, in the order they run. */
  readonly scenarios: ReadonlyArray<ScenarioName>;
}

export type AddEditPlanResult = { readonly plan: AddEditTestPlan } | { readonly problems: ReadonlyArray<string> };

const isAction = (value: unknown): value is AddEditAction => ADD_EDIT_ACTIONS.some(action => action === value);
const isFormat = (value: unknown): value is AddEditFormat => ADD_EDIT_FORMATS.some(format => format === value);
const isFormattedAction = (value: unknown): value is AddEditFormattedAction => ADD_EDIT_FORMATTED_ACTIONS.some(action => action === value);

const scenariosFor = (
  action: AddEditAction,
  formats: Readonly<Record<AddEditFormattedAction, ReadonlyArray<AddEditFormat>>>
): ReadonlyArray<ScenarioName> =>
  action === 'delete'
    ? ['delete-succeeds', FAILS_SCENARIO.delete]
    : [
        ...ADD_EDIT_FORMATS.filter(format => formats[action].includes(format)).map(format => SUCCEEDS_SCENARIO[action][format]),
        FAILS_SCENARIO[action]
      ];

const actionProblems = (actions: ReadonlyArray<unknown> | undefined): ReadonlyArray<string> => {
  if (actions === undefined) return [];
  if (actions.length === 0) return [`Choose at least one action: ${ADD_EDIT_ACTIONS.join(', ')}.`];
  const unknown = actions.filter(action => !isAction(action));
  return unknown.length > 0 ? [`Unknown action: ${unknown.join(', ')}. The actions are ${ADD_EDIT_ACTIONS.join(', ')}.`] : [];
};

const formatProblems = (
  formats: Readonly<Record<string, ReadonlyArray<unknown>>> | undefined,
  actions: ReadonlyArray<AddEditAction>
): ReadonlyArray<string> =>
  Object.entries(formats ?? {}).flatMap(([action, chosen]): ReadonlyArray<string> => {
    if (action === 'delete') return ['A delete has no format: it answers with no record either way.'];
    if (!isFormattedAction(action)) return [`Formats are chosen for ${ADD_EDIT_FORMATTED_ACTIONS.join(' and ')}, not "${action}".`];
    if (!actions.includes(action)) return [`Formats are chosen for ${action}, but ${action} is not among the actions.`];
    if (chosen.length === 0) return [`Choose at least one format for ${action}: ${ADD_EDIT_FORMATS.join(', ')}.`];
    const unknown = chosen.filter(format => !isFormat(format));
    return unknown.length > 0
      ? [`Unknown format for ${action}: ${unknown.join(', ')}. The formats are ${ADD_EDIT_FORMATS.join(', ')}.`]
      : [];
  });

/** Read the actions and formats a run was given into what it tests, or the reasons it cannot. */
export const planAddEditTests = (options: {
  readonly actions?: ReadonlyArray<unknown>;
  readonly formats?: Readonly<Record<string, ReadonlyArray<unknown>>>;
}): AddEditPlanResult => {
  const problemsWithActions = actionProblems(options.actions);
  if (problemsWithActions.length > 0) return { problems: problemsWithActions };
  // The canonical order, whatever order they were given in: a create runs first, so an update or a delete can use it.
  const actions = ADD_EDIT_ACTIONS.filter(action => (options.actions ?? ADD_EDIT_ACTIONS).includes(action));
  const problemsWithFormats = formatProblems(options.formats, actions);
  if (problemsWithFormats.length > 0) return { problems: problemsWithFormats };
  const chosen = (action: AddEditFormattedAction): ReadonlyArray<AddEditFormat> =>
    ADD_EDIT_FORMATS.filter(format => (options.formats?.[action] ?? ADD_EDIT_FORMATS).includes(format));
  const formats = { create: chosen('create'), update: chosen('update') };
  return { plan: { actions, formats, scenarios: actions.flatMap(action => scenariosFor(action, formats)) } };
};

/** The payloads a plan needs: each tested action's succeeds and fails payload. */
export const payloadsFor = (plan: AddEditTestPlan): ReadonlyArray<AddEditPayloadName> =>
  plan.actions.flatMap(action => ACTION_PAYLOADS[action]);

/** What a plan tests, in words: "create (representation, minimal), update (minimal), delete". */
export const describePlan = (plan: AddEditTestPlan): string =>
  plan.actions.map(action => (isFormattedAction(action) ? `${action} (${plan.formats[action].join(', ')})` : action)).join(', ');
