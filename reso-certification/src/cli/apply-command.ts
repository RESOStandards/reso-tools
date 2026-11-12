/**
 * `apply-variation-decisions`: the plan in lines a person reads before deciding to send it, and the outcome
 * after. Pure, so the wording is tested on its own; the Commander wiring is in `index.ts`.
 */

import type { ApplyPlan, PlannedItem } from '../variations/apply.js';

/** How a decision reads in the plan. `submit-to-ft` is the sheet's word; people say Fast Track. */
const DECISION_LABEL: Readonly<Record<string, string>> = { ignore: 'ignore', remove: 'remove', 'submit-to-ft': 'Fast Track' };

const decisionOf = (item: PlannedItem): string => (item.action ? (DECISION_LABEL[item.action] ?? item.action) : 'no decision');

/** One line per item: its decision, the element, what it replaces, and whether a comment goes with it. */
export const formatApplyItems = (plan: ApplyPlan): string => {
  const width = Math.max(0, ...plan.items.map(item => decisionOf(item).length));
  return plan.items
    .map(item => {
      const was = item.replaces ? ` (was ${DECISION_LABEL[item.replaces] ?? item.replaces})` : '';
      const pool = item.repairsPool ? `  (pool row had ${item.repairsPool})` : '';
      return `  ${decisionOf(item).padEnd(width)}  ${item.element}${was}${item.comment ? '  + comment' : ''}${pool}`;
    })
    .join('\n');
};

/** The plan in one sentence: how many items change, by decision, and how many comments go. */
export const summarizeApplyPlan = (plan: ApplyPlan): string => {
  const comments = plan.items.filter(item => item.comment).length;
  const decisions = ['ignore', 'remove', 'Fast Track', 'no decision']
    .map(label => [label, plan.items.filter(item => decisionOf(item) === label).length] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(', ');
  const repairs = plan.items.filter(item => item.repairsPool).length;
  return `${plan.items.length} item(s) to change (${decisions}), with ${comments} comment(s)${repairs ? `; ${repairs} of them to bring the review pool back in line with the report` : ''}.`;
};
