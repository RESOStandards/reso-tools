/**
 * Variations Blender — merges local computeVariations() output with
 * service suggestions from services.reso.org.
 *
 * Rules:
 * - Service suggestions (human-provided) override machine suggestions
 * - Ignored items from the service suppress the local variation
 * - Fast Track items are promoted with higher priority
 * - Items only in the local report (no service data) keep machine suggestions
 * - Items only in the service (not in local report) are excluded
 *   (we only show things the provider actually has in their metadata)
 *
 * Output is a unified list ready for the UI, with each variation
 * tagged with its source (machine, service, or both).
 */

// ── Types ────────────────────────────────────────────────────────────

/** A suggestion from either machine matching or the service. */
export interface BlendedSuggestion {
  readonly suggestedResourceName?: string;
  readonly suggestedFieldName?: string;
  readonly suggestedLookupValue?: string;
  readonly suggestedLegacyODataValue?: string;
  readonly suggestedRelatedResourceName?: string;
  readonly suggestedRelatedFieldName?: string;
  readonly suggestedRelatedLookupValue?: string;
  readonly strategy: string;
  readonly ddWikiUrl?: string;
  readonly isFastTrack?: boolean;
  readonly isAdminReview?: boolean;
  readonly exactMatch?: boolean;
  readonly closeMatch?: boolean;
  readonly distance?: number;
  readonly maxDistance?: number;
}

/** A single blended variation — one non-standard item with its suggestions. */
export interface BlendedVariation {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly suggestions: ReadonlyArray<BlendedSuggestion>;
  readonly ignored: boolean;
  readonly source: 'machine' | 'service' | 'blended';
  readonly type: 'resource' | 'field' | 'lookup' | 'expansion' | 'complexType';
}

/** The full blended variations report ready for UI display. */
export interface BlendedVariationsReport {
  readonly description: string;
  readonly version: string;
  readonly generatedOn: string;
  readonly fuzziness: number;
  /** Provider UOI — needed for save/lock operations. */
  readonly providerUoi?: string;
  /** Provider USI — needed for save/lock operations. */
  readonly providerUsi?: string;
  /** Recipient UOI — needed for save/lock operations. */
  readonly recipientUoi?: string;
  readonly variations: ReadonlyArray<BlendedVariation>;
  readonly counts: {
    readonly resources: number;
    readonly fields: number;
    readonly lookups: number;
    readonly expansions: number;
    readonly complexTypes: number;
    readonly total: number;
    readonly ignored: number;
    readonly fastTrack: number;
    readonly adminReview: number;
  };
}

// ── Input types (from computeVariations output) ──────────────────────

interface LocalVariationItem {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly suggestions: ReadonlyArray<Record<string, unknown>>;
  readonly message?: string;
}

interface LocalVariationsReport {
  readonly description: string;
  readonly version: string;
  readonly generatedOn: string;
  readonly fuzziness: number;
  readonly variations: {
    readonly resources: ReadonlyArray<LocalVariationItem>;
    readonly fields: ReadonlyArray<LocalVariationItem>;
    readonly lookups: ReadonlyArray<LocalVariationItem>;
    readonly expansions: ReadonlyArray<LocalVariationItem>;
    readonly complexTypes: ReadonlyArray<LocalVariationItem>;
  };
}

/** Service suggestions map shape (from searchVariations API). */
interface ServiceSuggestionsMap {
  readonly [resourceName: string]: {
    readonly [fieldName: string]: {
      readonly suggestions?: ReadonlyArray<Record<string, unknown>>;
      readonly ignored?: boolean;
      readonly isFastTrack?: boolean;
      readonly isAdminReview?: boolean;
      readonly [lookupValue: string]: unknown;
    };
  };
}

// ── Blender ──────────────────────────────────────────────────────────

/** Convert a raw suggestion object to a typed BlendedSuggestion. */
const toBlendedSuggestion = (raw: Record<string, unknown>, source: 'machine' | 'service'): BlendedSuggestion => ({
  suggestedResourceName: raw.suggestedResourceName as string | undefined,
  suggestedFieldName: raw.suggestedFieldName as string | undefined,
  suggestedLookupValue: raw.suggestedLookupValue as string | undefined,
  suggestedLegacyODataValue: raw.suggestedLegacyODataValue as string | undefined,
  suggestedRelatedResourceName: raw.suggestedRelatedResourceName as string | undefined,
  suggestedRelatedFieldName: raw.suggestedRelatedFieldName as string | undefined,
  suggestedRelatedLookupValue: raw.suggestedRelatedLookupValue as string | undefined,
  strategy: (raw.strategy as string) ?? (raw.isFastTrack ? 'Fast Track' : raw.isAdminReview ? 'Admin Review' : source === 'service' ? 'Suggestion' : 'Unknown'),
  ddWikiUrl: raw.ddWikiUrl as string | undefined,
  isFastTrack: (raw.isFastTrack as boolean) ?? false,
  isAdminReview: (raw.isAdminReview as boolean) ?? false,
  exactMatch: (raw.exactMatch as boolean) ?? false,
  closeMatch: (raw.closeMatch as boolean) ?? false,
  distance: raw.distance as number | undefined,
  maxDistance: raw.maxDistance as number | undefined,
});

/** Look up service data for a specific variation item. */
const getServiceData = (
  serviceSuggestions: ServiceSuggestionsMap,
  resourceName: string,
  fieldName?: string,
  lookupValue?: string
): { suggestions: ReadonlyArray<Record<string, unknown>>; ignored: boolean } | null => {
  const resourceData = serviceSuggestions[resourceName];
  if (!resourceData) return null;

  if (!fieldName) {
    // Resource-level
    const data = resourceData as unknown as { suggestions?: ReadonlyArray<Record<string, unknown>>; ignored?: boolean };
    if (!data.suggestions && !data.ignored) return null;
    return { suggestions: data.suggestions ?? [], ignored: data.ignored ?? false };
  }

  const fieldData = resourceData[fieldName];
  if (!fieldData) return null;

  if (!lookupValue) {
    // Field-level
    if (!fieldData.suggestions && !fieldData.ignored) return null;
    return { suggestions: (fieldData.suggestions ?? []) as ReadonlyArray<Record<string, unknown>>, ignored: fieldData.ignored ?? false };
  }

  // Lookup-level
  const lookupData = fieldData[lookupValue] as { suggestions?: ReadonlyArray<Record<string, unknown>>; ignored?: boolean } | undefined;
  if (!lookupData || typeof lookupData !== 'object') return null;
  if (!lookupData.suggestions && !lookupData.ignored) return null;
  return { suggestions: lookupData.suggestions ?? [], ignored: lookupData.ignored ?? false };
};

/** Blend a single local variation item with service data. */
const blendItem = (
  item: LocalVariationItem,
  type: BlendedVariation['type'],
  serviceSuggestions: ServiceSuggestionsMap
): BlendedVariation => {
  const serviceData = getServiceData(serviceSuggestions, item.resourceName, item.fieldName, item.lookupValue);

  if (serviceData?.ignored) {
    return {
      resourceName: item.resourceName,
      fieldName: item.fieldName,
      lookupValue: item.lookupValue,
      legacyODataValue: item.legacyODataValue,
      suggestions: [],
      ignored: true,
      source: 'service',
      type,
    };
  }

  if (serviceData && serviceData.suggestions.length > 0) {
    // Service suggestions override machine suggestions
    return {
      resourceName: item.resourceName,
      fieldName: item.fieldName,
      lookupValue: item.lookupValue,
      legacyODataValue: item.legacyODataValue,
      suggestions: serviceData.suggestions.map(s => toBlendedSuggestion(s, 'service')),
      ignored: false,
      source: item.suggestions.length > 0 ? 'blended' : 'service',
      type,
    };
  }

  // Machine suggestions only
  return {
    resourceName: item.resourceName,
    fieldName: item.fieldName,
    lookupValue: item.lookupValue,
    legacyODataValue: item.legacyODataValue,
    suggestions: item.suggestions.map(s => toBlendedSuggestion(s, 'machine')),
    ignored: false,
    source: 'machine',
    type,
  };
};

/**
 * Blend local computeVariations() output with service suggestions.
 *
 * @param localReport - output from computeVariations()
 * @param serviceSuggestions - output from searchVariations API (the mappings field)
 * @returns unified report ready for UI display
 */
export const blendVariations = (
  localReport: LocalVariationsReport,
  serviceSuggestions: ServiceSuggestionsMap = {}
): BlendedVariationsReport => {
  const variations: BlendedVariation[] = [];

  // Process each category
  const categories: ReadonlyArray<{ items: ReadonlyArray<LocalVariationItem>; type: BlendedVariation['type'] }> = [
    { items: localReport.variations.resources, type: 'resource' },
    { items: localReport.variations.fields, type: 'field' },
    { items: localReport.variations.lookups, type: 'lookup' },
    { items: localReport.variations.expansions, type: 'expansion' },
    { items: localReport.variations.complexTypes, type: 'complexType' },
  ];

  for (const { items, type } of categories) {
    for (const item of items) {
      variations.push(blendItem(item, type, serviceSuggestions));
    }
  }

  // Count by category
  const counts = {
    resources: variations.filter(v => v.type === 'resource').length,
    fields: variations.filter(v => v.type === 'field').length,
    lookups: variations.filter(v => v.type === 'lookup').length,
    expansions: variations.filter(v => v.type === 'expansion').length,
    complexTypes: variations.filter(v => v.type === 'complexType').length,
    total: variations.length,
    ignored: variations.filter(v => v.ignored).length,
    fastTrack: variations.filter(v => v.suggestions.some(s => s.isFastTrack)).length,
    adminReview: variations.filter(v => v.suggestions.some(s => s.isAdminReview)).length,
  };

  return {
    description: localReport.description,
    version: localReport.version,
    generatedOn: localReport.generatedOn,
    fuzziness: localReport.fuzziness,
    variations,
    counts,
  };
};
