import { describe, expect, it } from 'vitest';
import { type AddEditTestPlan, describePlan, payloadsFor, planAddEditTests } from '../src/add-edit/plan.js';

/**
 * RCP-010 lets a provider implement "as many or as few actions as makes sense for their business case", and asks
 * those being certified to say which of `return=minimal` and `return=representation` they support "for each action
 * being tested". A run tests what it is given.
 */

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

describe('what an Add/Edit run tests', () => {
  it('tests every action in both formats when it is given none, as it always has', () => {
    const plan = planOf({});
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
    expect(payloadsFor(planOf({ actions: ['create'] }))).toEqual(['createSucceeds', 'createFails']);
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
    expect(planOf({ actions: ['delete', 'update', 'create', 'delete'] }).actions).toEqual(['create', 'update', 'delete']);
  });

  it('refuses what it cannot test, and says what', () => {
    expect(problemsOf({ actions: [] })).toContain('Choose at least one action');
    expect(problemsOf({ actions: ['patch'] })).toContain('Unknown action: patch');
    expect(problemsOf({ formats: { delete: ['minimal'] } })).toContain('A delete has no format');
    expect(problemsOf({ actions: ['create'], formats: { update: ['minimal'] } })).toContain('update is not among the actions');
    expect(problemsOf({ formats: { create: [] } })).toContain('Choose at least one format for create');
    expect(problemsOf({ formats: { create: ['full'] } })).toContain('Unknown format for create: full');
    expect(problemsOf({ formats: { read: ['minimal'] } })).toContain('not "read"');
  });
});
