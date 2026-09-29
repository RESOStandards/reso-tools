/**
 * Identifiers for certification variations resources.
 *
 * These name the thing, not the mechanism acting on it — a report, or an environment's
 * canonical store. Locking is the first consumer and the one that forced the shape, but
 * the same identifier is what any other use would want: a notification about a report, an
 * audit entry, a permission attached to one.
 *
 * A lock is coordinated by string equality on an identifier and nothing else — there
 * is no requirement on what a lock may be taken on, and the table holding them is
 * shared with other resource kinds. That makes the identifier the entire contract,
 * and it is built independently by the certification service (to find a lock) and by
 * the review client (to take one). Drift between the two is silent: a lock exists
 * that nobody else can address, its holder believes they hold the resource, everyone
 * else sees it free, and both proceed. Nothing errors.
 *
 * Hence one definition, here, at the bottom of the dependency graph, imported by both
 * rather than written twice. Zero runtime deps and no Node or DOM APIs, so the browser
 * client can take it.
 *
 * ## Why URNs, and why these shapes
 *
 * The form follows the ARN discipline rather than any existing `urn:reso:` precedent:
 * every scoping dimension is a named position, and the resource type comes before the
 * identity so it selects which rules apply. Past the `urn:reso` stem, each sub-branch
 * is owned by different functionality and governs its own grammar — `metadata` by the
 * Web API payload context, `upi` by the property-identifier specification — so this
 * subtree owes its shape to neither, and the fact that a version means different things
 * under different branches is the delegation working rather than an ambiguity.
 *
 * Two dimensions are load-bearing and easy to leave out:
 *
 * - **The environment.** There is one locks table, the row carries no environment, and
 *   matching is string equality. Omit it and the same report in QA and in production is
 *   the same key, so a reviewer in one environment locks out a reviewer in the other.
 * - **The resource type.** The report lock and the canonical-store lock behave nothing
 *   alike: one is an editing session held by a person for hours and cleared when a new
 *   report replaces it, the other is a short critical section held by a handler around a
 *   write and released in a `finally`. They previously shared a prefix and were told
 *   apart by counting segments, which is how a validation check came to reject the
 *   canonical lock outright.
 *
 * The canonical form carries no version because the canonical store is not per-DD-version.
 * That is the namespace path determining the shape of what follows, not an inconsistency:
 * a reader who reaches `:report:` knows a version comes next, and one who reaches
 * `:canonical:` knows it does not.
 *
 * There is deliberately no scheme version. ARNs have none, and locks need none — every
 * lock expires on its TTL, so no identifier minted under an earlier grammar is ever read
 * back. That same property makes this format free to change at any time: no migration,
 * no backfill, no coordination beyond landing both callers together.
 */

/** The stem every certification variations lock identifier shares. Exported so a
 *  consumer can recognise one without re-deriving the prefix. */
export const VARIATIONS_URN_STEM = 'urn:reso:certification:variations';

/**
 * Guard against building a malformed identifier.
 *
 * This validates the *inputs to construction*, which is a different thing from
 * validating an identifier handed to us — the latter would impose a shape the system
 * does not require, and doing it is what broke the canonical lock once already.
 *
 * Both failure modes here are silent rather than loud, which is why they are worth
 * refusing. An empty coordinate yields an identifier with an empty position, so two
 * different resources missing the same coordinate collide on one key. A coordinate
 * containing the separator shifts every position after it, so one resource's identifier
 * can be read as another's — the same hazard as a positionally-bound statement whose
 * fields and values fall out of step.
 */
const assertSegment = (name: string, value: string): void => {
  if (!value) {
    throw new Error(`variations URN: ${name} is required; an empty position would collide with any other identifier missing it`);
  }
  if (value.includes(':')) {
    throw new Error(`variations URN: ${name} may not contain ':' — it would shift every position after it (got "${value}")`);
  }
};

/**
 * Identifier for a lock on one provider's variations report.
 *
 * Coordinates run broadest to narrowest, as in an ARN: environment, then the DD version
 * the report was produced against, then the provider, their system and the recipient.
 * The DD version is a scoping dimension of the report rather than the edition of some
 * catalog — a provider's 2.0 report and their 2.1 report are different reports and must
 * not share a lock.
 *
 * @throws if any coordinate is empty or contains the `:` separator.
 */
export const variationsReportUrn = (
  environmentName: string,
  ddVersion: string,
  providerUoi: string,
  providerUsi: string,
  recipientUoi: string
): string => {
  assertSegment('environmentName', environmentName);
  assertSegment('ddVersion', ddVersion);
  assertSegment('providerUoi', providerUoi);
  assertSegment('providerUsi', providerUsi);
  assertSegment('recipientUoi', recipientUoi);
  return `${VARIATIONS_URN_STEM}:report:${environmentName}:${ddVersion}:${providerUoi}:${providerUsi}:${recipientUoi}`;
};

/**
 * Identifier for the lock on an environment's canonical variations store.
 *
 * One store per environment, not per DD version, so the environment is the only
 * coordinate. Held briefly by a handler around a write rather than by a person, which is
 * why it is a separate type rather than a report lock with fields left out.
 *
 * @throws if the environment is empty or contains the `:` separator.
 */
export const variationsCanonicalStoreUrn = (environmentName: string): string => {
  assertSegment('environmentName', environmentName);
  return `${VARIATIONS_URN_STEM}:canonical:${environmentName}`;
};
