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
  EXTERNAL_SUGGESTION: 'Suggestion',
} as const);

/** Lowercase and strip everything but [0-9a-z]; falls back to the input when that empties it. */
export const normalizeDataElementName = (name: string): string =>
  name?.toLowerCase()?.replace(/[^0-9a-z]/gi, '') || name;

/** Map a suggestion's provenance flags to its strategy label. */
export const classifySuggestionStrategy = (
  { isAdminReview = false, isFastTrack = false }: { isAdminReview?: boolean; isFastTrack?: boolean } = {},
): string => {
  if (isAdminReview) return MATCHING_STRATEGIES.ADMIN_REVIEW;
  if (isFastTrack) return MATCHING_STRATEGIES.FAST_TRACK;
  return MATCHING_STRATEGIES.EXTERNAL_SUGGESTION;
};

interface DDWikiUrlInput {
  readonly version?: string;
  readonly standardMetadataMap?: Record<
    string,
    Record<string, { legacyODataValues?: Record<string, { lookupValue?: string }> }>
  >;
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
  legacyODataValue,
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

export interface PreparedVariations {
  readonly resources: Json[];
  readonly fields: Json[];
  readonly lookups: Json[];
  readonly expansions: ReadonlyArray<Json>;
  readonly complexTypes: ReadonlyArray<Json>;
}

/**
 * Group and deduplicate the matcher's flat accumulator into the report shape:
 * resource-level, field-level, and merged lookup/legacyOData suggestions (deduped per
 * suggested target). Faithful port — keeps the legacy grouping/dedup exactly.
 */
export const prepareResults = ({
  resources = [],
  fields = [],
  lookupValues = [],
  legacyODataValues = [],
  expansions = [],
  complexTypes = [],
}: PrepareResultsInput = {}): PreparedVariations => {
  return {
    resources:
      Object.values(
        resources.reduce<Record<string, Json>>((acc, { resourceName, ...suggestion }) => {
          const key = resourceName as string;
          if (!acc?.[key]) {
            acc[key] = { resourceName, suggestions: [] };
          }
          (acc[key].suggestions as Json[]).push(suggestion);
          return acc;
        }, {}),
      ) || [],
    fields: Object.values(
      fields.reduce<Record<string, Record<string, Json>>>((acc, { resourceName, fieldName, ...suggestion }) => {
        const rKey = resourceName as string;
        const fKey = fieldName as string;
        if (!acc?.[rKey]) {
          acc[rKey] = {};
        }
        if (!acc?.[rKey]?.[fKey]) {
          acc[rKey][fKey] = { resourceName, fieldName, suggestions: [] };
        }
        (acc[rKey][fKey].suggestions as Json[]).push(suggestion);
        return acc;
      }, {}),
    ).flatMap(Object.values),
    lookups: Object.values(
      [...lookupValues, ...legacyODataValues].reduce<Record<string, Record<string, Record<string, Json>>>>(
        (acc, { resourceName, fieldName, lookupValue, legacyODataValue, ...rest }) => {
          const rKey = resourceName as string;
          const fKey = fieldName as string;
          if (!acc?.[rKey]) {
            acc[rKey] = {};
          }
          if (!acc?.[rKey]?.[fKey]) {
            acc[rKey][fKey] = {};
          }

          const lookupKey = `${legacyODataValue}${lookupValue}`;

          if (!acc?.[rKey]?.[fKey]?.[lookupKey]) {
            acc[rKey][fKey][lookupKey] = {
              resourceName,
              fieldName,
              legacyODataValue,
              lookupValue,
              suggestions: [],
            };
          }

          const suggestions = acc[rKey][fKey][lookupKey].suggestions as Json[];
          if (
            !suggestions.some(
              (x) =>
                (x as Json)?.suggestedLookupValue === (rest as Json)?.suggestedLookupValue &&
                (x as Json)?.suggestedLegacyODataValue === (rest as Json)?.suggestedLegacyODataValue,
            )
          ) {
            suggestions.push({ ...rest });
          }

          return acc;
        },
        {},
      ),
    ).flatMap((item) => Object.values(Object.values(item).flatMap(Object.values))),
    expansions,
    complexTypes,
  };
};
