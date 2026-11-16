'use strict';

/**
 * Merging the schema validation results of the strategies of one run.
 *
 * Each `replicate()` call validates its pages into a map of its own (`stats`, `errorCache`, `warningsCache`). A Data
 * Dictionary run makes one call per strategy, and the strategies fetch overlapping records: the same violation on
 * the same record is met by every strategy that reaches the record. Adding the maps together would count it once per
 * strategy, and a certification number may undercount but must never overcount.
 *
 * Nothing yet identifies a violation across calls (the dedup set that does is phase 0 of the 0.14.0 plan, #385), so
 * the counts here follow a conservative rule:
 *
 *   - The distinct findings are the UNION across strategies: every message, resource, field, lookup value, recorded
 *     value and record key any strategy reported.
 *   - A count at the finest level (a field, a lookup value, a recorded value) is the LARGEST count one strategy gave
 *     it, never the sum. One strategy alone met that many, so the union holds at least that many: it can be low when
 *     two strategies met different records failing the same way, and it cannot be high.
 *   - A count above that level (a resource under a message, the run totals) is the sum of the merged counts beneath
 *     it, so the report agrees with itself. A sum of lower bounds over separate entries is still a lower bound.
 *
 * The counts stay what they were within one strategy: occurrences, which a record fetched once per expansion already
 * repeats. This rule adds no repeat of its own on top of that.
 *
 * FOLLOW-UP (phase 0, #385): once violations are keyed in the dedup set, replace the largest-count rule with an
 * exact count of distinct violations, and delete this module's counting.
 */

const sum = numbers => numbers.reduce((total, n) => total + n, 0);
const countOf = node => (typeof node?.count === 'number' ? node.count : 0);
const unionKeys = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])];

/** Two maps of `{ [name]: { count } }` (lookup values, recorded values): the union, each at its larger count. */
const mergeCounted = (a = {}, b = {}) =>
  Object.fromEntries(unionKeys(a, b).map(key => [key, { ...a[key], ...b[key], count: Math.max(countOf(a[key]), countOf(b[key])) }]));

const sumCounted = (counted = {}) => sum(Object.values(counted).map(countOf));

/** What a field contributes to its resource's count: its own count, or its lookup values' counts. */
const fieldTotal = field => countOf(field) + sumCounted(field?.lookups);

/**
 * One field under a message and resource. A field counts either its lookup values or itself; a type error also
 * records which values failed, up to a cap per strategy.
 */
const mergeField = (a, b) => {
  if (!a || !b) return structuredClone(a ?? b);

  const merged = { ...a, ...b };
  if (a.lookups || b.lookups) merged.lookups = mergeCounted(a.lookups, b.lookups);
  if (a.values || b.values) merged.values = mergeCounted(a.values, b.values);

  if (a.count !== undefined || b.count !== undefined) {
    // The recorded values are separate entries beneath the field, so the field holds at least their sum.
    const listed = sumCounted(merged.values);
    merged.count = Math.max(countOf(a), countOf(b), listed);

    // "Omitted" is the part of the field's count the recorded values do not account for. Each strategy capped its
    // own list, so one strategy's omitted values may be on another's list: neither figure carries over, and adding
    // them would count a value both as recorded and as omitted.
    delete merged.valuesOmitted;
    if (merged.values && merged.count > listed) merged.valuesOmitted = merged.count - listed;
  }

  return merged;
};

/** One resource under a message: its fields merged, its record keys united, its count the sum of its fields'. */
const mergeResource = (a, b) => {
  if (!a || !b) return structuredClone(a ?? b);

  const fields = Object.fromEntries(unionKeys(a.fields, b.fields).map(name => [name, mergeField(a.fields?.[name], b.fields?.[name])]));
  const keys = a.keys || b.keys ? { keys: { ...a.keys, ...b.keys } } : {};

  return {
    ...a,
    ...b,
    ...keys,
    fields,
    count: Math.max(countOf(a), countOf(b), sum(Object.values(fields).map(fieldTotal)))
  };
};

/** An error or warning cache: `{ [message]: { resources: { [resourceName]: resource } } }`. */
const mergeCache = (a = {}, b = {}) =>
  Object.fromEntries(
    unionKeys(a, b).map(message => [
      message,
      {
        ...a[message],
        ...b[message],
        resources: Object.fromEntries(
          unionKeys(a[message]?.resources, b[message]?.resources).map(resourceName => [
            resourceName,
            mergeResource(a[message]?.resources?.[resourceName], b[message]?.resources?.[resourceName])
          ])
        )
      }
    ])
  );

const cacheTotal = (cache = {}) => sum(Object.values(cache).flatMap(({ resources = {} }) => Object.values(resources).map(countOf)));

/**
 * Merges one strategy's schema validation results into what the run has accumulated so far.
 *
 * Neither argument is changed. Merging the same results twice gives the same answer as merging them once, and the
 * order of the strategies does not change any count.
 *
 * @param {Object|null|undefined} accumulated the run's results so far, as returned by this function
 * @param {Object|null|undefined} results one `replicate()` call's results, as returned by `validate`
 * @returns {Object} the merged results, in the shape `validate` returns and `combineErrors` reads
 */
const mergeSchemaValidationResults = (accumulated, results) => {
  // The first strategy's results are the run's results, unchanged: a run of one strategy reports what it always did.
  if (!accumulated || !results) return structuredClone(accumulated ?? results ?? {});

  const a = accumulated;
  const b = results;
  const errorCache = mergeCache(a.errorCache, b.errorCache);
  const warningsCache = mergeCache(a.warningsCache, b.warningsCache);

  return {
    ...a,
    ...b,
    errorCache,
    warningsCache,
    ...(a.payloadErrors || b.payloadErrors ? { payloadErrors: { ...a.payloadErrors, ...b.payloadErrors } } : {}),
    stats: {
      totalErrors: Math.max(a.stats?.totalErrors ?? 0, b.stats?.totalErrors ?? 0, cacheTotal(errorCache)),
      totalWarnings: Math.max(a.stats?.totalWarnings ?? 0, b.stats?.totalWarnings ?? 0, cacheTotal(warningsCache))
    }
  };
};

module.exports = {
  mergeSchemaValidationResults
};
