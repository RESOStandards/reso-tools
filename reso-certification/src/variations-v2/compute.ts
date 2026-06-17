/**
 * Variations v2 — /compute (read path), clean reimplementation.
 *
 * A faithful re-orchestration of the legacy `computeVariations` walk into one
 * `resolveLevel`-style descent (resource → field → lookup / legacyOData),
 * collapsing the 4× copy-paste. It REUSES the proven legacy leaf primitives
 * (buildMetadataMap, getDDWikiUrl, classifySuggestionStrategy, normalize,
 * prepareResults) so only the walk is new code — keeping parity risk localized.
 *
 * Pure function: reference metadata is injected (no fetch), so it is trivially
 * testable and portable to the cert-backend `/compute` handler.
 *
 * Behavior is faithful to legacy EXCEPT the type-aware annotation gate
 * (`applyIntEnumFix`, default on): for Edm.Int* enums the StandardName-derived
 * lookupValue is ignored — only the machine legacyODataValue is evaluated.
 * Set `applyIntEnumFix: false` to reproduce legacy exactly (used by parity tests).
 */

import { createRequire } from 'node:module';
import { CURRENT_DD_VERSION } from '../sdk/dd-versions.js';

const require = createRequire(import.meta.url);
const { buildMetadataMap } = require('../legacy/common.js');
const {
  MIN_MATCHING_LENGTH,
  CLOSE_MATCH_DISTANCE,
  DEFAULT_FUZZINESS,
  MATCHING_STRATEGIES,
  normalizeDataElementName,
  classifySuggestionStrategy,
  getDDWikiUrl,
  prepareResults,
} = require('../legacy/lib/variations/index.js');
const { distance } = require('fastest-levenshtein');

type Json = Record<string, unknown>;

interface ComputeInput {
  readonly metadataReportJson: Json;
  readonly referenceMetadata: Json;
  readonly suggestionsMap?: Json;
  readonly fuzziness?: number;
  readonly version?: string;
  /** Type-aware Int* annotation fix. Default on; off reproduces legacy. */
  readonly applyIntEnumFix?: boolean;
  /** Major version currently in force (default: major of `version`). */
  readonly currentMajor?: number;
  /** Tag variations must-fix/warning by targetMajor. Default on; off = faithful (legacy shape). */
  readonly applyVersionBucketing?: boolean;
}

interface Accumulator {
  resources: Json[];
  fields: Json[];
  lookupValues: Json[];
  legacyODataValues: Json[];
  expansions: Json[];
  complexTypes: Json[];
}

/**
 * True when a suggested lookup target is already present in the provider's
 * metadata, in EITHER form (wire/legacyOData or display/lookupValue incl. the
 * StandardName annotation). Form-agnostic — mirrors the legacy closure.
 */
const isSuggestedLookupTargetPresent = (
  reportMap: Json,
  { suggestedResourceName, suggestedFieldName, suggestedLegacyODataValue, suggestedLookupValue }: Json,
): boolean => {
  const field = (reportMap as never)?.[suggestedResourceName as never]?.[suggestedFieldName as never] as
    | { legacyODataValues?: Json; lookupValues?: Json }
    | undefined;
  if (!field) return false;
  return !!(
    field.legacyODataValues?.[suggestedLegacyODataValue as never] ||
    field.lookupValues?.[suggestedLookupValue as never] ||
    Object.values(field.lookupValues ?? {}).some((entry) => {
      const { standardLookupValue = null } = entry as Json;
      return !!suggestedLookupValue && suggestedLookupValue === standardLookupValue;
    })
  );
};

/**
 * Shared machine-matching pass: substring (incl. case/punctuation-insensitive
 * exact) then edit distance, against the provided standard values. When an element
 * produces any exact match, only the exact(s) are emitted and the rest are filtered
 * out. The edit-distance budget uses Math.floor uniformly across all four levels.
 */
const machineMatch = (
  localValue: string,
  standardValues: ReadonlyArray<string>,
  hasStandard: (standardValue: string) => boolean,
  makeSuggestion: (standardValue: string, extra: Json) => Json,
  collection: Json[],
  fuzziness: number,
): void => {
  const normalizedLocal = normalizeDataElementName(localValue);
  const isMinMatchingLength = (localValue?.length ?? 0) > MIN_MATCHING_LENGTH;
  const produced: Json[] = [];

  for (const standardValue of standardValues) {
    if (hasStandard(standardValue)) continue;

    const normalizedStandard = normalizeDataElementName(standardValue);
    const isExactMatch = !!(localValue !== standardValue && normalizedLocal === normalizedStandard);
    const isSubstringMatch = !!(
      isMinMatchingLength &&
      ((normalizedStandard?.length > MIN_MATCHING_LENGTH && normalizedLocal.includes(normalizedStandard)) ||
        (normalizedLocal?.length > MIN_MATCHING_LENGTH && normalizedStandard.includes(normalizedLocal)))
    );

    if (isExactMatch || isSubstringMatch) {
      const suggestion = makeSuggestion(standardValue, { strategy: MATCHING_STRATEGIES.SUBSTRING });
      if (isExactMatch) suggestion.exactMatch = true;
      produced.push(suggestion);
    } else if (isMinMatchingLength) {
      const d = distance(normalizedLocal, normalizedStandard);
      const maxDistance = Math.floor(fuzziness * (localValue?.length ?? 0));
      if (d <= maxDistance) {
        const extra: Json = { distance: d, maxDistance, strategy: MATCHING_STRATEGIES.EDIT_DISTANCE };
        if (d <= CLOSE_MATCH_DISTANCE) extra.closeMatch = true;
        produced.push(makeSuggestion(standardValue, extra));
      }
    }
  }

  // Exact filters the rest: if this element produced any exact match, emit only the exact(s)
  // and drop every substring / edit-distance suggestion; otherwise emit all that were produced.
  const exacts = produced.filter((s) => s.exactMatch === true);
  collection.push(...(exacts.length ? exacts : produced));
};

/**
 * Emit a suggestion-set unless any one suggestion's target is already present
 * (entry-level any-one suppression). `present` decides satisfaction; `emit`
 * maps each surviving suggestion to its output shape.
 */
const emitSuggestionsUnlessSatisfied = (
  suggestions: ReadonlyArray<Json>,
  present: (s: Json) => boolean,
  emit: (s: Json) => Json[],
  collection: Json[],
): void => {
  const satisfied = suggestions.some(present) ?? false;
  if (!satisfied) collection.push(...suggestions.flatMap(emit));
};

/**
 * Tag each variation with its enforcement bucket: must-fix when any suggestion
 * applies now (targetMajor <= currentMajor, or absent — machine matches /
 * current major), warning when every suggestion targets a future major. Items
 * with no suggestions (expansions, complex types) are current-major must-fix.
 */
const bucketEnforcement = (variations: Json, currentMajor: number): void => {
  for (const level of ['resources', 'fields', 'lookups', 'expansions', 'complexTypes']) {
    for (const item of (variations[level] as Json[]) ?? []) {
      const suggestions = (item.suggestions as Json[]) ?? [];
      const mustFix =
        suggestions.length === 0
          ? true
          : suggestions.some((s) => s.targetMajor == null || (s.targetMajor as number) <= currentMajor);
      item.enforcement = mustFix ? 'must-fix' : 'warning';
    }
  }
};

export const computeVariationsV2 = ({
  metadataReportJson,
  referenceMetadata,
  suggestionsMap = {},
  fuzziness = DEFAULT_FUZZINESS,
  version = CURRENT_DD_VERSION,
  applyIntEnumFix = true,
  currentMajor,
  applyVersionBucketing = true,
}: ComputeInput): { description: string; version: string; fuzziness: number; variations: Json } => {
  const out: Accumulator = { resources: [], fields: [], lookupValues: [], legacyODataValues: [], expansions: [], complexTypes: [] };

  const { metadataMap: standardMetadataMap = {} } = buildMetadataMap(referenceMetadata);
  const { metadataMap: metadataReportMap = {} } = buildMetadataMap(metadataReportJson);
  const sMap = suggestionsMap as Json;

  for (const resourceName of Object.keys(metadataReportMap)) {
    resolveResource(resourceName, { metadataReportMap, standardMetadataMap, sMap, fuzziness, version, applyIntEnumFix, out });
  }

  const variations = prepareResults(out) as Json;
  if (applyVersionBucketing) {
    bucketEnforcement(variations, currentMajor ?? Math.floor(Number.parseFloat(version)));
  }

  return {
    description: 'Data Dictionary Variations Report',
    version,
    fuzziness: Number.parseFloat(String(fuzziness)),
    variations,
  };
};

interface Ctx {
  metadataReportMap: Json;
  standardMetadataMap: Json;
  sMap: Json;
  fuzziness: number;
  version: string;
  applyIntEnumFix: boolean;
  out: Accumulator;
}

const resolveResource = (resourceName: string, ctx: Ctx): void => {
  const { metadataReportMap, standardMetadataMap, sMap, fuzziness, version, out } = ctx;
  const isStandardResource = !!standardMetadataMap?.[resourceName];
  const { ignored = false, suggestions = [] } = (sMap?.[resourceName] as Json) ?? {};

  if (ignored) return;

  if ((suggestions as Json[])?.length) {
    emitSuggestionsUnlessSatisfied(
      suggestions as Json[],
      (s) => !!(metadataReportMap?.[s.suggestedResourceName as never] ||
        Object.values((metadataReportMap?.[s.suggestedResourceName as never] as Json) ?? {}).some((entry) => {
          const { standardResourceName = null } = entry as Json;
          return !!s.suggestedResourceName && s.suggestedResourceName === standardResourceName;
        })),
      ({ suggestedResourceName, isAdminReview, isFastTrack, ...rest }) => [{
        resourceName,
        suggestedResourceName,
        strategy: classifySuggestionStrategy({ isAdminReview, isFastTrack }),
        ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName: suggestedResourceName }),
        ...rest,
      }],
      out.resources,
    );
    return;
  }

  if (!isStandardResource) {
    machineMatch(
      resourceName,
      Object.keys(standardMetadataMap),
      (standardResourceName) => !!metadataReportMap?.[standardResourceName as never],
      (suggestedResourceName, extra) => ({
        resourceName,
        suggestedResourceName,
        ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName: suggestedResourceName }),
        ...extra,
      }),
      out.resources,
      fuzziness,
    );
    return;
  }

  // standard resource → descend to fields
  for (const fieldName of Object.keys((metadataReportMap?.[resourceName] as Json) ?? {})) {
    resolveField(resourceName, fieldName, ctx);
  }
};

const resolveField = (resourceName: string, fieldName: string, ctx: Ctx): void => {
  const { metadataReportMap, standardMetadataMap, sMap, fuzziness, version, out } = ctx;
  const stdResource = (standardMetadataMap?.[resourceName] as Json) ?? {};
  const reportField = (metadataReportMap?.[resourceName] as Json)?.[fieldName] as Json;
  const isStandardField = !!stdResource?.[fieldName];
  const { ignored = false, suggestions = [] } = (((sMap?.[resourceName] as Json) ?? {})?.[fieldName] as Json) ?? {};

  // standard expansion that the provider didn't model as an expansion — cannot be ignored
  const isStandardExpansion = !!(stdResource?.[fieldName] as Json)?.isExpansion;
  if (isStandardExpansion && !reportField?.isExpansion) {
    out.expansions.push({
      resourceName,
      fieldName,
      strategy: MATCHING_STRATEGIES.SUBSTRING,
      exactMatch: true,
      ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName, fieldName }),
      message: `The '${fieldName}' field MUST be defined as an OData expansion.`,
    });
    return;
  }

  if (ignored) return;

  if ((suggestions as Json[])?.length) {
    emitSuggestionsUnlessSatisfied(
      suggestions as Json[],
      (s) => !!((metadataReportMap?.[s.suggestedResourceName as never] as Json)?.[s.suggestedFieldName as never] ||
        Object.values(((metadataReportMap?.[s.suggestedResourceName as never] as Json) ?? {})?.[s.suggestedFieldName as never] ?? {}).some((entry) => {
          const { standardFieldName = null } = entry as Json;
          return !!s.suggestedFieldName && s.suggestedFieldName === standardFieldName;
        })),
      ({ suggestedResourceName, suggestedFieldName, isAdminReview, isFastTrack, ...rest }) => [{
        resourceName,
        fieldName,
        suggestedResourceName,
        suggestedFieldName,
        strategy: classifySuggestionStrategy({ isAdminReview, isFastTrack }),
        ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName: suggestedResourceName, fieldName: suggestedFieldName }),
        ...rest,
      }],
      out.fields,
    );
    return;
  }

  if (!isStandardField) {
    if (reportField?.isExpansion) return; // expansion fields aren't name-matched
    machineMatch(
      fieldName,
      Object.keys(stdResource).filter((sf) => !(stdResource?.[sf] as Json)?.isExpansion),
      (standardFieldName) => !!(metadataReportMap?.[resourceName] as Json)?.[standardFieldName as never],
      (suggestedFieldName, extra) => ({
        resourceName,
        fieldName,
        suggestedFieldName,
        ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName, fieldName: suggestedFieldName }),
        ...extra,
      }),
      out.fields,
      fuzziness,
    );
    return;
  }

  // standard lookup field → descend to lookup values + legacyOData values
  resolveLookupsAndLegacy(resourceName, fieldName, ctx);
};

const resolveLookupsAndLegacy = (resourceName: string, fieldName: string, ctx: Ctx): void => {
  const { metadataReportMap, standardMetadataMap, sMap, fuzziness, version, applyIntEnumFix, out } = ctx;
  const reportField = ((metadataReportMap?.[resourceName] as Json)?.[fieldName] as Json) ?? {};
  const stdField = ((standardMetadataMap?.[resourceName] as Json)?.[fieldName] as Json) ?? {};
  const { lookupValues = {}, legacyODataValues = {} } = reportField as { lookupValues?: Json; legacyODataValues?: Json };
  const fieldSuggestions = ((sMap?.[resourceName] as Json) ?? {})?.[fieldName] as Json;

  // ── lookup values ──
  const standardLookupValues = (stdField?.lookupValues as Json) ?? {};
  for (const entry of Object.values(lookupValues ?? {}) as Json[]) {
    // Int* fix: a machine enum's lookupValue is StandardName-derived; ignore it
    // (the machine value is evaluated via legacyODataValues below). Non-string
    // enums leave `isStringEnumeration` undefined; only string enums set it true.
    if (applyIntEnumFix && !entry.isStringEnumeration) continue;

    const { lookupValue, standardLookupValue } = entry;
    const isStandardLookupValue = !!(standardLookupValues?.[lookupValue as never] || standardLookupValues?.[standardLookupValue as never]);
    const hasStandardLookupMapping = !!(standardLookupValue && standardLookupValues?.[standardLookupValue as never]);
    const { ignored = false, suggestions = [] } = (fieldSuggestions?.[lookupValue as never] as Json) ?? {};

    if (ignored || hasStandardLookupMapping) continue;

    if ((suggestions as Json[])?.length) {
      emitSuggestionsUnlessSatisfied(
        suggestions as Json[],
        (s) => isSuggestedLookupTargetPresent(metadataReportMap, s),
        ({ suggestedResourceName, suggestedFieldName, suggestedLookupValue, isAdminReview, isFastTrack, ...rest }) => [{
          resourceName,
          fieldName,
          lookupValue,
          suggestedResourceName,
          suggestedFieldName,
          suggestedLookupValue,
          strategy: classifySuggestionStrategy({ isAdminReview, isFastTrack }),
          ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName: suggestedResourceName, fieldName: suggestedFieldName, lookupValue: suggestedLookupValue }),
          ...rest,
        }],
        out.lookupValues,
      );
    } else if (!isStandardLookupValue) {
      machineMatch(
        lookupValue as string,
        Object.keys(standardLookupValues),
        (sLV) => !!(reportField.lookupValues as Json)?.[sLV as never],
        (suggestedLookupValue, extra) => ({
          resourceName,
          fieldName,
          lookupValue,
          ...(lookupValue !== suggestedLookupValue ? { suggestedLookupValue, ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName, fieldName, lookupValue: suggestedLookupValue }) } : {}),
          ...extra,
        }),
        out.lookupValues,
        fuzziness,
      );
    }
  }

  // ── legacyOData values (machine) ──
  const standardLegacyODataValues = (stdField?.legacyODataValues as Json) ?? {};
  for (const entry of Object.values(legacyODataValues ?? {}) as Json[]) {
    const { legacyODataValue } = entry;
    const isStandardLegacyODataValue = !!standardLegacyODataValues?.[legacyODataValue as never];
    const { ignored = false, suggestions = [] } = (fieldSuggestions?.[legacyODataValue as never] as Json) ?? {};

    if (ignored) continue;

    if ((suggestions as Json[])?.length) {
      emitSuggestionsUnlessSatisfied(
        suggestions as Json[],
        (s) => isSuggestedLookupTargetPresent(metadataReportMap, s),
        ({ suggestedResourceName, suggestedFieldName, suggestedLegacyODataValue, suggestedLookupValue, isAdminReview, isFastTrack, ...rest }) => [{
          resourceName,
          fieldName,
          legacyODataValue,
          suggestedResourceName,
          suggestedFieldName,
          suggestedLegacyODataValue,
          ...(suggestedLookupValue != null ? { suggestedLookupValue } : {}),
          strategy: classifySuggestionStrategy({ isAdminReview, isFastTrack }),
          ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName: suggestedResourceName, fieldName: suggestedFieldName, lookupValue: suggestedLegacyODataValue }),
          ...rest,
        }],
        out.legacyODataValues,
      );
    } else if (!isStandardLegacyODataValue) {
      machineMatch(
        legacyODataValue as string,
        Object.keys(standardLegacyODataValues),
        (sODV) => !!(reportField.legacyODataValues as Json)?.[sODV as never],
        (suggestedLegacyODataValue, extra) => ({
          resourceName,
          fieldName,
          legacyODataValue,
          ...(legacyODataValue !== suggestedLegacyODataValue ? { suggestedLegacyODataValue, ddWikiUrl: getDDWikiUrl({ version, standardMetadataMap, resourceName, fieldName, legacyODataValue: suggestedLegacyODataValue }) } : {}),
          ...extra,
        }),
        out.legacyODataValues,
        fuzziness,
      );
    }
  }
};
