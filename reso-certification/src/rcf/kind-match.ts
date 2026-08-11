/**
 * Kind matching for RCF schema inference — recover the DD resource behind a
 * mis-named expansion from its *shape* (C4).
 *
 * Variations does NAME matching; this is KIND matching. When a provider sends a
 * nested expansion under the wrong name (e.g. `Rooms` for `PropertyRooms`,
 * `PowerProduction` for `PropertyPowerProduction`), the name gives nothing, but
 * the field set does: the presence of a resource's rare, resource-specific
 * fields (and its key field, and its enum values) identifies which resource the
 * shape actually is.
 *
 * Three channels, scored against every DD resource:
 *   1. idf-weighted field-name containment — Σ idf(f) over the observed fields
 *      that belong to the candidate. idf is computed over the reference itself,
 *      so a field in FEW resources carries more signal than one in many
 *      (`GreenBuildingVerificationType` discriminates; `ModificationTimestamp`
 *      does not). No per-field hand-tuning.
 *   2. key-field boost — the observed set contains `{Resource}Key` /
 *      `{Resource}KeyNumeric` (RESO convention; the reference carries no explicit
 *      key metadata).
 *   3. enum-value corroboration — observed values of a field overlap a candidate
 *      lookup field's DD values.
 *
 * CONSERVATIVE by design: a false match silently corrupts the inferred schema,
 * so a match is returned ONLY when the winner clears an absolute idf floor, a
 * containment floor, AND a margin over the runner-up. Otherwise `null` — the
 * caller keeps the expansion as a local object ("flag as objects"). Recall is
 * deliberately traded for precision.
 */

import type { ReferenceMap } from './assemble-report.js';

export interface KindMatchOptions {
  /** Absolute matched-idf floor — enough diagnostic mass must be matched. */
  readonly minMatchIdf: number;
  /** Matched idf as a fraction of the observed shape's known-idf mass — the winner must explain the shape. */
  readonly minContainment: number;
  /** Winner score must be ≥ marginRatio × runner-up score. */
  readonly marginRatio: number;
  /** idf-equivalent bonus when the observed set carries the candidate's `{Resource}Key`/`{Resource}KeyNumeric`. */
  readonly keyBonus: number;
  /** idf-equivalent bonus per unit of enum-value overlap (summed across corroborating lookup fields). */
  readonly enumBonus: number;
}

/**
 * Conservative defaults, calibrated against real RCF payloads. `minMatchIdf` requires corroboration
 * beyond a single diagnostic field: one resource-unique field maxes at idf ≈ ln(#resources) ≈ 3.26
 * (DD 1.7), so the floor sits above that. Observed on real data: true positives (power_production →
 * PropertyPowerProduction, energy scores → PropertyGreenVerification) score ≥ 18.6; the nearest
 * decline (a misspelled-field shape) sits at ≈ 2.6 — a wide, clean gap.
 */
export const DEFAULT_KIND_MATCH_OPTIONS: KindMatchOptions = {
  minMatchIdf: 6.0,
  minContainment: 0.4,
  marginRatio: 1.5,
  keyBonus: 2.0,
  enumBonus: 1.5,
};

export interface KindMatchInput {
  /** Field names observed on the expansion. */
  readonly fields: ReadonlyArray<string>;
  /** Observed string values per field, for the enum channel (optional). */
  readonly enumValuesByField?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * Resources the shape must NOT match — pass the PARENT resource. A nested object whose fields
   * are all the parent's own fields (a provider flattening artifact, e.g. `Structure` holding
   * `AboveGradeFinishedArea`/`GarageSpaces`) would otherwise "match" its own parent, which is a
   * self-expansion, never the intent of kind matching. idf is unaffected — only ranking excludes these.
   */
  readonly exclude?: ReadonlyArray<string>;
}

export interface KindMatch {
  /** The matched DD resource. */
  readonly resource: string;
  /** Combined evidence score (idf units). */
  readonly score: number;
  /** Matched idf as a fraction of the observed shape's known-idf mass, in [0, 1]. */
  readonly containment: number;
  /** score(winner) / score(runner-up); Infinity when there is no runner-up. */
  readonly margin: number;
  readonly signals: {
    readonly containmentIdf: number;
    readonly keyField: boolean;
    readonly enumOverlap: number;
  };
}

export interface KindMatcher {
  /** Best confident DD-resource match for a shape, or null (→ keep as a local object). */
  readonly match: (input: KindMatchInput) => KindMatch | null;
}

interface CandidateIndex {
  readonly resource: string;
  readonly fields: ReadonlySet<string>;
  readonly keyNames: ReadonlySet<string>;
  /** Lookup field → its set of valid DD values (display + legacy). */
  readonly lookups: Readonly<Record<string, ReadonlySet<string>>>;
}

const distinct = <T>(xs: ReadonlyArray<T>): ReadonlyArray<T> => [...new Set(xs)];

/** idf(f) = ln(N / df(f)); a field in every resource → 0, a field in one → ln(N). Unknown fields → 0. */
const buildIdf = (candidates: ReadonlyArray<CandidateIndex>): ((field: string) => number) => {
  const n = candidates.length;
  const df = new Map<string, number>();
  for (const c of candidates) for (const f of c.fields) df.set(f, (df.get(f) ?? 0) + 1);
  return (field: string): number => {
    const d = df.get(field) ?? 0;
    return d > 0 ? Math.log(n / d) : 0;
  };
};

const indexResource = (resource: string, fields: ReferenceMap[string]): CandidateIndex => {
  const lookups: Record<string, ReadonlySet<string>> = {};
  for (const [field, ref] of Object.entries(fields)) {
    if (!ref.isLookupField) continue;
    const values = new Set<string>([...Object.keys(ref.lookupValues ?? {}), ...Object.keys(ref.legacyODataValues ?? {})]);
    if (values.size > 0) lookups[field] = values;
  }
  return {
    resource,
    fields: new Set(Object.keys(fields)),
    keyNames: new Set([`${resource}Key`, `${resource}KeyNumeric`]),
    lookups,
  };
};

/** Enum-value overlap for a candidate: summed per-field fraction of observed values that are valid DD values. */
const enumOverlapFor = (candidate: CandidateIndex, input: KindMatchInput): number => {
  const byField = input.enumValuesByField;
  if (!byField) return 0;
  return Object.entries(byField).reduce((total, [field, observed]) => {
    const valid = candidate.lookups[field];
    if (!valid || observed.length === 0) return total;
    const seen = distinct(observed);
    const hits = seen.filter(v => valid.has(v)).length;
    return total + hits / seen.length;
  }, 0);
};

interface Scored {
  readonly candidate: CandidateIndex;
  readonly score: number;
  readonly containmentIdf: number;
  readonly keyField: boolean;
  readonly enumOverlap: number;
}

/**
 * Build a matcher over a DD reference map. The idf table and per-resource index are computed once and
 * reused across every expansion scored, so matching many shapes stays cheap.
 */
export const buildKindMatcher = (referenceMap: ReferenceMap, options: KindMatchOptions = DEFAULT_KIND_MATCH_OPTIONS): KindMatcher => {
  const candidates = Object.entries(referenceMap).map(([resource, fields]) => indexResource(resource, fields));
  const idf = buildIdf(candidates);

  const scoreCandidate = (candidate: CandidateIndex, fields: ReadonlyArray<string>, input: KindMatchInput): Scored => {
    const containmentIdf = fields.reduce((sum, f) => (candidate.fields.has(f) ? sum + idf(f) : sum), 0);
    const keyField = fields.some(f => candidate.keyNames.has(f));
    const enumOverlap = enumOverlapFor(candidate, input);
    const score = containmentIdf + (keyField ? options.keyBonus : 0) + options.enumBonus * enumOverlap;
    return { candidate, score, containmentIdf, keyField, enumOverlap };
  };

  const match = (input: KindMatchInput): KindMatch | null => {
    const fields = distinct(input.fields);
    if (fields.length === 0 || candidates.length === 0) return null;

    // Known-idf mass of the observed shape — the denominator for containment (unknown fields add nothing).
    const knownIdfMass = fields.reduce((sum, f) => sum + idf(f), 0);
    if (knownIdfMass <= 0) return null; // only generic/unknown fields — no resource-discriminating signal

    const excluded = new Set(input.exclude ?? []);
    const ranked = candidates
      .filter(c => !excluded.has(c.resource))
      .map(c => scoreCandidate(c, fields, input))
      .sort((a, b) => b.score - a.score);
    const [winner, runnerUp] = ranked;
    if (!winner || winner.score <= 0) return null;

    const containment = winner.containmentIdf / knownIdfMass;
    const margin = runnerUp && runnerUp.score > 0 ? winner.score / runnerUp.score : Number.POSITIVE_INFINITY;

    const confident =
      winner.score >= options.minMatchIdf && containment >= options.minContainment && margin >= options.marginRatio;
    if (!confident) return null;

    return {
      resource: winner.candidate.resource,
      score: winner.score,
      containment,
      margin,
      signals: { containmentIdf: winner.containmentIdf, keyField: winner.keyField, enumOverlap: winner.enumOverlap },
    };
  };

  return { match };
};
