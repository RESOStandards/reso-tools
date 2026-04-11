import { generateRecord, randomChoice, randomInt } from './field-generator.js';
import { randomLocation } from './geo-data.js';
import type { ResoField, ResoLookup } from './types.js';

const BROKERAGE_PREFIXES = [
  'Premier',
  'Elite',
  'Golden',
  'Pacific',
  'Atlantic',
  'National',
  'Heritage',
  'Landmark',
  'Summit',
  'Pinnacle',
  'Horizon',
  'Crest'
];

const BROKERAGE_SUFFIXES = [
  'Realty',
  'Real Estate',
  'Properties',
  'Homes',
  'Realty Group',
  'Real Estate Group',
  'Property Group',
  'Brokerage'
];

const FALLBACK_STREET_NAMES = ['Commerce', 'Business', 'Corporate', 'Center', 'Market', 'Trade'];

/** Generates a realistic phone number. */
const randomPhone = (): string => {
  const area = randomInt(200, 999);
  const prefix = randomInt(200, 999);
  const line = randomInt(1000, 9999);
  return `${area}-${prefix}-${line}`;
};

/** Generates realistic Office records with domain-specific overrides. */
export const generateOfficeRecords = (
  fields: ReadonlyArray<ResoField>,
  lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>,
  count: number
): ReadonlyArray<Record<string, unknown>> =>
  Array.from({ length: count }, (_, i) => {
    const record = generateRecord(fields, lookups, i);

    const prefix = randomChoice(BROKERAGE_PREFIXES);
    const suffix = randomChoice(BROKERAGE_SUFFIXES);

    record.OfficeName = `${prefix} ${suffix}`;
    record.OfficePhone = randomPhone();
    record.OfficeFax = randomPhone();
    record.OfficeEmail = `info@${prefix.toLowerCase()}${suffix.replace(/\s/g, '').toLowerCase()}.example.com`;

    // Address — geo-consistent from real US locations
    const location = randomLocation();
    const streetName = location.streets.length
      ? randomChoice([...location.streets])
      : randomChoice(FALLBACK_STREET_NAMES);
    record.OfficeAddress1 = `${randomInt(100, 9999)} ${streetName} Blvd`;
    record.OfficeCity = location.city;
    record.OfficeStateOrProvince = location.state;
    record.OfficePostalCode = location.zip;
    record.OfficeCountry = 'US';

    // Status — prefer Active
    const statusValues = lookups['OfficeStatus'];
    if (statusValues && statusValues.length > 0) {
      const active = statusValues.find(s => s.lookupValue === 'Active');
      record.OfficeStatus = active ? 'Active' : randomChoice(statusValues).lookupValue;
    }

    // IDs
    record.OfficeNationalAssociationId = `NRDS${String(randomInt(100000, 999999))}`;
    record.OfficeMlsId = `O${String(randomInt(10000, 99999))}`;

    return record;
  });
