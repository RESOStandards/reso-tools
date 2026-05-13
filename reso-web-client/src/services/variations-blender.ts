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

/**
 * Provenance fields attached to every variation so admins can tell
 * which provider:recipient combination produced it. Carried through
 * the blend layer from the parent report context. Optional so older
 * reports (and pre-provenance fixtures) still parse cleanly.
 */
export interface VariationProvenance {
  /** Provider's Organization Unique Identifier. */
  readonly providerUoi?: string;
  /** Provider's Unique System Identifier (which system they ran from). */
  readonly providerUsi?: string;
  /** Recipient's Organization Unique Identifier. */
  readonly recipientUoi?: string;
  /** DD version that produced the variation (e.g., '2.0', '2.1'). */
  readonly version?: string;
}

/** A single blended variation — one non-standard item with its suggestions. */
export interface BlendedVariation extends VariationProvenance {
  readonly resourceName: string;
  readonly fieldName?: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly suggestions: ReadonlyArray<BlendedSuggestion>;
  readonly ignored: boolean;
  readonly source: 'machine' | 'service' | 'blended';
  readonly type: 'resource' | 'field' | 'lookup' | 'expansion' | 'complexType';
  /** Conversation threads from previous report saves (service data). */
  readonly conversations?: ReadonlyArray<{
    readonly timestamp: string;
    readonly from: string;
    readonly to: string;
    readonly message: string;
    readonly attachments?: ReadonlyArray<{ readonly displayText: string; readonly url: string }>;
  }>;
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

/**
 * Shape of the buckets carried inside a variations report.
 * The DD pipeline writes these directly as the file body; older callers wrap them in `{ variations: {...} }`.
 * The blender accepts either shape — see `extractCategories` below.
 */
interface VariationsBuckets {
  readonly resources?: ReadonlyArray<LocalVariationItem>;
  readonly fields?: ReadonlyArray<LocalVariationItem>;
  readonly lookups?: ReadonlyArray<LocalVariationItem>;
  readonly expansions?: ReadonlyArray<LocalVariationItem>;
  readonly complexTypes?: ReadonlyArray<LocalVariationItem>;
}

interface LocalVariationsReport extends VariationsBuckets {
  readonly description?: string;
  readonly version?: string;
  readonly generatedOn?: string;
  readonly fuzziness?: number;
  /** Provider UOI captured at variation-detection time (DD pipeline writes this). */
  readonly providerUoi?: string;
  /** Provider USI captured at variation-detection time. */
  readonly providerUsi?: string;
  /** Recipient UOI captured at variation-detection time. */
  readonly recipientUoi?: string;
  /** Optional wrapper shape some legacy writers used. The blender prefers top-level buckets when present. */
  readonly variations?: VariationsBuckets;
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
  serviceSuggestions: ServiceSuggestionsMap,
  provenance: VariationProvenance
): BlendedVariation => {
  const serviceData = getServiceData(serviceSuggestions, item.resourceName, item.fieldName, item.lookupValue);

  if (serviceData?.ignored) {
    return {
      ...provenance,
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
      ...provenance,
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
    ...provenance,
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
 * @param provenance - provider/recipient/version metadata to stamp on every emitted variation.
 *   Optional; if omitted the variations carry no provenance fields. The DD version on
 *   `provenance.version` overrides whatever `localReport.version` says, since the caller
 *   knows the canonical job-time version while the report file may be older.
 * @returns unified report ready for UI display
 */
export const blendVariations = (
  localReport: LocalVariationsReport,
  serviceSuggestions: ServiceSuggestionsMap = {},
  provenance: VariationProvenance = {}
): BlendedVariationsReport => {
  // Caller-supplied provenance wins, but fall back to fields embedded
  // in the report file itself. The DD pipeline writes these top-level
  // so a standalone file (without surrounding job state) still carries
  // who-produced-it information.
  const effectiveProvenance: VariationProvenance = {
    providerUoi: provenance.providerUoi ?? localReport.providerUoi,
    providerUsi: provenance.providerUsi ?? localReport.providerUsi,
    recipientUoi: provenance.recipientUoi ?? localReport.recipientUoi,
    version: provenance.version ?? localReport.version,
  };
  const variations: BlendedVariation[] = [];

  // Accept either shape: top-level buckets (what the DD pipeline writes today) or
  // a `{ variations: {...} }` wrapper (older convention). Prefer top-level when present.
  const buckets: VariationsBuckets = (
    localReport.fields || localReport.lookups || localReport.resources || localReport.expansions || localReport.complexTypes
      ? localReport
      : (localReport.variations ?? {})
  );

  // Process each category
  const categories: ReadonlyArray<{ items: ReadonlyArray<LocalVariationItem>; type: BlendedVariation['type'] }> = [
    { items: buckets.resources ?? [], type: 'resource' },
    { items: buckets.fields ?? [], type: 'field' },
    { items: buckets.lookups ?? [], type: 'lookup' },
    { items: buckets.expansions ?? [], type: 'expansion' },
    { items: buckets.complexTypes ?? [], type: 'complexType' },
  ];

  for (const { items, type } of categories) {
    for (const item of items) {
      variations.push(blendItem(item, type, serviceSuggestions, effectiveProvenance));
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
    description: localReport.description ?? 'Data Dictionary Variations Report',
    version: localReport.version ?? '',
    generatedOn: localReport.generatedOn ?? new Date().toISOString(),
    // Default fuzziness = 0.25 (25% of word length) — the value cert-utils
    // uses for its substring/edit-distance match. A value of 0 means
    // "exact match only" which surfaces no near-misses.
    fuzziness: localReport.fuzziness ?? 0.25,
    variations,
    counts,
  };
};

/**
 * Build a BlendedVariationsReport directly from a saved
 * variations-report.json payload (the shape returned by
 * getVariationsReport from the service). The saved report stores
 * each variation as a flat `change` record — no fields/lookups
 * buckets — and the decisions (ignore/fast-track/remove) live on
 * the change as flags rather than on a separate review state.
 *
 * Used by the admin's queue drill-in path, where there is no local
 * cert metadata to blend with (provider has already produced and
 * decided on these items; admin just needs to view + adjust).
 */
export const buildBlendedFromSavedReport = (
  saved: {
    readonly description?: string;
    readonly version: string;
    readonly providerUoi?: string;
    readonly providerUsi?: string;
    readonly recipientUoi?: string;
    readonly changes?: ReadonlyArray<Record<string, unknown>>;
  },
  provenance: VariationProvenance = {}
): BlendedVariationsReport => {
  const merged: VariationProvenance = {
    providerUoi: provenance.providerUoi ?? saved.providerUoi,
    providerUsi: provenance.providerUsi ?? saved.providerUsi,
    recipientUoi: provenance.recipientUoi ?? saved.recipientUoi,
    version: provenance.version ?? saved.version,
  };

  const changes = saved.changes ?? [];
  const variations: BlendedVariation[] = changes
    .filter(c => typeof c.resourceName === 'string' && (c.resourceName as string).length > 0)
    .map((c) => {
      // Type inference: lookup > field > resource. Expansion/complex
      // are recognized by suggested-related fields. Falls back to
      // resource for a bare resourceName.
      const hasLookup = !!c.lookupValue || !!c.legacyODataValue;
      const hasField = !!c.fieldName;
      const hasRelated = !!c.suggestedRelatedResourceName
        || !!c.suggestedRelatedFieldName
        || !!c.suggestedRelatedLookupValue;
      const type: BlendedVariation['type'] = hasLookup
        ? 'lookup'
        : hasRelated
          ? 'expansion'
          : hasField
            ? 'field'
            : 'resource';

      // One BlendedSuggestion per change. The saved report doesn't
      // carry the matching strategy that the local cert run captured,
      // so we surface the saved suggestion under a generic label.
      const suggestion: BlendedSuggestion = {
        suggestedResourceName: c.suggestedResourceName as string | undefined,
        suggestedFieldName: c.suggestedFieldName as string | undefined,
        suggestedLookupValue: c.suggestedLookupValue as string | undefined,
        suggestedLegacyODataValue: c.suggestedLegacyODataValue as string | undefined,
        suggestedRelatedResourceName: c.suggestedRelatedResourceName as string | undefined,
        suggestedRelatedFieldName: c.suggestedRelatedFieldName as string | undefined,
        suggestedRelatedLookupValue: c.suggestedRelatedLookupValue as string | undefined,
        strategy: (c.strategy as string | undefined) ?? 'Saved Suggestion',
        isFastTrack: c.flaggedForFastTrack === true,
      };
      const hasAnySuggestion = !!(suggestion.suggestedResourceName
        || suggestion.suggestedFieldName
        || suggestion.suggestedLookupValue
        || suggestion.suggestedLegacyODataValue
        || suggestion.suggestedRelatedResourceName
        || suggestion.suggestedRelatedFieldName
        || suggestion.suggestedRelatedLookupValue);

      return {
        resourceName: c.resourceName as string,
        fieldName: c.fieldName as string | undefined,
        lookupValue: c.lookupValue as string | undefined,
        legacyODataValue: c.legacyODataValue as string | undefined,
        suggestions: hasAnySuggestion ? [suggestion] : [],
        ignored: c.ignore === true,
        source: 'service',
        type,
        conversations: c.conversations as BlendedVariation['conversations'],
        ...merged,
      };
    });

  return {
    description: saved.description ?? 'Data Dictionary Variations Report',
    version: saved.version,
    generatedOn: new Date().toISOString(),
    fuzziness: 0.25,
    providerUoi: merged.providerUoi,
    providerUsi: merged.providerUsi,
    recipientUoi: merged.recipientUoi,
    variations,
    counts: {
      resources: variations.filter(v => v.type === 'resource').length,
      fields: variations.filter(v => v.type === 'field').length,
      lookups: variations.filter(v => v.type === 'lookup').length,
      expansions: variations.filter(v => v.type === 'expansion').length,
      complexTypes: variations.filter(v => v.type === 'complexType').length,
      total: variations.length,
      ignored: variations.filter(v => v.ignored).length,
      fastTrack: variations.filter(v => v.suggestions.some(s => s.isFastTrack)).length,
      adminReview: variations.filter(v => v.suggestions.some(s => s.isAdminReview)).length,
    },
  };
};
