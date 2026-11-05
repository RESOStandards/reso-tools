/**
 * Shared building blocks for an endorsement's certification rule.
 *
 * Each endorsement states its own rule (see {@link ValidForCertification}); these are the pieces
 * it states that rule WITH. The distinction matters: a helper an endorsement calls is a rule it
 * declared, while a default it inherits is a rule nobody wrote. Being certifiable by omission is
 * the failure direction this whole mechanism exists to prevent, so nothing here is a default.
 */

import type { CertificationValidity, StepResult } from './types.js';

/** The eligible verdict, so every endorsement spells it the same way. */
export const CERTIFIABLE: CertificationValidity = { valid: true };

/** Not eligible, for the reasons given. Empty reasons would be a verdict with no explanation, so it is rejected. */
export const notCertifiable = (reasons: ReadonlyArray<string>): CertificationValidity => {
  if (reasons.length === 0) throw new Error('notCertifiable requires at least one reason: a run cannot be refused without saying why.');
  return { valid: false, reasons };
};

/**
 * Every step must have passed.
 *
 * `skipped` counts as not passing, and that is the whole point of this function. A step that did
 * not run verified nothing, so a run carrying one cannot be certified on its strength. Before this
 * existed, `deriveStatus` ignored `skipped` entirely, which meant a Data Dictionary run whose
 * reference metadata failed to load reported `passed` having validated no metadata at all.
 *
 * Where a step DID do its work and found nothing to do, it reports `passed` with a note rather than
 * skipping — the DD metadata step already does this for a server that serves no Lookup Resource,
 * appending "(no Lookup Resource)" to its summary. That convention is what keeps a vacuous pass
 * from arriving here as a skip, and it is worth preserving: a future step that models "nothing to
 * do" as a skip would start making legitimate runs ineligible.
 *
 * A step OMITTED from the pipeline array is a different thing again and is invisible here, because
 * it produces no StepResult at all. An endorsement that omits a step conditionally is choosing that
 * the step is not part of that run; if it should instead count against eligibility, it has to be
 * present and skipped, not absent.
 */
export const everyStepPassed = (steps: ReadonlyArray<StepResult>): CertificationValidity => {
  const notPassed = steps.filter(step => step.status !== 'passed');
  return notPassed.length === 0
    ? CERTIFIABLE
    : notCertifiable(notPassed.map(step => `${step.name}: ${step.status}${step.summary ? ` – ${step.summary}` : ''}`));
};

/**
 * Every condition must hold, and every reason from every failing condition is kept.
 *
 * Keeping all of them rather than short-circuiting on the first is deliberate: an operator fixing
 * one reason should not have to re-run to discover the next.
 */
export const allOf = (...conditions: ReadonlyArray<CertificationValidity>): CertificationValidity => {
  const reasons = conditions.flatMap(condition => (condition.valid ? [] : condition.reasons));
  return reasons.length === 0 ? CERTIFIABLE : notCertifiable(reasons);
};

/**
 * The count a step reports for the records it tested: received from the server (Data Dictionary), sampled from it (Web
 * API Core), read from the input (RESO Common Format), written and accepted (Add/Edit) or validated from its events
 * (EntityEvent). A step that tests records reports it whether it passed or failed.
 */
export const RECORDS_TESTED = 'recordsTested';

/** Why a run that tested no records cannot certify, in the words the provider sees. */
export const NO_RECORDS_TESTED =
  'No records were tested, so this system could not be certified. Certification needs at least one record from the system to check.';

/** Why a run that never counted what it tested cannot certify. */
export const RECORDS_NOT_REPORTED = 'The run did not report testing any records, so this system could not be certified.';

/**
 * At least one record was tested (Josh, 2026-11-04: "no Cert should work with 0 records across the board").
 *
 * Every endorsement composes this into its own rule. A run that tested nothing checked nothing, however clean its steps
 * look: a Data Dictionary run that received no records passed every step before this existed. No step reporting a
 * count is a refusal, never read as zero or as fine, and a count that is not a number is not a record.
 */
export const testedAtLeastOneRecord = (steps: ReadonlyArray<StepResult>): CertificationValidity => {
  const reported = steps.flatMap(step => {
    const count = step.counts?.[RECORDS_TESTED];
    return count === undefined ? [] : [count];
  });
  if (reported.length === 0) return notCertifiable([RECORDS_NOT_REPORTED]);
  return reported.reduce((total, count) => total + count, 0) > 0 ? CERTIFIABLE : notCertifiable([NO_RECORDS_TESTED]);
};

/**
 * Whether the version a run used can certify, from that standard's own reason (see `version-policy.ts`). RESO certifies
 * on the latest minor of a major, so a run on an older minor is a retest: it runs, and it does not certify.
 */
export const versionCertifies = (whyNot: string | undefined): CertificationValidity => (whyNot ? notCertifiable([whyNot]) : CERTIFIABLE);
