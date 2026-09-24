/**
 * Variations matching helpers — the pure leaf primitives the variations matcher reuses.
 *
 * Lifted behavior-for-behavior from the legacy cert-utils variations module
 * (reso-tools' `reso-certification/src/legacy/lib/variations/index.js`). Zero runtime
 * deps, no Node or DOM APIs, so they sit here at the bottom of the dep graph for both the
 * backend matcher and the (transitional) reso-tools matcher to share. A parity test in
 * reso-certification pins these against the legacy originals; the legacy copies ride along
 * untouched until the legacy matcher is deleted wholesale (cert-utils is the archive).
 */

type Json = Record<string, unknown>;

export const DEFAULT_FUZZINESS = 0.25;
export const MIN_MATCHING_LENGTH = 3;
export const CLOSE_MATCH_DISTANCE = 1;

export const MATCHING_STRATEGIES = Object.freeze({
  SUBSTRING: 'Substring',
  EDIT_DISTANCE: 'Edit Distance',
  ADMIN_REVIEW: 'Admin Review',
  FAST_TRACK: 'Fast Track',
  EXTERNAL_SUGGESTION: 'Suggestion'
} as const);

/** Lowercase and strip everything but [0-9a-z]; falls back to the input when that empties it. */
export const normalizeDataElementName = (name: string): string => name?.toLowerCase()?.replace(/[^0-9a-z]/gi, '') || name;

/** Map a suggestion's provenance flags to its strategy label. */
export const classifySuggestionStrategy = ({
  isAdminReview = false,
  isFastTrack = false
}: { isAdminReview?: boolean; isFastTrack?: boolean } = {}): string => {
  if (isAdminReview) return MATCHING_STRATEGIES.ADMIN_REVIEW;
  if (isFastTrack) return MATCHING_STRATEGIES.FAST_TRACK;
  return MATCHING_STRATEGIES.EXTERNAL_SUGGESTION;
};

interface DDWikiUrlInput {
  readonly version?: string;
  readonly standardMetadataMap?: Record<string, Record<string, { legacyODataValues?: Record<string, { lookupValue?: string }> }>>;
  readonly resourceName?: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
}

/**
 * Build the dd.reso.org docs URL for a DD element, per the dd.reso.org convention:
 *   Resource: /DD{version}/{ResourceName}/
 *   Field:    /DD{version}/{ResourceName}/{FieldName}/
 *   Lookup:   /DD{version}/lookups/{FieldName}/{LookupValue}/
 * A legacyODataValue is resolved to its display lookup value via the standard map.
 * Returns null when params are insufficient.
 */
export const getDDWikiUrl = ({
  version = '2.1',
  standardMetadataMap,
  resourceName,
  fieldName,
  lookupValue,
  legacyODataValue
}: DDWikiUrlInput): string | null => {
  const base = `https://dd.reso.org/DD${version}`;

  let resolvedLookupValue = lookupValue;
  if (!resolvedLookupValue && legacyODataValue && standardMetadataMap && resourceName && fieldName) {
    const legacyMap = standardMetadataMap?.[resourceName]?.[fieldName]?.legacyODataValues;
    if (legacyMap?.[legacyODataValue]) {
      resolvedLookupValue = legacyMap[legacyODataValue].lookupValue ?? legacyODataValue;
    }
  }

  if (fieldName && resolvedLookupValue) {
    return `${base}/lookups/${encodeURIComponent(fieldName)}/${encodeURIComponent(resolvedLookupValue)}/`;
  }
  if (resourceName && fieldName) {
    return `${base}/${encodeURIComponent(resourceName)}/${encodeURIComponent(fieldName)}/`;
  }
  if (resourceName) {
    return `${base}/${encodeURIComponent(resourceName)}/`;
  }
  return null;
};

interface PrepareResultsInput {
  readonly resources?: ReadonlyArray<Json>;
  readonly fields?: ReadonlyArray<Json>;
  readonly lookupValues?: ReadonlyArray<Json>;
  readonly legacyODataValues?: ReadonlyArray<Json>;
  readonly expansions?: ReadonlyArray<Json>;
  readonly complexTypes?: ReadonlyArray<Json>;
}

/**
 * Which kind of element a variation is about.
 *
 * Carried on the record rather than implied by which bucket it sits in. The
 * matcher knows an expansion from a field — it picks the bucket on exactly
 * that — and then used to discard the distinction, leaving every consumer to
 * re-derive it from which keys happen to be populated. They cannot: a field
 * and an expansion populate the same keys, so an expansion reads as a field.
 */
/**
 * One suggestion on a variation. Deliberately open: strategy, ddWikiUrl,
 * distance, maxDistance, exactMatch, closeMatch, targetMajor and the Fast
 * Track / admin-review flags accumulate at different stages, and pinning them
 * all produces a type that fights every future matcher change.
 */
export type VariationSuggestion = Record<string, unknown>;

export type VariationLevel = 'resource' | 'field' | 'expansion' | 'complexType' | 'lookup';

/** A variation about a whole resource. */
export interface ResourceEntry {
  readonly level: 'resource';
  readonly resourceName: string;
  readonly suggestions: VariationSuggestion[];
}

/** A variation about a named element of a resource. The three levels share a
 *  shape and differ only in what they are matched against. */
export interface ElementEntry {
  readonly level: 'field' | 'expansion' | 'complexType';
  readonly resourceName: string;
  readonly fieldName: string;
  readonly suggestions: VariationSuggestion[];
}

/** A variation about one value of a lookup, in either wire form. */
export interface LookupEntry {
  readonly level: 'lookup';
  readonly resourceName: string;
  readonly fieldName: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly suggestions: VariationSuggestion[];
}

/**
 * One grouped variation. `suggestions` is required on every arm: an entry with
 * nothing to suggest is not representable, which is the shape the expansions
 * bucket silently violated for as long as it was passed through ungrouped.
 */
export type VariationEntry = ResourceEntry | ElementEntry | LookupEntry;

/** Whether a variation must be fixed against the current major, or is a warning
 *  because every suggestion targets a future one. */
export type Enforcement = 'must-fix' | 'warning';

/**
 * A grouped entry after the enforcement pass. Named separately from
 * `VariationEntry` on purpose: `enforcement` is stamped by the service, not by
 * the matcher, so a type that made it optional everywhere would stop the
 * compiler reporting it missing at the point it should be present.
 */
export type Bucketed<T> = T & { readonly enforcement: Enforcement };

export interface BucketedVariations {
  readonly resources: Bucketed<ResourceEntry>[];
  readonly fields: Bucketed<ElementEntry>[];
  readonly lookups: Bucketed<LookupEntry>[];
  readonly expansions: Bucketed<ElementEntry>[];
  readonly complexTypes: Bucketed<ElementEntry>[];
}

export interface PreparedVariations {
  readonly resources: ResourceEntry[];
  readonly fields: ElementEntry[];
  readonly lookups: LookupEntry[];
  readonly expansions: ElementEntry[];
  readonly complexTypes: ElementEntry[];
}

/**
 * Group and deduplicate the matcher's flat accumulator into the report shape:
 * resource-level, field-level, and merged lookup/legacyOData suggestions (deduped per
 * suggested target). Faithful port — keeps the legacy grouping/dedup exactly.
 */
/**
 * Group flat `(resourceName, fieldName, ...suggestion)` records into one entry per
 * element, carrying a `suggestions[]` array. Shared by every element-level bucket so
 * fields, expansions and complex types have one record shape — a consumer that reads
 * `suggestions` reads all three the same way. The caller names the level, because
 * the bucket is the only place that knows it.
 */
/**
 * A map with no prototype, for accumulators keyed by provider-supplied names.
 * A resource or field called `__proto__` is legal in someone's metadata, and a
 * plain object literal would let it reach `Object.prototype` (CodeQL
 * js/prototype-polluting-assignment). `Object.create(null)` has no prototype to
 * reach, so the key is inert.
 */
const emptyMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const groupByResourceAndField = (records: ReadonlyArray<Json>, level: ElementEntry['level']): ElementEntry[] =>
  Object.values(
    records.reduce<Record<string, Record<string, ElementEntry>>>((acc, { resourceName, fieldName, ...suggestion }) => {
      const rKey = resourceName as string;
      const fKey = fieldName as string;
      if (!acc?.[rKey]) {
        acc[rKey] = emptyMap();
      }
      if (!acc?.[rKey]?.[fKey]) {
        acc[rKey][fKey] = { level, resourceName: rKey, fieldName: fKey, suggestions: [] };
      }
      acc[rKey][fKey].suggestions.push(suggestion);
      return acc;
    }, emptyMap())
  ).flatMap(Object.values);

export const prepareResults = ({
  resources = [],
  fields = [],
  lookupValues = [],
  legacyODataValues = [],
  expansions = [],
  complexTypes = []
}: PrepareResultsInput = {}): PreparedVariations => {
  return {
    resources:
      Object.values(
        resources.reduce<Record<string, ResourceEntry>>((acc, { resourceName, ...suggestion }) => {
          const key = resourceName as string;
          if (!acc?.[key]) {
            acc[key] = { level: 'resource', resourceName: key, suggestions: [] };
          }
          acc[key].suggestions.push(suggestion);
          return acc;
        }, emptyMap())
      ) || [],
    fields: groupByResourceAndField(fields, 'field'),
    lookups: Object.values(
      [...lookupValues, ...legacyODataValues].reduce<Record<string, Record<string, Record<string, LookupEntry>>>>(
        (acc, { resourceName, fieldName, lookupValue, legacyODataValue, ...rest }) => {
          const rKey = resourceName as string;
          const fKey = fieldName as string;
          if (!acc?.[rKey]) {
            acc[rKey] = emptyMap();
          }
          if (!acc?.[rKey]?.[fKey]) {
            acc[rKey][fKey] = emptyMap();
          }

          const lookupKey = `${legacyODataValue}${lookupValue}`;

          if (!acc?.[rKey]?.[fKey]?.[lookupKey]) {
            acc[rKey][fKey][lookupKey] = {
              level: 'lookup',
              resourceName: rKey,
              fieldName: fKey,
              legacyODataValue: legacyODataValue as string | undefined,
              lookupValue: lookupValue as string | undefined,
              suggestions: []
            };
          }

          const suggestions = acc[rKey][fKey][lookupKey].suggestions;
          if (
            !suggestions.some(
              x =>
                (x as Json)?.suggestedLookupValue === (rest as Json)?.suggestedLookupValue &&
                (x as Json)?.suggestedLegacyODataValue === (rest as Json)?.suggestedLegacyODataValue
            )
          ) {
            suggestions.push({ ...rest });
          }

          return acc;
        },
        emptyMap()
      )
    ).flatMap(item => Object.values(Object.values(item).flatMap(Object.values))),
    expansions: groupByResourceAndField(expansions, 'expansion'),
    complexTypes: groupByResourceAndField(complexTypes, 'complexType')
  };
};
