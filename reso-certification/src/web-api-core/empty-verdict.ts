/**
 * What a `200`-with-zero-rows means for a filter scenario, given the query was built from a value SAMPLED
 * from the field's OWN data.
 *
 * Because we own value selection (deriving from the provider's live data rather than a hand-filled config),
 * a positive operator over a value we KNOW is present is guaranteed to match ≥1 record — so an empty result
 * is the provider's operator misbehaving, not a bad test value:
 *
 * - **fail** — `eq` / `ge` / `le` / `in` / `has` / `any` against a sampled value (the value's own record must
 *   satisfy it), any `now()` comparison (matches every past record), and a `-1`-sentinel `not` (`not(field le
 *   -1)` returns every record): a hit is mandatory, so empty = broken.
 * - **skip** — `all` (the record's whole collection must sit inside the set — legitimately often empty),
 *   `has A and has B` (needs both flags on one record — the two values may come from different records), and
 *   any compound `field op X and/or field op2 Y` filter (two conditions, legitimately often empty).
 * - **`ne` / `gt` / `lt`** against a value sampled from the field depend on the data (see {@link EmptyContext}).
 *   `ne` empties only if the field is single-valued; `gt`/`lt` compare against the sampled MIN/MAX, so they
 *   match only if a value exists beyond that bound. All three share the rule: ≥2 distinct sampled values →
 *   another value provably exists → **fail**; exactly one value across the COMPLETE resource → the empty
 *   result is correct → **pass**; one value but an incomplete sample → unknowable → **skip**.
 */

import type { CoreScenario } from './scenarios.js';

export type EmptyVerdict = 'fail' | 'pass' | 'skip';

/** Data the `ne` decision needs: distinct value count in the sample, and whether the sample was the COMPLETE
 *  resource (no `@odata.nextLink` past it). */
export interface EmptyContext {
  readonly distinctValueCount?: number;
  readonly complete?: boolean;
}

export const emptyVerdict = (scenario: CoreScenario, ctx: EmptyContext): EmptyVerdict => {
  const ne = (): EmptyVerdict => {
    const distinct = ctx.distinctValueCount ?? 0;
    if (distinct >= 2) return 'fail'; // the field has another value → `ne` must return it
    if (distinct === 1 && ctx.complete === true) return 'pass'; // whole resource is one value → empty is correct
    return 'skip'; // one value but the sample may be incomplete — unknowable
  };
  switch (scenario.category) {
    case 'filter':
      if (scenario.negated) return 'fail'; // `not(field le -1)` → every record → a hit is mandatory
      if (scenario.compound) return 'skip'; // `gt X and lt Y` — two conditions, legitimately often empty
      // Any `now()` comparison (`lt/le/ne now()`) matches every past record, so empty is a defect regardless
      // of the sampled data — a guaranteed match, not the distinct-count logic.
      if (scenario.valueParam === 'now') return 'fail';
      // `eq/ge/le` against a value sampled from the field: the value's OWN record must satisfy it → guaranteed.
      // `gt/lt` compare against the sampled MIN/MAX, so a match exists only if the field holds a value beyond
      // that bound — the same data-dependent 3-way as `ne`: ≥2 distinct ⇒ another value provably exists ⇒
      // FAIL; a single-valued complete resource legitimately returns empty ⇒ PASS; otherwise SKIP.
      return scenario.op === 'gt' || scenario.op === 'lt' || scenario.op === 'ne' ? ne() : 'fail';
    case 'enum':
      if (scenario.op === 'ne') return ne();
      return scenario.valueParam2 !== undefined ? 'skip' : 'fail'; // has-and → skip; has / eq → fail
    case 'collection':
      return scenario.lambda === 'any' ? 'fail' : 'skip'; // all → skip
    case 'string-enum':
      if (scenario.op === 'ne') return ne();
      return scenario.op === 'all' ? 'skip' : 'fail'; // eq / any → fail
    case 'in-operator':
      return 'fail';
    default:
      return 'skip'; // structural / orderby / paging / error / expand / lookup-resource — not gated here
  }
};
