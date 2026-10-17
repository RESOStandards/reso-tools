/**
 * Field overrides — a provider's sparse replacement of automatic field selection.
 *
 * Core testing samples live data and picks, per type, the field most likely to produce a meaningful
 * query: standard Data Dictionary fields before local ones, and within a rank the better-populated
 * field first. That is the right default and it needs no input. But a provider who knows their own
 * data sometimes has a reason to name one or two choices themselves — a field their service filters
 * poorly, a field whose population is misleading in a 1,000-record sample, a representation they
 * would rather be certified on. Without that, the only way to influence it is to lift the emitted
 * queries out of the report and re-run them by hand, which is a poor answer when Core testing is
 * required of every MLS.
 *
 * **An override replaces selection for its slot. It does not re-order it.** The named field is the
 * field that gets tested, and the automatic candidates for that slot are not consulted at all. Three
 * consequences, and the first is the one that changed:
 *
 *   - **An override owns its outcome.** The runner walks a ladder of candidates when it is *guessing*
 *     which field a server will filter on, because ranking is uncorrelated with filterability. Under an
 *     override it is not guessing: the provider said which field. So there is no ladder behind it, and a
 *     named field that the service rejects fails its test rather than quietly losing its turn to an
 *     automatic choice. That is the point of naming it.
 *   - **An override is sparse, per data type.** Naming an integer field pins the integer slot and leaves
 *     every other slot automatic. A run can have some slots pinned and others laddered, so "overrides are
 *     set" is never a run-wide statement about how a verdict was reached.
 *   - **An override cannot invent a candidate.** Only a field that already qualified for a slot can be
 *     named. A field of the wrong type, one absent from the resource, or one that cannot exercise the
 *     slot's operators (see {@link MIN_DISCRIMINATING_VALUES}) is not a candidate, so that slot has no
 *     effective override and stays automatic. It is reported as unmatched rather than silently honored,
 *     and a typo therefore costs the operator that one override and nothing else.
 *
 * **Not every selection is overridable, and that is deliberate.** Overrides apply to the Integer, Decimal,
 * Date and enumeration families. Timestamp selection is NOT overridable: it has its own ranker
 * (`rankDatetimeFields`) with semantics an override would quietly break — `ModificationTimestamp` first, then
 * DD-standard by usage, and `lt/le now()` additionally requires a field carrying a PAST value. An override
 * naming a datetime field therefore matches nothing and is reported as unmatched. The run says so rather than
 * implying a cause it cannot know.
 *
 * Because an override changes *what was tested*, every applied override is recorded on the test
 * parameters and travels into the compliance report. An overridden run must be visibly overridden: without
 * that, a provider could influence their own certification and the report would be indistinguishable
 * from an automatic one.
 *
 * Spec syntax, as accepted from `--field-overrides` and from `coreOptions.fieldOverrides`:
 *
 *   `Office.FeedTypes`   the only accepted form — `Resource.Field`
 *
 * **The resource is required.** A bare field name is rejected, because an override is binding and a bare
 * name has an unbounded target: it would apply to every resource carrying that field, so one entry could
 * pin selection across several resources at once and a failure on any of them would trace back to an entry
 * the operator meant for one. A binding instruction needs an explicit target. Bare entries are collected as
 * {@link FieldOverrides.malformed} and reported, never guessed at.
 */

/** One parsed override. The resource is required — see the module note on bare field names. */
export interface FieldOverride {
  readonly resource: string;
  readonly field: string;
  /** The entry as written, for reporting back exactly what the operator asked for. */
  readonly spec: string;
}

export interface FieldOverrides {
  readonly entries: ReadonlyArray<FieldOverride>;
  /** Entries rejected at parse time for not being in `Resource.Field` form, kept so they can be reported. */
  readonly malformed: ReadonlyArray<string>;
}

/**
 * The minimum number of distinct sampled values a candidate needs to be eligible for an override.
 *
 * Below this a field cannot discriminate: `ne`, `gt` and `lt` over a single-valued field return nothing on a
 * complete resource, and an empty result there is scored a determinate pass rather than a retryable skip. So a
 * field like that would be pinned into a test it passes without having exercised the operator. Rather than
 * hand the certified party that lever, such a field is not an override candidate at all: the slot stays
 * automatic and the entry is reported as unmatched.
 *
 * Note the scope. This is a SCALAR-operator guard, where an empty result is an artifact of how the verdict is
 * scored. It is not about `all()` over an empty collection, which Web API Core 2.1.0 defines as vacuously TRUE
 * ("a record with an empty collection satisfies this vacuously") — that is conformant behavior, not a hole.
 */
export const MIN_DISCRIMINATING_VALUES = 2;

/** Empty override set — the default, and what every caller that passes nothing gets. */
export const NO_FIELD_OVERRIDES: FieldOverrides = { entries: [], malformed: [] };

/** `Resource.Field`. Exactly one dot, an identifier on each side. Kept in sync with the web client's own check. */
const OVERRIDE_SPEC = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Parse override specs. Accepts an array (config) or a comma-separated string (CLI). Blank and
 * whitespace-only entries are dropped. Nothing throws, because a malformed override must degrade to
 * automatic selection rather than fail a run that would otherwise have succeeded — but it is collected
 * in `malformed` so the run can say what it ignored instead of dropping it in silence.
 */
export const parseFieldOverrides = (spec: ReadonlyArray<string> | string | undefined): FieldOverrides => {
  if (spec === undefined) return NO_FIELD_OVERRIDES;
  const raw = typeof spec === 'string' ? spec.split(',') : spec;
  const trimmed = raw.map(s => s.trim()).filter(s => s.length > 0);
  const parsed = trimmed.map(s => ({ s, m: OVERRIDE_SPEC.exec(s) }));
  const all = parsed
    .filter((p): p is { s: string; m: RegExpExecArray } => p.m !== null)
    .map(({ s, m }): FieldOverride => ({ resource: m[1], field: m[2], spec: s }));
  // Naming one field twice is one request, so case-variant duplicates collapse to the first spelling.
  // Matching is case-insensitive, so `overrideFor` would resolve both to the same candidate and only the
  // first spelling could ever be reported as applied - leaving the second permanently "unmatched", which
  // says the operator's entry landed nowhere when it in fact described the pin that happened.
  const seen = new Set<string>();
  const entries = all.filter(o => {
    const key = `${o.resource.toLowerCase()}.${o.field.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { entries, malformed: parsed.filter(p => p.m === null).map(p => p.s) };
};

/** Case-insensitive match, because a provider writes names the way their metadata spells them. */
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The override that applies to `resource.field`, or undefined. */
export const overrideFor = (overrides: FieldOverrides, resource: string, field: string): FieldOverride | undefined =>
  overrides.entries.find(o => eq(o.resource, resource) && eq(o.field, field));

/** True when an override applies to this resource and field. */
export const isOverriddenField = (overrides: FieldOverrides, resource: string, field: string): boolean =>
  overrideFor(overrides, resource, field) !== undefined;

/** Sort sentinel for "this candidate was not named by any override". */
const NOT_PINNED = -1;

/** The single implicit group a caller that passes no `groupOf` gets, so one list is one pinnable unit. */
const ONE_GROUP = '';

/**
 * Replace a group's candidates with the overridden ones, or leave them alone.
 *
 * This REPLACES rather than re-orders, which is what makes an override binding: the returned list is what
 * the runner's ladder walks, so pinning is expressed by giving it nothing else to walk. No change to the
 * ladder itself is needed.
 *
 * **`groupOf` is what makes the replacement safe, and omitting it on a mixed list is a certification bug.**
 * Replacement must happen at the same granularity the RUNNER selects at, not at whatever granularity the
 * candidate list happens to have. The enum lists do not match: `selectEnumCandidates` is called once per
 * CARDINALITY pool (single vs multi), but a scenario draws from one REPRESENTATION — `scenarioTargetsRep`
 * narrows the stored list afterwards, and the Lookup Resource scenario reads it as a per-representation
 * presence inventory. So a representation-blind replacement on the multi pool would let an override on a
 * `Collection(Edm.String)` field delete the provider's `Collection(Edm.EnumType)` field from the pool, and
 * the enum-typed scenarios would then find nothing to query and SKIP — reporting "no field of this
 * scenario's representation supports this operator on this server" without having issued a request, on a
 * provider that carries such a field. A skip is neither a pass nor a fail, so that silently converts a
 * required failure into a certification pass. Grouping by representation confines the replacement to the
 * named field's own representation and leaves its siblings automatic. (`selectEnumCandidates` already
 * refuses to CAP these lists for exactly this crowd-out reason; replacement had to learn the same rule.)
 *
 * Three rules carry the rest of the contract:
 *
 *   - Only an ELIGIBLE candidate can be pinned. `isEligible` is the group's own test for whether a field can
 *     exercise its operators (see {@link MIN_DISCRIMINATING_VALUES}); an ineligible field was never a
 *     candidate, so naming it is a no-op rather than a pin.
 *   - A group nothing matched is returned UNCHANGED, and so is the whole list when no group matched. That is
 *     the "a typo costs you that one override and nothing else" promise: an override that landed nowhere
 *     leaves its group automatic instead of pinning it to an empty set and failing a test the server would
 *     have passed.
 *   - Groups stay interleaved in ranked order, so an untouched group sits where the ranking put it.
 *
 * Ordering among pinned candidates follows the SPEC order, not the candidate order, so an operator naming
 * two fields for one group gets the first one tried first.
 *
 * `fieldOf` reads the field name off a candidate, so this works for both the enum and scalar candidate shapes.
 */
export const applyFieldOverrides = <T>(
  candidates: ReadonlyArray<T>,
  overrides: FieldOverrides,
  resource: string,
  fieldOf: (c: T) => string,
  isEligible: (c: T) => boolean,
  groupOf: (c: T) => string = () => ONE_GROUP
): ReadonlyArray<T> => {
  if (overrides.entries.length === 0 || candidates.length === 0) return candidates;
  const marked = candidates.map((c, index) => {
    const hit = isEligible(c) ? overrideFor(overrides, resource, fieldOf(c)) : undefined;
    return { c, index, group: groupOf(c), spec: hit === undefined ? NOT_PINNED : overrides.entries.indexOf(hit) };
  });
  const pinnedGroups = new Set(marked.filter(m => m.spec !== NOT_PINNED).map(m => m.group));
  if (pinnedGroups.size === 0) return candidates;
  // Keep the groups interleaved as the ranking had them, so an untouched group's position is unchanged.
  const groupFirstSeen = new Map<string, number>();
  for (const m of marked) if (!groupFirstSeen.has(m.group)) groupFirstSeen.set(m.group, m.index);
  return marked
    .filter(m => !pinnedGroups.has(m.group) || m.spec !== NOT_PINNED)
    .sort(
      (a, b) =>
        (groupFirstSeen.get(a.group) ?? 0) - (groupFirstSeen.get(b.group) ?? 0) ||
        // Within a group every survivor is pinned or none is, so this comparator is consistent either way.
        (a.spec !== NOT_PINNED && b.spec !== NOT_PINNED ? a.spec - b.spec : a.index - b.index)
    )
    .map(m => m.c);
};

/**
 * Which overrides actually pinned a candidate on this resource, as written. This is what the report
 * records: the operator's intent that took effect, not the whole spec — an override naming a field the
 * resource does not carry had no effect and must not appear as though it did.
 */
export const matchedOverrides = <T>(
  candidates: ReadonlyArray<T>,
  overrides: FieldOverrides,
  resource: string,
  fieldOf: (c: T) => string,
  isEligible: (c: T) => boolean
): ReadonlyArray<string> => {
  if (overrides.entries.length === 0) return [];
  const specs = candidates
    .filter(isEligible)
    .map(c => overrideFor(overrides, resource, fieldOf(c))?.spec)
    .filter((s): s is string => s !== undefined);
  return [...new Set(specs)];
};

/**
 * What a report says about overriding: what the operator asked for, what took effect, what matched
 * nothing, and what was not even well-formed. Four fields rather than one, because the request alone cannot
 * be trusted as evidence — an override naming a field that never qualified for any scenario changes nothing,
 * and an entry that was not in `Resource.Field` form never became an override at all. Those are different
 * operator mistakes and they want different corrections.
 *
 * `applied` means the override REPLACED that resource's candidate list for a slot. It is not a promise that a
 * given scenario queried the field: scenarios are pinned to one enumeration representation each
 * (`scenarioTargetsRep`), so an overridden COLLECTION_ENUM field cannot serve a COLLECTION_STRING
 * scenario. The field a scenario actually queried is in its own `requestUrl`; this summary is the run-level
 * answer to "was this run overridden, and did the override land".
 */
export interface FieldOverrideSummary {
  readonly requested: ReadonlyArray<string>;
  readonly applied: ReadonlyArray<string>;
  /** Well-formed overrides that matched no eligible candidate on any resource. Omitted when every one landed. */
  readonly unmatched?: ReadonlyArray<string>;
  /** Entries that were not in `Resource.Field` form. Omitted when there were none. */
  readonly malformed?: ReadonlyArray<string>;
}

/**
 * Summarize overriding for the report, given each resource's applied set (see {@link matchedOverrides}).
 *
 * `requested` is EVERYTHING the operator asked for, malformed entries included, because that is what the
 * word means and because a consumer that reads only `requested` must not be shown a shorter list than was
 * typed. A reader deciding "was this run overridden at all" keys on the presence of a non-empty `requested`,
 * so dropping typos out of it made a run whose every entry was malformed indistinguishable from a run with
 * no overrides at all — the typo disappeared instead of being reported.
 *
 * The three outcome lists stay DISJOINT, so nothing is counted twice: `applied` took effect, `unmatched` was
 * well-formed and landed nowhere, `malformed` never parsed. `unmatched` is therefore computed over the
 * parsed entries only. Malformed entries sort after the well-formed ones in `requested`, since parsing
 * partitions them; `malformed` is what identifies which they were.
 */
export const summarizeFieldOverrides = (
  overrides: FieldOverrides,
  appliedPerResource: ReadonlyArray<ReadonlyArray<string>>
): FieldOverrideSummary => {
  const parsed = overrides.entries.map(e => e.spec);
  const requested = [...parsed, ...overrides.malformed];
  const applied = [...new Set(appliedPerResource.flat())];
  const unmatched = parsed.filter(s => !applied.includes(s));
  return {
    requested,
    applied,
    ...(unmatched.length > 0 && { unmatched }),
    ...(overrides.malformed.length > 0 && { malformed: overrides.malformed })
  };
};
