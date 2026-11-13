import { createBufferDistinctKeySet } from './distinct-key-set-buffer.js';
import type { DistinctKeySet, DistinctKeySetStats } from './distinct-key-set.js';

/**
 * Accumulator for schema-validation errors whose counts are distinct records rather than sightings.
 *
 * Additive and unwired: the existing path keeps producing what it produces, and nothing here runs
 * until something calls it. Changing a published number is a decision about what providers are told,
 * so it is made deliberately rather than as part of a refactor.
 *
 * See the registry reference `references/deduplication.md` for the reasoning.
 */

/** Up to this many real record keys are kept per value, for spot-checking. */
const DEFAULT_SAMPLES_PER_VALUE = 5;

/**
 * Enough for a large run without being wasteful: the reference run produced 1,050,216 distinct
 * violations, and the set sizes to the next power of two above target/0.7 regardless.
 */
const DEFAULT_EXPECTED_VIOLATIONS = 4_000_000;

/** One observation, as the validator sees it. */
export interface SchemaErrorObservation {
  /** The validator's message, which is the top-level grouping in the report. */
  readonly message: string;
  readonly resourceName: string;
  readonly fieldName: string;
  /** The offending enum value, when the failure is about a value. Absent for type failures. */
  readonly lookupValue?: string;
  /** The resource's key field name, e.g. `ListingKey`. */
  readonly keyField: string;
  /**
   * The record's key value. Required: without it there is nothing to deduplicate on, and counting
   * an observation whose record is unidentifiable would reintroduce occurrence counting for that
   * one path. Such an observation is reported as `uncounted` rather than silently counted.
   */
  readonly keyFieldValue?: string;
}

export type RecordOutcome =
  /** First sighting of this violation for this record. Counted. */
  | 'counted'
  /** Same record, same violation, seen again. Not counted. */
  | 'duplicate'
  /** No record key, or the dedup set is saturated. Not counted, and the totals become a floor. */
  | 'uncounted';

export interface ErrorStateStoreStats {
  readonly distinctViolations: number;
  readonly duplicatesSuppressed: number;
  readonly uncounted: number;
  /** True when any observation went uncounted, which makes every total in the report a FLOOR. */
  readonly totalsAreFloor: boolean;
  readonly set: DistinctKeySetStats;
}

export interface ErrorStateStore {
  readonly record: (observation: SchemaErrorObservation) => RecordOutcome;
  readonly stats: () => ErrorStateStoreStats;
  readonly toReport: (meta?: { readonly version?: string; readonly generatedOn?: string }) => unknown;
}

export interface ErrorStateStoreOptions {
  readonly expectedViolations?: number;
  readonly samplesPerValue?: number;
  /** Injectable for tests, and so a saturated-set path can be exercised deliberately. */
  readonly keySet?: DistinctKeySet;
}

/** Leaf: one (field, value) pair. */
interface ValueNode {
  count: number;
  readonly samples: string[];
}

interface FieldNode {
  readonly lookups: Map<string, ValueNode>;
  /** Used when the failure is not about a value - a type error has no offending enum. */
  readonly typeFailures: ValueNode;
}

interface ResourceNode {
  count: number;
  keyField: string;
  readonly distinctRecords: Set<string>;
  readonly fields: Map<string, FieldNode>;
}

export const createErrorStateStore = (options: ErrorStateStoreOptions = {}): ErrorStateStore => {
  const samplesPerValue = options.samplesPerValue ?? DEFAULT_SAMPLES_PER_VALUE;
  const seen =
    options.keySet ??
    createBufferDistinctKeySet({
      targetDistinctKeys: options.expectedViolations ?? DEFAULT_EXPECTED_VIOLATIONS
    });

  // Closure-scoped mutable state. Never exposed except through `stats` and `toReport`.
  const tree = new Map<string, Map<string, ResourceNode>>();
  let distinctViolations = 0;
  let duplicatesSuppressed = 0;
  let uncounted = 0;

  const emptyValueNode = (): ValueNode => ({ count: 0, samples: [] });

  const valueNodeFor = (observation: SchemaErrorObservation): ValueNode => {
    const byResource = tree.get(observation.message) ?? new Map<string, ResourceNode>();
    tree.set(observation.message, byResource);

    const resource =
      byResource.get(observation.resourceName) ??
      ({
        count: 0,
        keyField: observation.keyField,
        distinctRecords: new Set<string>(),
        fields: new Map<string, FieldNode>()
      } satisfies ResourceNode);
    byResource.set(observation.resourceName, resource);

    const field =
      resource.fields.get(observation.fieldName) ??
      ({ lookups: new Map<string, ValueNode>(), typeFailures: emptyValueNode() } satisfies FieldNode);
    resource.fields.set(observation.fieldName, field);

    if (observation.lookupValue === undefined) return field.typeFailures;
    const value = field.lookups.get(observation.lookupValue) ?? emptyValueNode();
    field.lookups.set(observation.lookupValue, value);
    return value;
  };

  const record = (observation: SchemaErrorObservation): RecordOutcome => {
    // No record key means nothing to deduplicate on. Counting it anyway would make this one path an
    // occurrence counter inside a distinct counter, which is worse than declining it, because the
    // resulting total would be neither thing. See `absence_is_never_filled_in`.
    if (!observation.keyFieldValue) {
      uncounted++;
      return 'uncounted';
    }

    // The composed key IS the violation's identity. No interning and no bit packing: the set hashes
    // whatever it is given, so key length costs hash time proportional to length and nothing in
    // memory. `\u0000` separates the parts because it cannot occur in a field name, an enum value or
    // a record key, so no two different violations can compose to the same string.
    const composed = [
      observation.message,
      observation.resourceName,
      observation.fieldName,
      observation.lookupValue ?? '',
      observation.keyFieldValue
    ].join('\u0000');

    const outcome = seen.add(composed);
    if (outcome === 'present') {
      duplicatesSuppressed++;
      return 'duplicate';
    }
    if (outcome === 'refused') {
      // Saturated. Declining to count keeps the error in the undercounting direction, and `stats`
      // reports it so a reader knows the totals are a floor rather than a measurement.
      uncounted++;
      return 'uncounted';
    }

    const node = valueNodeFor(observation);
    node.count++;
    if (node.samples.length < samplesPerValue) node.samples.push(observation.keyFieldValue);

    const resource = tree.get(observation.message)?.get(observation.resourceName);
    if (resource) {
      resource.count++;
      resource.distinctRecords.add(observation.keyFieldValue);
    }
    distinctViolations++;
    return 'counted';
  };

  const stats = (): ErrorStateStoreStats => ({
    distinctViolations,
    duplicatesSuppressed,
    uncounted,
    totalsAreFloor: uncounted > 0,
    set: seen.stats()
  });

  /**
   * The report, in the shape of the existing artifact so the two are directly comparable, with two
   * differences that are the point of this store.
   */
  const toReport = (meta: { readonly version?: string; readonly generatedOn?: string } = {}): unknown => ({
    description: 'RESO Common Format Schema Validation Summary (distinct records)',
    ...(meta.version !== undefined && { version: meta.version }),
    ...(meta.generatedOn !== undefined && { generatedOn: meta.generatedOn }),
    totalErrors: distinctViolations,
    totalsAreFloor: uncounted > 0,
    errors: Object.fromEntries(
      [...tree.entries()].map(([message, byResource]) => [
        message,
        {
          resources: Object.fromEntries(
            [...byResource.entries()].map(([resourceName, resource]) => [
              resourceName,
              {
                count: resource.count,
                keyField: resource.keyField,
                distinctRecordCount: resource.distinctRecords.size,
                fields: Object.fromEntries(
                  [...resource.fields.entries()].map(([fieldName, field]) => [
                    fieldName,
                    field.lookups.size > 0
                      ? {
                          lookups: Object.fromEntries(
                            [...field.lookups.entries()].map(([value, node]) => [value, { count: node.count, keys: node.samples }])
                          )
                        }
                      : { count: field.typeFailures.count, keys: field.typeFailures.samples }
                  ])
                )
              }
            ])
          )
        }
      ])
    )
  });

  return Object.freeze({ record, stats, toReport });
};
