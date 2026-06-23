/**
 * buildMetadataMap — project a RESO metadata report ({ fields, lookups }) into the nested
 * resource → field → entry map the variations matcher walks. Ported verbatim from the legacy cert
 * helper (`reso-certification/src/legacy/common.js` `buildMetadataMap`) into reso-common so the cert
 * SDK and the backend variations matcher (#112) share one universal copy instead of each carrying
 * its own.
 *
 * Pure — no I/O, no Node APIs (browser-safe). Expansion-aware: every field entry carries
 * `isExpansion` / `isComplexType` / `isLookupField`, which the matcher's like-with-like routing reads.
 *
 * Faithful to the legacy: the `Sample{Name}EnumValue` open-enum sentinels are skipped, string
 * enumerations (Edm.String + Lookup Resource) take the annotated display value as the standard while
 * non-string enums record the legacy-OData wire value, and `isComplexType` is *derived* into the map
 * but the `numComplexTypes` stat counts only the *raw* incoming flag (a legacy quirk, preserved).
 */

import type { ResoField, ResoLookup, ResoAnnotation } from './model.js';

const ANNOTATION_STANDARD_NAME = 'RESO.OData.Metadata.StandardName';
const ANNOTATION_DD_WIKI_URL = 'RESO.DDWikiUrl';

/** A string enumeration is an Edm.String-typed lookup (the Lookup Resource representation). */
const isStringEnumeration = (type?: string): boolean => !!type && type.includes('Edm.String');

/** Simple lookup name from a (possibly qualified) type — 'PropertyEnums.Status' → 'Status'. */
const parseLookupName = (lookupName: string): string =>
  lookupName.substring(lookupName.lastIndexOf('.') + 1);

/** The report-field shape `buildMetadataMap` consumes — a `ResoField` plus the optional
 *  `isComplexType` flag the serializer may carry. */
export interface MetadataMapField extends ResoField {
  readonly isComplexType?: boolean;
}

/** Input report: fields + lookups (the serializer's metadata-report shape). */
export interface MetadataMapInput {
  readonly fields?: ReadonlyArray<MetadataMapField>;
  readonly lookups?: ReadonlyArray<ResoLookup>;
}

/** A standard lookup value in the map (display-name form; string-enum or LOV). */
export interface MetadataMapLookupValue {
  readonly type: string;
  readonly lookupName: string;
  readonly lookupValue?: string;
  readonly legacyODataValue?: string;
  readonly ddWikiUrl?: string;
  readonly isStringEnumeration?: boolean;
  readonly standardLookupValue?: string;
}

/** A standard legacy-OData (wire-form) value in the map. */
export interface MetadataMapLegacyValue {
  readonly type: string;
  readonly lookupName: string;
  readonly lookupValue?: string;
  readonly legacyODataValue: string;
  readonly ddWikiUrl?: string;
}

/** One field entry in the metadata map. */
export interface MetadataMapFieldEntry {
  readonly type: string;
  readonly typeName: string;
  readonly nullable: boolean;
  readonly isExpansion: boolean;
  readonly isCollection: boolean;
  readonly isLookupField: boolean;
  readonly isComplexType: boolean;
  readonly ddWikiUrl?: string;
  lookupValues?: Record<string, MetadataMapLookupValue>;
  legacyODataValues?: Record<string, MetadataMapLegacyValue>;
}

/** resource → field → entry. */
export type MetadataMap = Record<string, Record<string, MetadataMapFieldEntry>>;

export interface MetadataMapStats {
  numResources: number;
  numFields: number;
  numLookups: number;
  numExpansions: number;
  numComplexTypes: number;
}

/** Intermediate per-lookupName value collected from the report's lookups. */
interface CollectedLookup {
  readonly lookupValue?: string;
  readonly standardLookupValue?: string;
  readonly legacyODataValue?: string;
  readonly ddWikiUrl?: string;
  readonly isStringEnumeration?: boolean;
}

const extractAnnotations = (
  annotations: ReadonlyArray<ResoAnnotation> = [],
): { lookupValue?: string; ddWikiUrl?: string } =>
  annotations.reduce<{ lookupValue?: string; ddWikiUrl?: string }>((acc, { term, value }) => {
    if (term === ANNOTATION_STANDARD_NAME) acc.lookupValue = value;
    if (term === ANNOTATION_DD_WIKI_URL) acc.ddWikiUrl = value;
    return acc;
  }, {});

const isSampleSentinel = (value?: string): boolean =>
  !!value && value.startsWith('Sample') && value.endsWith('EnumValue');

/**
 * Build the standard metadata map (and stats) from a metadata report. The map is the structure the
 * variations matcher walks: `map[resourceName][fieldName]` carries the field's flags plus, for
 * lookup fields, `lookupValues` (display-name keyed) and `legacyODataValues` (wire-form keyed).
 */
export const buildMetadataMap = (
  { fields = [], lookups = [] }: MetadataMapInput = {},
): { metadataMap: MetadataMap; stats: MetadataMapStats } => {
  const stats: MetadataMapStats = {
    numResources: 0,
    numFields: 0,
    numLookups: 0,
    numExpansions: 0,
    numComplexTypes: 0,
  };

  const lookupMap = lookups.reduce<Record<string, CollectedLookup[]>>(
    (acc, { lookupName, lookupValue, type, annotations = [] }) => {
      (acc[lookupName] ??= []);

      const { lookupValue: annotatedLookupValue, ddWikiUrl } = extractAnnotations(annotations);

      // Open-enum sample sentinels (Sample{Name}EnumValue) are reference scaffolding — never a real
      // standard value; skip them so they never enter the map.
      if (isSampleSentinel(lookupValue) || isSampleSentinel(annotatedLookupValue)) return acc;

      if (isStringEnumeration(type)) {
        // String + Lookup Resource: the standard value is the annotated (display) value.
        acc[lookupName].push({ lookupValue, standardLookupValue: annotatedLookupValue, ddWikiUrl, isStringEnumeration: true });
      } else {
        acc[lookupName].push({ lookupValue: annotatedLookupValue, legacyODataValue: lookupValue, ddWikiUrl });
      }

      stats.numLookups++;
      return acc;
    },
    {},
  );

  const metadataMap = fields.reduce<MetadataMap>((acc, field) => {
    const {
      resourceName,
      fieldName,
      type,
      isExpansion = false,
      isComplexType = false,
      annotations = [],
      typeName = '',
      nullable = true,
      isCollection = false,
    } = field;

    if (!acc[resourceName]) {
      acc[resourceName] = {};
      stats.numResources++;
    }

    const isLookupField = !!lookupMap[type];
    const { ddWikiUrl } = extractAnnotations(annotations);

    const entry: MetadataMapFieldEntry = {
      type,
      typeName,
      nullable,
      isExpansion,
      isCollection,
      isLookupField,
      isComplexType: isComplexType || (!isExpansion && !type.startsWith('Edm.') && !isLookupField),
      ddWikiUrl,
    };
    acc[resourceName][fieldName] = entry;

    if (isLookupField && lookupMap[type]) {
      entry.lookupValues ??= {};
      entry.legacyODataValues ??= {};
      const lookupName = parseLookupName(type);

      for (const { lookupValue, standardLookupValue, legacyODataValue, ddWikiUrl: lvWikiUrl, isStringEnumeration: lvIsStringEnum } of lookupMap[type]) {
        // skip legacyOData matching when using string enumerations
        if (!lvIsStringEnum && legacyODataValue && legacyODataValue.length) {
          entry.legacyODataValues[legacyODataValue] = { type, lookupName, lookupValue, legacyODataValue, ddWikiUrl: lvWikiUrl };
        }

        if (lookupValue && lookupValue.length) {
          const value: MetadataMapLookupValue = { type, lookupName, lookupValue, legacyODataValue, ddWikiUrl: lvWikiUrl, isStringEnumeration: lvIsStringEnum };
          if (standardLookupValue) (value as { standardLookupValue?: string }).standardLookupValue = standardLookupValue;
          entry.lookupValues[lookupValue] = value;
        }
      }
    }

    if (isExpansion) stats.numExpansions++;
    if (isComplexType) stats.numComplexTypes++; // raw flag, NOT the derived value (legacy quirk)
    stats.numFields++;
    return acc;
  }, {});

  return { metadataMap, stats };
};
