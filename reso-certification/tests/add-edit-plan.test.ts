import { describe, expect, it } from 'vitest';
import { type AddEditTestPlan, describePlan, payloadsFor, planAddEditTests, readAddEditSelection } from '../src/add-edit/plan.js';

/**
 * RCP-010 lets a provider implement "as many or as few actions as makes sense for their business case", and asks
 * those being certified to say which of `return=minimal` and `return=representation` they support "for each action
 * being tested". A run tests what it is given, and nothing by default (Josh, 2026-11-03).
 */

const BOTH = ['representation', 'minimal'];

type PlanOptions = Parameters<typeof planAddEditTests>[0];

const planOf = (options: PlanOptions): AddEditTestPlan => {
  const planned = planAddEditTests(options);
  if ('problems' in planned) throw new Error(planned.problems.join(' '));
  return planned.plan;
};

const problemsOf = (options: PlanOptions): string => {
  const planned = planAddEditTests(options);
  return 'problems' in planned ? planned.problems.join(' ') : 'no problem';
};

/** What the lenient reader says of a partial selection, such as flags over a configuration. */
const selectionProblemsOf = (options: PlanOptions): string => {
  const read = readAddEditSelection(options);
  return 'problems' in read ? read.problems.join(' ') : 'no problem';
};

describe('what an Add/Edit run tests', () => {
  // Josh, 2026-11-03: running everything "could have unintended side effects, they may not expect us to try and delete
  // something". So a run is told what to test.
  it('tests nothing it is not told to: the actions are required, and the formats of a create or an update', () => {
    expect(problemsOf({})).toContain('Choose the actions to test: create, update, delete. Nothing is tested unless it is chosen.');
    expect(problemsOf({ formats: { create: BOTH } })).toContain('Choose the actions to test');
    expect(problemsOf({ actions: ['create', 'update', 'delete'] })).toBe(
      'Choose the create responses to test: representation, minimal. Choose the update responses to test: representation, minimal.'
    );
    expect(problemsOf({ actions: ['create', 'delete'], formats: { create: BOTH } })).toBe('no problem');
    expect(problemsOf({ actions: ['delete'] })).toBe('no problem');
  });

  it('tests every action in both formats when it is told to', () => {
    const plan = planOf({ actions: ['create', 'update', 'delete'], formats: { create: BOTH, update: BOTH } });
    expect(plan.scenarios).toEqual([
      'create-succeeds-representation',
      'create-succeeds-minimal',
      'create-fails',
      'update-succeeds-representation',
      'update-succeeds-minimal',
      'update-fails',
      'delete-succeeds',
      'delete-fails'
    ]);
    expect(payloadsFor(plan)).toHaveLength(6);
  });

  it('tests only the actions it is given, each as its succeeds and its fails test', () => {
    expect(planOf({ actions: ['delete'] }).scenarios).toEqual(['delete-succeeds', 'delete-fails']);
    expect(payloadsFor(planOf({ actions: ['create'], formats: { create: ['minimal'] } }))).toEqual(['createSucceeds', 'createFails']);
  });

  it('tests only the formats it is given for each action, and a delete has none', () => {
    const plan = planOf({ actions: ['create', 'update', 'delete'], formats: { create: ['minimal'], update: ['representation'] } });
    expect(plan.scenarios).toEqual([
      'create-succeeds-minimal',
      'create-fails',
      'update-succeeds-representation',
      'update-fails',
      'delete-succeeds',
      'delete-fails'
    ]);
    expect(describePlan(plan)).toBe('create (minimal), update (representation), delete');
  });

  it('runs a create first, whatever order the actions came in, so an update or a delete can use its record', () => {
    expect(planOf({ actions: ['delete', 'update', 'create', 'delete'], formats: { create: BOTH, update: BOTH } }).actions).toEqual([
      'create',
      'update',
      'delete'
    ]);
  });

  it('refuses what it cannot test, and says what', () => {
    expect(problemsOf({ actions: [] })).toContain('Choose at least one action');
    expect(problemsOf({ actions: ['patch'] })).toContain('Unknown action: patch');
    expect(problemsOf({ actions: ['create'], formats: { create: BOTH, update: ['minimal'] } })).toContain(
      'update is not among the actions'
    );
  });

  // A service that starts runs for others passes on what it was sent. A selection of the wrong shape is refused in
  // words, so that service answers with reasons rather than an exception.
  it.each([
    ['actions as a string', { actions: 'create' }, 'The actions must be a list'],
    ['actions as null', { actions: null }, 'The actions must be a list'],
    ['actions as an object', { actions: { create: true } }, 'The actions must be a list'],
    ['formats as a string', { actions: ['create'], formats: 'minimal' }, 'The formats must give a list'],
    ['formats as null', { actions: ['delete'], formats: null }, 'The formats must give a list'],
    ['formats as a list', { actions: ['create'], formats: ['minimal'] }, 'The formats must give a list'],
    ['a format as a string', { actions: ['create'], formats: { create: 'minimal' } }, 'The formats for create must be a list'],
    ['a format as null', { actions: ['create'], formats: { create: null } }, 'The formats for create must be a list']
  ])('refuses %s in words, and never throws', (_label, options, reason) => {
    const malformed = options as unknown as PlanOptions;
    expect(problemsOf(malformed)).toContain(reason);
    expect(selectionProblemsOf(malformed)).toContain(reason);
  });

  // The command line's flags are checked before a configuration supplies the rest, so only what they give is checked.
  it('reads a partial selection, checking only what it was given', () => {
    expect(selectionProblemsOf({})).toBe('no problem');
    expect(selectionProblemsOf({ formats: { update: ['minimal'] } })).toBe('no problem');
    expect(selectionProblemsOf({ formats: { delete: ['minimal'] } })).toContain('A delete has no format');
    expect(selectionProblemsOf({ formats: { create: [] } })).toContain('Choose at least one format for create');
    expect(selectionProblemsOf({ formats: { create: ['full'] } })).toContain('Unknown format for create: full');
    expect(selectionProblemsOf({ formats: { read: ['minimal'] } })).toContain('not "read"');
    expect(selectionProblemsOf({ actions: ['patch'] })).toContain('Unknown action: patch');
  });
});
