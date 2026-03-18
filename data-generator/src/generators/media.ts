import { generateRecord, randomChoice, randomInt } from './field-generator.js';
import type { ResoField, ResoLookup } from './types.js';

/** Resource-specific media descriptions for realistic generated data. */
const MEDIA_DESCRIPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  Property: [
    'Front exterior view',
    'Living room',
    'Kitchen',
    'Master bedroom',
    'Backyard',
    'Bathroom',
    'Dining room',
    'Garage',
    'Pool area',
    'Aerial view',
    'Street view',
    'Family room',
    'Patio',
    'Laundry room',
    'Basement',
    'Attic',
    'Garden'
  ],
  Member: [
    'Professional headshot',
    'Team photo',
    'Office portrait',
    'Casual profile photo',
    'Conference presentation',
    'Award ceremony',
    'Company logo',
    'Business card photo'
  ],
  Office: [
    'Building exterior',
    'Office entrance',
    'Reception area',
    'Conference room',
    'Office logo',
    'Street view of building',
    'Aerial view of office',
    'Interior workspace'
  ]
};

/** Fallback descriptions for resources without specific ones. */
const DEFAULT_DESCRIPTIONS: ReadonlyArray<string> = [
  'Primary photo',
  'Detail view',
  'Additional photo',
  'Overview image',
  'Supplemental image'
];

/** Human-readable labels for resources in long descriptions. */
const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  Property: 'the property',
  Member: 'the agent',
  Office: 'the office'
};

const getDescriptions = (resource?: string): ReadonlyArray<string> =>
  (resource ? MEDIA_DESCRIPTIONS[resource] : undefined) ?? DEFAULT_DESCRIPTIONS;

const getResourceLabel = (resource?: string): string =>
  (resource ? RESOURCE_LABELS[resource] : undefined) ?? 'the record';

/**
 * Generates realistic Media records linked to a parent resource.
 * Sets ResourceName and ResourceRecordKey for the RESO FK convention.
 */
export const generateMediaRecords = (
  fields: ReadonlyArray<ResoField>,
  lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>,
  count: number,
  parentResource?: string,
  parentKey?: string
): ReadonlyArray<Record<string, unknown>> =>
  Array.from({ length: count }, (_, i) => {
    const record = generateRecord(fields, lookups, i);

    // Link to parent via RESO FK convention
    if (parentResource) record.ResourceName = parentResource;
    if (parentKey) record.ResourceRecordKey = parentKey;

    // Media-specific fields
    const descriptions = getDescriptions(parentResource);
    record.MediaURL = `https://picsum.photos/seed/${parentKey ?? 'media'}-${i}/800/600`;
    record.ShortDescription = randomChoice(descriptions);
    record.LongDescription = `${record.ShortDescription} of ${getResourceLabel(parentResource)}`;
    record.Order = i + 1;
    record.MediaObjectID = `IMG-${String(randomInt(100000, 999999))}`;

    // Media category — prefer Photo
    const categoryValues = lookups['org.reso.metadata.enums.MediaCategory'];
    if (categoryValues && categoryValues.length > 0) {
      const photo = categoryValues.find(c => c.lookupValue === 'Photo');
      // First image is always a Photo, rest can be mixed
      record.MediaCategory = i === 0 && photo ? 'Photo' : randomChoice(categoryValues).lookupValue;
    }

    return record;
  });
