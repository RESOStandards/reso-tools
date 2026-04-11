import { generateRecord, randomChoice, randomInt } from './field-generator.js';
import { randomLocation } from './geo-data.js';
import type { ResoField, ResoLookup } from './types.js';

const FIRST_NAMES = [
  'James',
  'Mary',
  'Robert',
  'Patricia',
  'John',
  'Jennifer',
  'Michael',
  'Linda',
  'David',
  'Elizabeth',
  'William',
  'Barbara',
  'Richard',
  'Susan',
  'Joseph',
  'Jessica',
  'Thomas',
  'Sarah',
  'Christopher',
  'Karen',
  'Daniel',
  'Lisa',
  'Matthew',
  'Nancy',
  'Anthony',
  'Betty',
  'Mark',
  'Margaret',
  'Steven',
  'Sandra',
  'Andrew',
  'Ashley'
];

const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
  'Walker'
];

const FALLBACK_STREET_NAMES = ['Main', 'Oak', 'Maple', 'Cedar', 'Elm', 'Pine', 'Washington', 'Park'];

const STREET_SUFFIXES = ['St', 'Ave', 'Blvd', 'Dr', 'Ln', 'Rd'];

const EMAIL_DOMAINS = ['realestate.example.com', 'homes.example.com', 'property.example.com', 'realty.example.com', 'broker.example.com'];

const DESIGNATIONS = ['CRS', 'ABR', 'GRI', 'SRES', 'SRS', 'CIPS'];

/** Generates a realistic phone number. */
const randomPhone = (): string => {
  const area = randomInt(200, 999);
  const prefix = randomInt(200, 999);
  const line = randomInt(1000, 9999);
  return `${area}-${prefix}-${line}`;
};

/** Generates realistic Member records with domain-specific overrides. */
export const generateMemberRecords = (
  fields: ReadonlyArray<ResoField>,
  lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>,
  count: number
): ReadonlyArray<Record<string, unknown>> =>
  Array.from({ length: count }, (_, i) => {
    const record = generateRecord(fields, lookups, i);

    const firstName = randomChoice(FIRST_NAMES);
    const lastName = randomChoice(LAST_NAMES);
    const domain = randomChoice(EMAIL_DOMAINS);

    record.MemberFirstName = firstName;
    record.MemberLastName = lastName;
    record.MemberFullName = `${firstName} ${lastName}`;
    record.MemberEmail = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`;
    record.MemberPreferredPhone = randomPhone();
    record.MemberDirectPhone = randomPhone();
    record.MemberOfficePhone = randomPhone();
    record.MemberMobilePhone = randomPhone();

    // Address — geo-consistent from real US locations
    const location = randomLocation();
    const streetName = location.streets.length
      ? randomChoice([...location.streets])
      : randomChoice(FALLBACK_STREET_NAMES);
    record.MemberAddress1 = `${randomInt(100, 9999)} ${streetName} ${randomChoice(STREET_SUFFIXES)}`;
    record.MemberCity = location.city;
    record.MemberStateOrProvince = location.state;
    record.MemberPostalCode = location.zip;
    record.MemberCountry = 'US';

    // Designations — prefer lookup values, fall back to hardcoded
    const designationValues = lookups['MemberDesignation'];
    const numDesignations = randomInt(0, 3);
    if (numDesignations > 0) {
      const source = designationValues?.length ? designationValues.map(v => v.lookupValue) : DESIGNATIONS;
      const shuffled = [...source].sort(() => Math.random() - 0.5);
      record.MemberDesignation = shuffled.slice(0, numDesignations);
    }

    // Status — prefer Active
    const statusValues = lookups['MemberStatus'];
    if (statusValues && statusValues.length > 0) {
      const active = statusValues.find(s => s.lookupValue === 'Active');
      record.MemberStatus = active ? 'Active' : randomChoice(statusValues).lookupValue;
    }

    // IDs
    record.MemberNationalAssociationId = `NAR${String(randomInt(100000, 999999))}`;
    record.MemberMlsId = `M${String(randomInt(10000, 99999))}`;

    return record;
  });
