/**
 * Field preferences — a provider's sparse "use auto except for these" override on field selection.
 *
 * Core testing samples live data and picks, per type, the field most likely to produce a meaningful
 * query: standard Data Dictionary fields before local ones, and within a rank the better-populated
 * field first. That is the right default and it needs no input. But a provider who knows their own
 * data sometimes has a reason to steer one or two choices — a field their service filters poorly, a
 * field whose population is misleading in a 100-record sample, a representation they would rather be
 * certified on. Today the only way to influence it is to lift the emitted queries out of the report
 * and re-run them by hand, which is a poor answer when Core testing is required of every MLS.
 *
 * A preference does not replace selection; it re-orders it. A preferred field moves to the front of
 * its candidate list and the automatic ranking decides everything else. That has two consequences
 * worth stating:
 *
 *   - **A preference cannot break a run.** The runner walks a ladder of candidates and falls through
 *     when one is not queryable, so a preferred field that the service rejects simply loses its turn
 *     and the automatic order resumes. There is no way to pin a field into a failing test.
 *   - **A preference cannot pin a field into a VACUOUSLY PASSING test either**, which is the direction that
 *     matters more and that an earlier version of this module missed. The fall-through above protects only
 *     against *retryable* outcomes. An empty result on a field holding ONE distinct value across a complete
 *     resource is scored a determinate `pass` and is NOT retryable, so it ends the ladder before the field
 *     that would have exercised the operator is ever queried. Since `coreOptions.preferFields` is read from
 *     the provider-authored config, that would hand the certified party a lever to convert a genuine
 *     `ne`/`gt`/`lt` failure into a pass. So `canDiscriminate` is REQUIRED here, not optional: a preference
 *     may only promote a candidate that can actually exercise the operators its type is certified on. This
 *     follows the rule the engine already applies to `lt/le now()`, where a field with no comparable value
 *     skips rather than passes, because the filter compared nothing.
 *   - **A preference cannot invent a candidate.** Only fields that already qualified for a scenario
 *     can be preferred. Naming a field of the wrong type, or one absent from the resource, does
 *     nothing — it is reported as unmatched rather than silently honored.
 *
 * **Not every selection is steerable, and that is deliberate.** Preferences apply to the Integer, Decimal,
 * Date and enumeration families. Timestamp selection is NOT steerable: it has its own ranker
 * (`rankDatetimeFields`) with semantics a preference would quietly break — `ModificationTimestamp` first, then
 * DD-standard by usage, and `lt/le now()` additionally requires a field carrying a PAST value. A preference
 * naming a datetime field therefore matches nothing and is reported as unmatched. The run says so rather than
 * implying a cause it cannot know.
 *
 * Because a preference changes *what was tested*, every applied preference is recorded on the test
 * parameters and travels into the compliance report. A steered run must be visibly steered: without
 * that, a provider could influence their own certification and the report would be indistinguishable
 * from an unsteered one.
 *
 * Spec syntax, as accepted from `--prefer-fields` and from `coreOptions.preferFields`:
 *
 *   `Office.FeedTypes`   qualified — applies only to that resource
 *   `FeedTypes`          bare — applies on any resource carrying the field
 *
 * Qualified entries win over bare ones for the same field, so a bare default can be narrowed by a
 * qualified exception.
 */

/** One parsed preference: a field name, optionally scoped to a resource. */
export interface FieldPreference {
  readonly resource?: string;
  readonly field: string;
  /** The entry as written, for reporting back exactly what the operator asked for. */
  readonly spec: string;
}

export interface PreferredFields {
  readonly entries: ReadonlyArray<FieldPreference>;
}

/**
 * The minimum number of distinct sampled values a candidate needs before a preference may promote it.
 *
 * Below this a field cannot discriminate: `ne`, `gt` and `lt` over a single-valued field return nothing on a
 * complete resource, and an empty result there is scored a determinate pass rather than a retryable skip. A
 * promoted field like that would end the candidate ladder without the operator ever having been exercised.
 */
export const MIN_DISCRIMINATING_VALUES = 2;

/** Empty preference set — the default, and what every existing caller gets. */
export const NO_FIELD_PREFERENCES: PreferredFields = { entries: [] };

/**
 * Parse preference specs. Accepts an array (config) or a comma-separated string (CLI). Blank and
 * whitespace-only entries are dropped; nothing throws, because a malformed preference must degrade
 * to automatic selection rather than fail a run that would otherwise have succeeded.
 */
export const parseFieldPreferences = (spec: ReadonlyArray<string> | string | undefined): PreferredFields => {
  if (spec === undefined) return NO_FIELD_PREFERENCES;
  const raw = typeof spec === 'string' ? spec.split(',') : spec;
  const entries = raw
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map((s): FieldPreference => {
      const dot = s.indexOf('.');
      // A dot separates resource from field. A trailing or leading dot is a malformed entry; treat
      // the whole string as a bare field name rather than inventing an empty resource.
      if (dot > 0 && dot < s.length - 1) {
        return { resource: s.slice(0, dot), field: s.slice(dot + 1), spec: s };
      }
      return { field: s.replace(/^\.|\.$/g, ''), spec: s };
    });
  return { entries };
};

/** Case-insensitive match, because a provider writes field names the way their metadata spells them. */
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The preference that applies to `resource.field`, or undefined. A qualified entry for the resource
 * takes precedence over a bare entry for the same field.
 */
export const preferenceFor = (preferred: PreferredFields, resource: string, field: string): FieldPreference | undefined =>
  preferred.entries.find(p => p.resource !== undefined && eq(p.resource, resource) && eq(p.field, field)) ??
  preferred.entries.find(p => p.resource === undefined && eq(p.field, field));

/** True when a preference applies to this resource and field. */
export const isPreferredField = (preferred: PreferredFields, resource: string, field: string): boolean =>
  preferenceFor(preferred, resource, field) !== undefined;

/**
 * Stable partition: preferred candidates first, in the order the preferences were written, then
 * everything else in the order the automatic ranking produced. `fieldOf` reads the field name off a
 * candidate so this works for both the enum and the scalar candidate shapes.
 *
 * Ordering among preferred entries follows the SPEC order, not the candidate order, so a provider
 * listing two fields gets the first one tried first.
 */
export const applyFieldPreferences = <T>(
  candidates: ReadonlyArray<T>,
  preferred: PreferredFields,
  resource: string,
  fieldOf: (c: T) => string,
  canDiscriminate: (c: T) => boolean
): ReadonlyArray<T> => {
  if (preferred.entries.length === 0 || candidates.length === 0) return candidates;
  const rankOf = (c: T): number => {
    if (!canDiscriminate(c)) return Number.MAX_SAFE_INTEGER;
    const hit = preferenceFor(preferred, resource, fieldOf(c));
    return hit === undefined ? Number.MAX_SAFE_INTEGER : preferred.entries.indexOf(hit);
  };
  // A stable sort keyed on spec position: preferred keep their listed order, the rest keep theirs.
  return [...candidates]
    .map((c, i) => ({ c, i, r: rankOf(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.c);
};

/**
 * Which preferences actually matched a candidate on this resource, as written. This is what the
 * report records: the operator's intent that took effect, not the whole spec — a preference naming a
 * field the resource does not carry had no effect and must not appear as though it did.
 */
export const matchedPreferences = <T>(
  candidates: ReadonlyArray<T>,
  preferred: PreferredFields,
  resource: string,
  fieldOf: (c: T) => string,
  canDiscriminate: (c: T) => boolean
): ReadonlyArray<string> => {
  if (preferred.entries.length === 0) return [];
  const specs = candidates
    .filter(canDiscriminate)
    .map(c => preferenceFor(preferred, resource, fieldOf(c))?.spec)
    .filter((s): s is string => s !== undefined);
  return [...new Set(specs)];
};

/**
 * What a report says about steering: what the operator asked for, what took effect, and what matched
 * nothing at all. Three fields rather than one, because the request alone cannot be trusted as evidence
 * of steering — a preference naming a field that never qualified for any scenario changes nothing.
 *
 * `applied` means the preference RE-ORDERED that resource's candidate list. It is not a promise that a
 * given scenario queried the field: scenarios are pinned to one enumeration representation each
 * (`scenarioTargetsRep`), so a preferred COLLECTION_ENUM field cannot serve a COLLECTION_STRING
 * scenario however highly it ranks. The field a scenario actually queried is in its own `requestUrl`;
 * this summary is the run-level answer to "was this run steered, and did the steering land".
 */
export interface FieldPreferenceSummary {
  readonly requested: ReadonlyArray<string>;
  readonly applied: ReadonlyArray<string>;
  /** Requested preferences that matched no candidate on any resource. Omitted when every one landed. */
  readonly unmatched?: ReadonlyArray<string>;
}

/** Summarize steering for the report, given each resource's applied set (see {@link matchedPreferences}). */
export const summarizeFieldPreferences = (
  preferred: PreferredFields,
  appliedPerResource: ReadonlyArray<ReadonlyArray<string>>
): FieldPreferenceSummary => {
  const requested = preferred.entries.map(e => e.spec);
  const applied = [...new Set(appliedPerResource.flat())];
  const unmatched = requested.filter(s => !applied.includes(s));
  return { requested, applied, ...(unmatched.length > 0 && { unmatched }) };
};
