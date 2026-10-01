/**
 * What a `200`-with-zero-rows means for a filter scenario, given the query was built from a value SAMPLED
 * from the field's OWN data.
 *
 * Because we own value selection (deriving from the provider's live data rather than a hand-filled config),
 * a positive operator over a value we KNOW is present is guaranteed to match ≥1 record — so an empty result
 * is the provider's operator misbehaving, not a bad test value:
 *
 * - **fail** — `eq` / `ge` / `le` / `in` / `has` / `any` against a sampled value (the value's own record must
 *   satisfy it), a `now()` comparison over a field we observed holding a past value, and a `-1`-sentinel `not`
 *   (`not(field le -1)` returns every record): a hit is mandatory, so empty = broken. The one exception is
 *   `lt/le now()` on a field whose sampled values are ALL in the future — see {@link EmptyContext.fieldHasPastValues}.
 * - **skip** — `all` (the record's whole collection must sit inside the set — legitimately often empty),
 *   `has A and has B` (needs both flags on one record — the two values may come from different records), and
 *   any compound `field op X and/or field op2 Y` filter (two conditions, legitimately often empty). BUT when the
 *   set is RECORD-DERIVED (`ctx.recordDerivedSet` — the query was built over one real record's own collection,
 *   which the operator is therefore guaranteed to return), that same `all` / `has A and has B` empty is a
 *   determinate **fail**: the guaranteeing record MUST come back. See {@link EmptyContext.recordDerivedSet}.
 * - **`ne` / `gt` / `lt`** against a value sampled from the field depend on the data (see {@link EmptyContext}).
 *   `ne` empties only if the field is single-valued; `gt`/`lt` compare against the sampled MIN/MAX, so they
 *   match only if a value exists beyond that bound. All three share the rule: ≥2 distinct sampled values →
 *   another value provably exists → **fail**; exactly one value across the COMPLETE resource → the empty
 *   result is correct → **pass**; one value but an incomplete sample → unknowable → **skip**.
 */

import type { CoreScenario } from './scenarios.js';

export type EmptyVerdict = 'fail' | 'pass' | 'skip';

/**
 * What the sampled data says about the field a `lt/le now()` scenario actually queried. A plain boolean cannot
 * express this: "no past value" and "no value at all" are different answers that must not share a branch, and an
 * `Array.some` over no values returns false for both. Conflating them would certify a field we never compared
 * anything on (Josh, 2026-10-01: "a set with null everything across the board that checks logically still
 * shouldn't be issued a cert, we didn't actually compare anything").
 *
 *  - `has-past`   — at least one sampled value is at or before now, so `lt/le now()` MUST return it.
 *  - `all-future` — at least one parseable value, every one of them strictly after now, so returning nothing is
 *                   the correct answer and the operator can still be certified on it.
 *  - `no-values`  — no parseable timestamp was sampled (all null, or unparseable). Nothing was compared, so there
 *                   is nothing to certify either way.
 */
export type NowFieldPastness = 'has-past' | 'all-future' | 'no-values';

/** Data the empty-result decision needs: distinct value count in the sample, whether the sample was the COMPLETE
 *  resource (no `@odata.nextLink` past it), and whether the operator's value set was RECORD-DERIVED. */
export interface EmptyContext {
  readonly distinctValueCount?: number;
  readonly complete?: boolean;
  /** True when an `all()` / `has A and has B` query was built over ONE real record's own collection (see
   *  queries.ts `recordDerivedSet`). That record is guaranteed to satisfy the filter, so an empty result is a
   *  determinate operator FAIL rather than the legitimately-empty skip. */
  readonly recordDerivedSet?: boolean;
  /** For a `lt/le now()` scenario: what the sampled data says about the field actually queried (see
   *  {@link NowFieldPastness}). Undefined keeps the strict reading — unknown never excuses a server. */
  readonly nowFieldPastness?: NowFieldPastness;
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
      if (scenario.valueParam === 'now') {
        // `ne now()` is satisfied by every value other than now, FUTURE values included, so it can never be
        // legitimately empty — a hit stays mandatory whatever the field holds.
        if (scenario.op === 'ne') return 'fail';
        // `lt/le now()` match only values at or before now, so what empty MEANS is decided by the field's own
        // sampled data. Sampling steers these two onto a field holding a past value whenever the resource has one
        // (`selectTimestampFieldForNow`); the other two cases are the residue for a resource where none does.
        switch (ctx.nowFieldPastness) {
          // Every sampled value is strictly in the future, so `lt/le now()` MUST return nothing. Over a COMPLETE
          // sample that is the whole resource, so empty is provably correct and the operator is certified — a real
          // PASS, not a skip. (The other direction needs no help here: if the server returns future-dated rows,
          // assertData's per-record check fails them.) Over a PARTIAL sample a past value may exist beyond it, so
          // empty is unknowable and must not be stamped correct.
          case 'all-future':
            return ctx.complete === true ? 'pass' : 'skip';
          // No parseable timestamp was sampled, so the filter compared nothing. Empty is neither the server's
          // defect nor evidence of conformance: never a pass, and never a fail either.
          case 'no-values':
            return 'skip';
          // `has-past`, or unknown: a value at or before now exists, so a hit is mandatory. Unknown stays strict —
          // it never excuses a server.
          default:
            return 'fail';
        }
      }
      // `eq/ge/le` against a value sampled from the field: the value's OWN record must satisfy it → guaranteed.
      // `gt/lt` compare against the sampled MIN/MAX, so a match exists only if the field holds a value beyond
      // that bound — the same data-dependent 3-way as `ne`: ≥2 distinct ⇒ another value provably exists ⇒
      // FAIL; a single-valued complete resource legitimately returns empty ⇒ PASS; otherwise SKIP.
      return scenario.op === 'gt' || scenario.op === 'lt' || scenario.op === 'ne' ? ne() : 'fail';
    case 'enum':
      if (scenario.op === 'ne') return ne();
      // has-and → skip UNLESS the two flags are record-derived (co-present on one record → guaranteed → fail);
      // has / eq → fail.
      return scenario.valueParam2 !== undefined ? (ctx.recordDerivedSet ? 'fail' : 'skip') : 'fail';
    case 'collection':
      // any → fail; all → skip UNLESS record-derived (record's own collection ⊆ the set → guaranteed → fail).
      if (scenario.lambda === 'any') return 'fail';
      return ctx.recordDerivedSet ? 'fail' : 'skip';
    case 'string-enum':
      if (scenario.op === 'ne') return ne();
      // eq / any → fail; all → skip UNLESS record-derived (guaranteed → fail).
      if (scenario.op === 'all') return ctx.recordDerivedSet ? 'fail' : 'skip';
      return 'fail';
    case 'in-operator':
      return 'fail';
    default:
      return 'skip'; // structural / orderby / paging / error / expand / lookup-resource — not gated here
  }
};
