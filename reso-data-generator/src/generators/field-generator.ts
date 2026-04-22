import type { ResoField, ResoLookup } from './types.js';

/** Fields that are server-generated or computed — skip during data generation. */
const SKIP_FIELDS = new Set([
  'ModificationTimestamp',
  'OriginalEntryTimestamp',
  'StatusChangeTimestamp',
  'PhotosChangeTimestamp',
  'MajorChangeType'
]);

/** Returns true if the type is an OData enum (non-Edm) type. */
export const isEnumType = (type: string): boolean => !type.startsWith('Edm.');

/** Returns true if the type is a numeric Edm type. */
const isIntType = (type: string): boolean => ['Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.Byte'].includes(type);

/** Returns a random integer between min and max (inclusive). */
export const randomInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

/** Returns a random decimal between min and max with the given number of decimal places. */
export const randomDecimal = (min: number, max: number, decimals = 2): number =>
  Number((Math.random() * (max - min) + min).toFixed(decimals));

/** Returns a random element from an array. */
export const randomChoice = <T>(arr: ReadonlyArray<T>): T => arr[Math.floor(Math.random() * arr.length)];

/** Returns a random boolean. */
const randomBool = (): boolean => Math.random() > 0.5;

/** Generates a random date string within the last N days. */
const randomDate = (daysBack = 730): string => {
  const now = Date.now();
  const offset = Math.floor(Math.random() * daysBack * 24 * 60 * 60 * 1000);
  return new Date(now - offset).toISOString().split('T')[0];
};

/** Generates a random ISO 8601 datetime string within the last N days. */
const randomDateTimeOffset = (daysBack = 730): string => {
  const now = Date.now();
  const offset = Math.floor(Math.random() * daysBack * 24 * 60 * 60 * 1000);
  return new Date(now - offset).toISOString();
};

/** Generates a random time-of-day string (HH:MM:SS). */
const randomTimeOfDay = (): string => {
  const h = String(randomInt(0, 23)).padStart(2, '0');
  const m = String(randomInt(0, 59)).padStart(2, '0');
  return `${h}:${m}:00`;
};

/** Generates a random string value respecting maxLength. */
const randomString = (fieldName: string, index: number, maxLength?: number): string => {
  const val = `Sample ${fieldName} ${index + 1}`;
  if (maxLength && val.length > maxLength) {
    return val.slice(0, maxLength);
  }
  return val;
};

/**
 * Resolves the display value from a lookup entry based on enum mode.
 * In human-friendly mode (string enums), uses the StandardName annotation;
 * in legacy mode (EnumType), uses the CamelCase lookupValue.
 */
export const getLookupDisplayValue = (lookup: ResoLookup, useHumanFriendly: boolean): string => {
  if (!useHumanFriendly) return lookup.lookupValue;
  const stdName = lookup.annotations?.find(a => a.term === 'RESO.OData.Metadata.StandardName');
  return stdName?.value ?? lookup.lookupValue;
};

/**
 * Transforms a lookup map for human-friendly string enum mode.
 * Replaces each lookup entry's lookupValue with its StandardName annotation,
 * so all downstream generator code that references `v.lookupValue`
 * automatically uses the human-friendly display name.
 */
export const transformLookupsForHumanFriendly = (
  lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>
): Record<string, ReadonlyArray<ResoLookup>> => {
  const result: Record<string, ResoLookup[]> = {};
  for (const [type, entries] of Object.entries(lookups)) {
    result[type] = entries.map(entry => ({
      ...entry,
      lookupValue: getLookupDisplayValue(entry, true)
    }));
  }
  return result;
};

/** Check if a lookup value is a placeholder (SampleXxxEnumValue or Sample Xxx Enum Value). */
export const isPlaceholderValue = (value: string): boolean =>
  value.startsWith('Sample') && (value.endsWith('EnumValue') || value.endsWith('Enum Value'));

const RESO_ENUM_NS = 'org.reso.metadata.enums.';

/** Generates a random lookup value from available lookups for a given type or lookup name.
 *  Uses whatever the metadata provides — values must be advertised in metadata.
 *  Tries multiple key formats: full type, short name, and RESO-namespaced name. */
export const randomLookupValue = (type: string, lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>): string | undefined => {
  const shortName = type.includes('.') ? type.slice(type.lastIndexOf('.') + 1) : type;
  const values = lookups[type]
    ?? lookups[shortName]
    ?? lookups[`${RESO_ENUM_NS}${shortName}`]
    ?? lookups[`${RESO_ENUM_NS}${type}`];
  if (!values || values.length === 0) return undefined;
  const chosen = randomChoice(values);
  // Prefer the StandardName annotation (human-friendly, matches Lookup Resource LookupValue)
  // over the raw lookupValue (CamelCase OData enum member name)
  const standardName = chosen.annotations?.find(a => a.term === 'RESO.OData.Metadata.StandardName')?.value;
  return standardName ?? chosen.lookupValue;
};

/**
 * Field-name-based numeric bounds. Matched by substring so they apply
 * across all resources without per-generator overrides. Order matters —
 * first match wins. More specific patterns go first.
 */
const NUMERIC_BOUNDS: ReadonlyArray<{
  readonly match: (name: string) => boolean;
  readonly min: number;
  readonly max: number;
  readonly decimals?: number;
}> = [
  // Coordinates
  { match: n => /Latitude/i.test(n), min: 25.0, max: 48.0, decimals: 6 },
  { match: n => /Longitude/i.test(n), min: -124.0, max: -71.0, decimals: 6 },

  // Years
  { match: n => /Year(Built|Renovated|Established|BuiltEffective)/i.test(n), min: 1920, max: 2025, decimals: 0 },
  { match: n => /Year/i.test(n), min: 2015, max: 2026, decimals: 0 },

  // Rates and percentages (0–1 scale)
  { match: n => /Rate|Ratio|Percent/i.test(n), min: 0.01, max: 0.15, decimals: 4 },

  // Prices (keep in property generator, but cap the fallback)
  { match: n => /Price|ClosePrice/i.test(n), min: 50000, max: 10000000, decimals: 2 },

  // Area / size
  { match: n => /Acres|IrrigationWaterRights/i.test(n), min: 0.1, max: 500, decimals: 2 },
  { match: n => /SquareFeet|SqFt|LivingArea|BuildingArea|FinishedArea|UnfinishedArea|GrossLivingArea|LeasableArea|AvailableArea|TotalGrossArea|TotalNetArea|ContiguousArea|DivisibleArea|FoundationArea|CultivatedArea|RangeArea|RoomArea|CommercialArea/i.test(n),
    min: 200, max: 50000, decimals: 2 },
  { match: n => /LotSize(?!Acres)/i.test(n), min: 1000, max: 200000, decimals: 2 },

  // Counts — specific small ranges
  { match: n => /Bathrooms|Bedrooms|MainLevel/i.test(n), min: 0, max: 6, decimals: 0 },
  { match: n => /Fireplaces|Stories|StoriesTotal/i.test(n), min: 1, max: 4, decimals: 0 },
  { match: n => /GarageSpaces|CarportSpaces|ParkingSpaces|CoveredSpaces|OpenParking/i.test(n), min: 0, max: 6, decimals: 0 },
  { match: n => /NumberOfPads/i.test(n), min: 1, max: 10, decimals: 0 },
  { match: n => /NumberOfUnits|NumberOfBuildings|NumberOfLots/i.test(n), min: 1, max: 75, decimals: 0 },
  { match: n => /NumberOf(Elevators|FreightElevators|Cranes|DockDoors|DriveInDoors|LoadingDocks|RailDoors)/i.test(n), min: 0, max: 10, decimals: 0 },
  { match: n => /NumberOf(FullTime|PartTime)Employees/i.test(n), min: 1, max: 200, decimals: 0 },
  { match: n => /NumberOf(Tenants|Branches)/i.test(n), min: 1, max: 50, decimals: 0 },
  { match: n => /NumberOf(SeparateElectric|SeparateGas|SeparateWater)Meters/i.test(n), min: 1, max: 20, decimals: 0 },
  { match: n => /MaximumNumberOfPets|MaximumPetsAllowed/i.test(n), min: 0, max: 5, decimals: 0 },
  { match: n => /Rooms|Seating/i.test(n), min: 1, max: 20, decimals: 0 },
  { match: n => /Count$|Logins$|ViewCount|ImpressionCount/i.test(n), min: 0, max: 500, decimals: 0 },

  // Days on market
  { match: n => /Days(On|In)/i.test(n), min: 1, max: 365, decimals: 0 },

  // Expense fields (monthly amounts)
  { match: n => /Expense|Fee(?!d)|Deposit|Rent(?!al)|ParkingFee/i.test(n), min: 25, max: 5000, decimals: 2 },

  // Income
  { match: n => /Income|RentCollected/i.test(n), min: 5000, max: 500000, decimals: 2 },

  // Tax
  { match: n => /Tax(Annual|Assessed|Other)/i.test(n), min: 500, max: 50000, decimals: 2 },

  // Lease amounts
  { match: n => /Lease(Amount|Rate)/i.test(n), min: 500, max: 10000, decimals: 2 },

  // Dimensions (feet)
  { match: n => /Height|Length|Width|Frontage/i.test(n), min: 5, max: 200, decimals: 1 },
  { match: n => /Elevation/i.test(n), min: 0, max: 14000, decimals: 0 },

  // Scores
  { match: n => /Score$/i.test(n), min: 0, max: 100, decimals: 0 },

  // Weight (pets)
  { match: n => /Weight/i.test(n), min: 5, max: 150, decimals: 0 },

  // Power/electrical
  { match: n => /Amperage/i.test(n), min: 100, max: 800, decimals: 0 },
  { match: n => /Voltage/i.test(n), min: 110, max: 480, decimals: 0 },
  { match: n => /NameplateCapacity|PowerProduction(Annual|Size)/i.test(n), min: 1, max: 500, decimals: 1 },

  // Sale price per unit/area
  { match: n => /SalePricePer/i.test(n), min: 50, max: 1000, decimals: 2 },
  { match: n => /LeasePricePer/i.test(n), min: 5, max: 100, decimals: 2 },

  // Vacancy allowance (dollar amount)
  { match: n => /VacancyAllowance$/i.test(n), min: 1000, max: 25000, decimals: 2 },

  // Image/screen dimensions (pixels)
  { match: n => /ImageHeight|ImageWidth|ScreenHeight|ScreenWidth/i.test(n), min: 100, max: 4096, decimals: 0 },
  { match: n => /ColorDepth/i.test(n), min: 8, max: 32, decimals: 0 },

  // Pasture / irrigated area
  { match: n => /PastureArea/i.test(n), min: 0, max: 500, decimals: 2 },

  // Order / sequence
  { match: n => /Order$|Sequence$/i.test(n), min: 1, max: 100, decimals: 0 },

  // Street number
  { match: n => /StreetNumberNumeric/i.test(n), min: 100, max: 9999, decimals: 0 },

  // Entry / floor level
  { match: n => /EntryLevel|Level/i.test(n), min: 1, max: 10, decimals: 0 },

  // Timezone offset
  { match: n => /TimeZone.*Offset/i.test(n), min: -12, max: -4, decimals: 0 },

  // Air rights
  { match: n => /AirRights/i.test(n), min: 0, max: 100, decimals: 0 },

  // Showing advance notice (hours)
  { match: n => /AdvanceNotice/i.test(n), min: 1, max: 48, decimals: 0 },

  // Green verification metric
  { match: n => /GreenVerificationMetric/i.test(n), min: 0, max: 100, decimals: 1 },

  // Organization member count
  { match: n => /MemberCount|CommitteeCount/i.test(n), min: 10, max: 5000, decimals: 0 },

  // Mobile home dimensions
  { match: n => /MobileLength|MobileWidth/i.test(n), min: 10, max: 80, decimals: 0 },
];

/** Find field-name-based bounds, if any. */
const findBounds = (fieldName: string): { min: number; max: number; decimals?: number } | undefined =>
  NUMERIC_BOUNDS.find(b => b.match(fieldName));

/**
 * Generates a value for a single field based on its Edm type and constraints.
 * Returns undefined if the field should be skipped.
 */
export const generateFieldValue = (
  field: ResoField,
  lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>,
  index: number
): unknown => {
  const { type, fieldName, maxLength, scale } = field;

  // Skip computed/server-generated fields
  if (SKIP_FIELDS.has(fieldName)) return undefined;

  // Skip key fields — server generates these
  if (fieldName.endsWith('Key') && fieldName.length > 3) return undefined;

  // Skip expansion fields — they reference other entities, loaded via $expand
  if (field.isExpansion) return undefined;

  // Handle collection types
  if (field.isCollection || type.startsWith('Collection(')) {
    const innerType = type.replace(/^Collection\(/, '').replace(/\)$/, '');
    if (isEnumType(innerType)) {
      const values = lookups[innerType];
      if (values && values.length > 0) {
        const count = Math.min(randomInt(1, 3), values.length);
        const shuffled = [...values].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, count).map(v => {
          const sn = v.annotations?.find(a => a.term === 'RESO.OData.Metadata.StandardName')?.value;
          return sn ?? v.lookupValue;
        });
      }
    }
    return [];
  }

  // Handle enum types
  if (isEnumType(type)) {
    return randomLookupValue(type, lookups);
  }

  // Handle Edm.String fields with a LookupName annotation — sample from the lookup pool
  if (type === 'Edm.String') {
    const lookupNameAnnotation = field.annotations.find(a => a.term === 'RESO.OData.Metadata.LookupName');
    if (lookupNameAnnotation) {
      // Try both short name and fully qualified name to match however the lookups are keyed
      const value = randomLookupValue(lookupNameAnnotation.value, lookups);
      if (value) return value;
    }
  }

  // Handle primitive Edm types
  switch (type) {
    case 'Edm.String':
      return randomString(fieldName, index, maxLength);

    case 'Edm.Boolean':
      return randomBool();

    case 'Edm.Int16': {
      const b16 = findBounds(fieldName);
      const min16 = Math.ceil(b16?.min ?? 0);
      const max16 = Math.floor(b16?.max ?? 100);
      return randomInt(min16 <= max16 ? min16 : 0, min16 <= max16 ? max16 : 100);
    }

    case 'Edm.Int32': {
      const b32 = findBounds(fieldName);
      const min32 = Math.ceil(b32?.min ?? 0);
      const max32 = Math.floor(b32?.max ?? 10000);
      return randomInt(min32 <= max32 ? min32 : 0, min32 <= max32 ? max32 : 10000);
    }

    case 'Edm.Int64': {
      const b64 = findBounds(fieldName);
      // Respect maxLength as digit count bound (e.g., maxLength=10 → max 9999999999)
      const lengthMax = maxLength ? 10 ** Math.min(maxLength, 15) - 1 : 100000;
      const min64 = Math.ceil(b64?.min ?? 0);
      const max64 = Math.floor(b64?.max ?? lengthMax);
      return randomInt(min64 <= max64 ? min64 : 0, min64 <= max64 ? max64 : lengthMax);
    }

    case 'Edm.Byte':
      return randomInt(0, 255);

    case 'Edm.Decimal':
    case 'Edm.Double':
    case 'Edm.Single': {
      const s = scale ?? 2;
      // Max value allowed by the field's precision and scale
      const precisionMax = field.precision ? 10 ** (field.precision - s) - 1 : 100000;
      const bounds = findBounds(fieldName);
      if (bounds) {
        const effectiveMax = Math.min(bounds.max, precisionMax);
        const effectiveMin = Math.min(bounds.min, effectiveMax);
        return randomDecimal(effectiveMin, effectiveMax, bounds.decimals ?? s);
      }
      const maxVal = Math.min(precisionMax, 100000);
      return randomDecimal(0, maxVal, s);
    }

    case 'Edm.Date':
      return randomDate();

    case 'Edm.DateTimeOffset':
      return randomDateTimeOffset();

    case 'Edm.TimeOfDay':
      return randomTimeOfDay();

    case 'Edm.Guid':
      return crypto.randomUUID();

    default:
      // Unknown type — generate a string fallback
      if (isIntType(type)) return randomInt(0, 1000);
      return randomString(fieldName, index, maxLength);
  }
};

/** Default fill rate for nullable fields (0.0 to 1.0). */
const DEFAULT_FILL_RATE = 0.6;

/**
 * Generates a single record with values for non-key, non-computed fields.
 * Nullable fields are randomly included based on the fill rate to produce
 * realistic sparse records (real-world data rarely populates every field).
 * Resource-specific generators can override individual field values after this.
 */
export const generateRecord = (
  fields: ReadonlyArray<ResoField>,
  lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>,
  index: number,
  fillRate = DEFAULT_FILL_RATE
): Record<string, unknown> => {
  const record: Record<string, unknown> = {};

  for (const field of fields) {
    // Randomly skip nullable fields to produce realistic sparse records
    if (field.nullable !== false && Math.random() > fillRate) continue;

    const value = generateFieldValue(field, lookups, index);
    if (value !== undefined) {
      record[field.fieldName] = value;
    }
  }

  return record;
};

/**
 * Generates multiple records for a resource.
 * This is the generic generator — resource-specific generators wrap this
 * and apply overrides for realistic domain-specific values.
 */
export const generateRecords = (
  fields: ReadonlyArray<ResoField>,
  lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>,
  count: number
): ReadonlyArray<Record<string, unknown>> => Array.from({ length: count }, (_, i) => generateRecord(fields, lookups, i));
