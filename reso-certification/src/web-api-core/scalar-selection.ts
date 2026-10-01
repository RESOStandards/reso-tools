/**
 * RESO-first scalar field selection for Web API Core sampling.
 *
 * The scalar counterpart to {@link ../web-api-core/enum-selection.ts enum-selection}: the Integer, Decimal and
 * Date groups used to pick the FIRST field of the type in metadata declaration order that carried enough
 * distinct sampled values, with no notion of a standard element. A provider whose metadata happens to declare a
 * local field first therefore certified the type on that local field — and when the server then rejected a
 * `$filter` on it, every scenario of the type failed on a field RESO never asked about (observed on a 2.1.0 run,
 * 2026-09-21: a local `Edm.Date` sorted first, the server answered 500, and all six Date scenarios failed while
 * standard Date fields with values sat on the same resource).
 *
 * Selection is therefore RESO-first — standard DD fields before local ones — and returns a RANKED LIST so the
 * runner can try the next candidate when a field is not queryable, rather than failing a provider on one
 * unlucky pick. A local field is reached only when no standard field serves.
 *
 * The comparison values always come from the chosen field's OWN sampled values, so they are type-correct for
 * that field by construction; the standard map is a ranking input, never a value source.
 */

import type { StandardMap } from './standard-map.js';

/** The default distinct-value floor. The `ne` / `gt` / `lt` verdicts need a second distinct value to prove the
 *  field holds one (so an empty result is a defect rather than the correct answer), and three keeps a median
 *  strictly inside the range. Matches the floor the previous `findBestField` applied. */
export const MIN_DISTINCT_VALUES = 3;

/** Min / median / max over a field's sampled values, plus the type-aware distinct count. Produced by the
 *  caller's own stats function (`numericStats` for Integer/Decimal, `dateStats` for Date), so the count is
 *  deduped the way that type requires — numerically for numerics, date-only for dates. */
export interface ScalarStats<V> {
  readonly min: V;
  readonly median: V;
  readonly max: V;
  readonly distinct: number;
}

/** A scalar field the runner can test, with its standard-ness and its own sampled statistics. */
export interface ScalarCandidate<V> {
  readonly field: string;
  /** True when the field is a standard DD field for its resource. */
  readonly isStandard: boolean;
  /** The field's distinct raw sampled values, in first-seen order. Kept raw because the `not()` sentinel
   *  (`integerNotSentinelFor`) derives from the untransformed values. */
  readonly values: ReadonlyArray<unknown>;
  /** The field's own min / median / max / distinct count — every scenario value for this candidate comes
   *  from here, so an alternate is never queried with the primary field's numbers. */
  readonly stats: ScalarStats<V>;
  /** Fraction of sampled records carrying a non-null value for this field (0–1). Josh's rule is
   *  "most-used standard elements first, and only then revert to highly populated locals"; the engine has no
   *  adoption data, so fill rate in the sample is what "most-used" means here. */
  readonly fillRate: number;
}

/** A field's distinct non-null sampled values (first-seen order) and how many records carried one. Distinct is
 *  keyed by `String(value)` — the type-aware dedup happens in the caller's stats function, which is what
 *  {@link ScalarCandidate.stats} reports; this count only drives the fill rate. */
export const collectFieldValues = (
  records: ReadonlyArray<Record<string, unknown>>,
  field: string
): { readonly values: ReadonlyArray<unknown>; readonly fillCount: number } => {
  // Local mutable accumulators, scoped to this function and never leaked — the returned arrays are readonly.
  const seen = new Set<string>();
  const values: unknown[] = [];
  let fillCount = 0;
  for (const record of records) {
    const value = record[field];
    if (value == null) continue;
    fillCount += 1;
    const key = String(value);
    if (!seen.has(key)) {
      seen.add(key);
      values.push(value);
    }
  }
  return { values, fillCount };
};

/**
 * Rank the testable fields of one scalar type for a resource, RESO-first.
 *
 * Two ranks, standard before local — a local field is reached only after every standard field has been tried.
 * Within a rank, a field carrying at least `minDistinct` distinct values comes first (the `ne` / `gt` / `lt`
 * verdicts need the second value to be provable), then the higher fill rate: a fuller field is likelier to
 * return a non-empty result and more resistant to record drift between sampling and the live query. The sort is
 * stable, so metadata declaration order remains the final tiebreak and selection stays deterministic.
 *
 * The list is deliberately uncapped. A provider may restrict `$filter` to a subset of its fields and reject the
 * rest, so a queryable field can sit at any rank; the runner walks the whole ladder and only reports an
 * operator gap when every candidate rejects it.
 */
export const selectScalarCandidates = <V>(
  fields: ReadonlyArray<string>,
  records: ReadonlyArray<Record<string, unknown>>,
  standardMap: StandardMap,
  resource: string,
  stats: (values: ReadonlyArray<unknown>) => ScalarStats<V> | undefined,
  minDistinct: number = MIN_DISTINCT_VALUES
): ReadonlyArray<ScalarCandidate<V>> => {
  const candidates = fields
    .map(field => {
      const { values, fillCount } = collectFieldValues(records, field);
      const fieldStats = values.length > 0 ? stats(values) : undefined;
      // No sampled value (or nothing the type's stats could use) — nothing to compare against, not testable.
      return fieldStats === undefined
        ? undefined
        : {
            field,
            isStandard: standardMap.isStandardField(resource, field),
            values,
            stats: fieldStats,
            fillRate: records.length > 0 ? fillCount / records.length : 0
          };
    })
    .filter((c): c is ScalarCandidate<V> => c !== undefined);

  const rank = (c: ScalarCandidate<V>): number => (c.isStandard ? 0 : 1);
  const hasEnough = (c: ScalarCandidate<V>): number => (c.stats.distinct >= minDistinct ? 0 : 1);
  return [...candidates].sort((a, b) => rank(a) - rank(b) || hasEnough(a) - hasEnough(b) || b.fillRate - a.fillRate);
};
