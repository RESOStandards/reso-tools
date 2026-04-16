import { generateRecord, randomChoice, randomDecimal, randomInt, isPlaceholderValue } from './field-generator.js';
import { randomLocation, jitterCoords } from './geo-data.js';
import type { ResoField, ResoLookup } from './types.js';

/**
 * Effective property tax rates by US state (2024 data).
 * Source: Tax Foundation / American Community Survey.
 * Rates expressed as decimal fractions (e.g., 0.0179 = 1.79%).
 */
const STATE_TAX_RATES: Readonly<Record<string, number>> = {
  AL: 0.0037,
  AZ: 0.0043,
  AR: 0.0054,
  CA: 0.0069,
  CO: 0.0052,
  CT: 0.0136,
  DE: 0.0051,
  FL: 0.0076,
  GA: 0.0077,
  HI: 0.0031,
  ID: 0.0043,
  IL: 0.0179,
  IN: 0.0076,
  IA: 0.0125,
  KS: 0.012,
  KY: 0.0072,
  LA: 0.0056,
  ME: 0.009,
  MD: 0.009,
  MA: 0.0095,
  MI: 0.0113,
  MN: 0.0099,
  MS: 0.0054,
  MO: 0.0085,
  MT: 0.0059,
  NE: 0.0138,
  NV: 0.005,
  NH: 0.0135,
  NJ: 0.0168,
  NM: 0.0061,
  NY: 0.0123,
  NC: 0.0062,
  ND: 0.0094,
  OH: 0.0128,
  OK: 0.0078,
  OR: 0.0079,
  PA: 0.0114,
  RI: 0.01,
  SC: 0.0044,
  SD: 0.01,
  TN: 0.0046,
  TX: 0.0125,
  UT: 0.0045,
  VT: 0.014,
  VA: 0.0075,
  WA: 0.0074,
  WV: 0.0048,
  WI: 0.0119,
  WY: 0.0058
};

const FALLBACK_STREET_NAMES = [
  'Main', 'Oak', 'Maple', 'Cedar', 'Elm', 'Pine', 'Washington',
  'Park', 'Lake', 'Hill', 'Sunset', 'River', 'Spring', 'Valley'
];

const STREET_SUFFIXES = ['St', 'Ave', 'Blvd', 'Dr', 'Ln', 'Ct', 'Pl', 'Way', 'Rd', 'Cir'];

/**
 * Representative MLS system names and IDs for OriginatingSystem / SourceSystem
 * fields. Sampled from the RESO OUID directory for realistic test data.
 */
const MLS_SYSTEMS: ReadonlyArray<{ readonly name: string; readonly id: string }> = [
  { name: 'Bright MLS', id: 'BMLS' },
  { name: 'Stellar MLS', id: 'STLR' },
  { name: 'CRMLS', id: 'CRMLS' },
  { name: 'Realcomp', id: 'RCOMP' },
  { name: 'MRED', id: 'MRED' },
  { name: 'HAR.com', id: 'HAR' },
  { name: 'NWMLS', id: 'NWMLS' },
  { name: 'Canopy MLS', id: 'CMLS' },
  { name: 'REcolorado', id: 'RECO' },
  { name: 'BeachesMLS', id: 'BMFL' },
  { name: 'ARMLS', id: 'ARMLS' },
  { name: 'Flexmls', id: 'FLEX' },
  { name: 'GAMLS', id: 'GAMLS' },
  { name: 'MLS PIN', id: 'PIN' },
  { name: 'OneKey MLS', id: 'OKEY' },
  { name: 'Triangle MLS', id: 'TMLS' },
  { name: 'Northstar MLS', id: 'NSTAR' },
  { name: 'ACTRIS', id: 'ACTRS' },
  { name: 'IRMLS', id: 'IRMLS' },
  { name: 'My Florida Regional MLS', id: 'MFRMLS' },
];

const PROPERTY_TYPES = ['Residential', 'Commercial', 'Land', 'Farm'];

const PROPERTY_SUBTYPES = ['SingleFamilyResidence', 'Condominium', 'Townhouse', 'Apartment', 'ManufacturedHome', 'MultiFamily'];

/**
 * RESO agent/office role prefixes. Each Property can have up to 6 agent
 * roles and 6 office roles, flattened from Member and Office records.
 */
const AGENT_PREFIXES = ['BuyerAgent', 'CoBuyerAgent', 'ListAgent', 'CoListAgent', 'SellingAgent', 'CoSellingAgent'] as const;
const OFFICE_PREFIXES = ['BuyerOffice', 'CoBuyerOffice', 'ListOffice', 'CoListOffice', 'SellingOffice', 'CoSellingOffice'] as const;

/** Map from Member field names to their Property-flattened suffixes. */
const MEMBER_FIELD_MAP: ReadonlyArray<readonly [string, string]> = [
  ['MemberKey', 'Key'],
  ['MemberFirstName', 'FirstName'],
  ['MemberLastName', 'LastName'],
  ['MemberFullName', 'FullName'],
  ['MemberMiddleName', 'MiddleName'],
  ['MemberNamePrefix', 'NamePrefix'],
  ['MemberNameSuffix', 'NameSuffix'],
  ['MemberNickname', 'Nickname'],
  ['MemberEmail', 'Email'],
  ['MemberDirectPhone', 'DirectPhone'],
  ['MemberOfficePhone', 'OfficePhone'],
  ['MemberOfficePhoneExt', 'OfficePhoneExt'],
  ['MemberMobilePhone', 'MobilePhone'],
  ['MemberPreferredPhone', 'PreferredPhone'],
  ['MemberTollFreePhone', 'TollFreePhone'],
  ['MemberFax', 'Fax'],
  ['MemberVoiceMail', 'VoiceMail'],
  ['MemberVoiceMailExt', 'VoiceMailExt'],
  ['MemberStateLicense', 'StateLicense'],
  ['MemberNationalAssociationId', 'NationalAssociationId'],
  ['MemberDesignation', 'Designation'],
  ['MemberAOR', 'AOR'],
  ['MemberAORMlsId', 'AORMlsId'],
  ['MemberMlsId', 'MlsId'],
  ['MemberUrl', 'URL'],
  ['MemberAddress1', 'Address1'],
  ['MemberCity', 'City'],
  ['MemberStateOrProvince', 'StateOrProvince'],
  ['MemberPostalCode', 'PostalCode'],
];

/** Map from Office field names to their Property-flattened suffixes. */
const OFFICE_FIELD_MAP: ReadonlyArray<readonly [string, string]> = [
  ['OfficeKey', 'Key'],
  ['OfficeName', 'Name'],
  ['OfficePhone', 'Phone'],
  ['OfficePhoneExt', 'PhoneExt'],
  ['OfficeFax', 'Fax'],
  ['OfficeEmail', 'Email'],
  ['OfficeUrl', 'URL'],
  ['OfficeMlsId', 'MlsId'],
  ['OfficeNationalAssociationId', 'NationalAssociationId'],
  ['OfficeAOR', 'AOR'],
  ['OfficeAORMlsId', 'AORMlsId'],
  ['OfficeAddress1', 'Address1'],
  ['OfficeCity', 'City'],
  ['OfficeStateOrProvince', 'StateOrProvince'],
  ['OfficePostalCode', 'PostalCode'],
];

/** Flatten a Member record into a Property record under a role prefix.
 *  Only writes fields that exist in the target resource's metadata. */
const flattenMember = (
  record: Record<string, unknown>,
  member: Record<string, unknown>,
  prefix: string,
  targetFields?: ReadonlySet<string>
): void => {
  for (const [memberField, suffix] of MEMBER_FIELD_MAP) {
    const targetFieldName = `${prefix}${suffix}`;
    if (targetFields && !targetFields.has(targetFieldName)) continue;
    const val = member[memberField];
    if (val !== undefined) record[targetFieldName] = val;
  }
};

/** Flatten an Office record into a Property record under a role prefix.
 *  Only writes fields that exist in the target resource's metadata. */
const flattenOffice = (
  record: Record<string, unknown>,
  office: Record<string, unknown>,
  prefix: string,
  targetFields?: ReadonlySet<string>
): void => {
  for (const [officeField, suffix] of OFFICE_FIELD_MAP) {
    const targetFieldName = `${prefix}${suffix}`;
    if (targetFields && !targetFields.has(targetFieldName)) continue;
    const val = office[officeField];
    if (val !== undefined) record[targetFieldName] = val;
  }
};

/**
 * Re-flatten agent/office fields on a Property record using the FK keys
 * already assigned (e.g., by the FK resolver). Looks up the member/office
 * by their key in the pool and overwrites the flattened fields to match.
 * Call this after FK injection to ensure consistency.
 */
export const reflattenAgentFields = (
  record: Record<string, unknown>,
  memberPool: ReadonlyArray<Record<string, unknown>>,
  officePool: ReadonlyArray<Record<string, unknown>>,
  targetFields?: ReadonlySet<string>
): void => {
  const memberByKey = new Map(
    [...memberPool].map(m => [m.MemberKey as string, m])
  );
  const officeByKey = new Map(
    [...officePool].map(o => [o.OfficeKey as string, o])
  );

  const rolePairs: ReadonlyArray<readonly [string, string]> = [
    ['ListAgent', 'ListOffice'],
    ['BuyerAgent', 'BuyerOffice'],
    ['CoBuyerAgent', 'CoBuyerOffice'],
    ['CoListAgent', 'CoListOffice'],
    ['SellingAgent', 'SellingOffice'],
    ['CoSellingAgent', 'CoSellingOffice'],
  ];

  for (const [agentPrefix, officePrefix] of rolePairs) {
    const agentKey = record[`${agentPrefix}Key`] as string | undefined;
    if (!agentKey) continue;

    const member = memberByKey.get(agentKey);
    if (member) {
      flattenMember(record, member, agentPrefix, targetFields);
      // Derive office from the member's OfficeKey
      const memberOfficeKey = member.OfficeKey as string | undefined;
      const office = memberOfficeKey ? officeByKey.get(memberOfficeKey) : undefined;
      if (office) {
        flattenOffice(record, office, officePrefix, targetFields);
      }
    }
  }
};

/** Generates realistic Property records with domain-specific overrides. */
export const generatePropertyRecords = (
  fields: ReadonlyArray<ResoField>,
  lookups: Readonly<Record<string, ReadonlyArray<ResoLookup>>>,
  count: number,
  _parentResource?: string,
  _parentKey?: string,
  memberPool?: ReadonlyArray<Record<string, unknown>>,
  officePool?: ReadonlyArray<Record<string, unknown>>
): ReadonlyArray<Record<string, unknown>> => {
  // Build a set of declared non-expansion field names so flattening only writes fields in the metadata
  const declaredFields = new Set(fields.filter(f => !f.isExpansion).map(f => f.fieldName));

  return Array.from({ length: count }, (_, i) => {
    const record = generateRecord(fields, lookups, i);

    // ListingId — human-friendly MLS-style ID (e.g., "24-012345", "MLS-78901")
    const listingIdPrefixes = ['', 'MLS-', `${new Date().getFullYear().toString().slice(-2)}-`];
    record.ListingId = `${randomChoice(listingIdPrefixes)}${randomInt(100000, 999999)}`;

    // Originating / Source system — realistic MLS names from RESO OUID directory
    const originSystem = randomChoice([...MLS_SYSTEMS]);
    const sourceSystem = randomChoice([...MLS_SYSTEMS]);
    record.OriginatingSystemName = originSystem.name;
    record.OriginatingSystemID = originSystem.id;
    record.SourceSystemName = sourceSystem.name;
    record.SourceSystemID = sourceSystem.id;

    // Address overrides — use city-specific street names from geo-data
    const location = randomLocation();
    record.StreetNumber = String(randomInt(100, 9999));
    record.StreetName = location.streets.length
      ? randomChoice([...location.streets])
      : randomChoice(FALLBACK_STREET_NAMES);
    const streetSuffixValues = lookups['StreetSuffix'];
    record.StreetSuffix = streetSuffixValues?.length ? randomChoice(streetSuffixValues).lookupValue : randomChoice(STREET_SUFFIXES);
    record.UnparsedAddress = `${record.StreetNumber} ${record.StreetName} ${record.StreetSuffix}`;
    // Use consistent city/state/zip/lat/lon from the selected location
    const cityValues = lookups['City'] ?? lookups['org.reso.metadata.enums.City'];
    record.City = cityValues?.length ? randomChoice(cityValues).lookupValue : location.city;
    record.StateOrProvince = location.state;
    record.PostalCode = location.zip;
    record.Country = 'US';
    const coords = jitterCoords(location.lat, location.lon);
    record.Latitude = Number(coords.lat.toFixed(6));
    record.Longitude = Number(coords.lon.toFixed(6));

    // Pricing — ListPrice >= ListPriceLow
    record.ListPrice = Math.round(randomDecimal(50000, 10000000, 0));
    record.ListPriceLow = Math.round((record.ListPrice as number) * (0.8 + Math.random() * 0.2));
    record.OriginalListPrice = record.ListPrice;

    // Bedrooms
    record.BedroomsTotal = randomInt(1, 6);

    // Bathrooms — generate parts first, then compute total
    record.BathroomsFull = randomInt(1, 4);
    record.BathroomsHalf = randomInt(0, 2);
    record.BathroomsPartial = Math.random() > 0.7 ? randomInt(0, 1) : 0;
    record.BathroomsOneQuarter = 0;
    record.BathroomsThreeQuarter = Math.random() > 0.8 ? randomInt(0, 1) : 0;
    record.BathroomsTotalInteger =
      (record.BathroomsFull as number) +
      (record.BathroomsHalf as number) +
      (record.BathroomsPartial as number) +
      (record.BathroomsOneQuarter as number) +
      (record.BathroomsThreeQuarter as number);
    record.LivingArea = Math.round(randomDecimal(500, 8000, 0));
    record.LotSizeSquareFeet = Math.round(randomDecimal(2000, 50000, 0));
    record.YearBuilt = randomInt(1950, 2024);

    // Property type — prefer lookup values, fall back to hardcoded
    const propertyTypeValues = lookups['PropertyType'];
    record.PropertyType = propertyTypeValues?.length ? randomChoice(propertyTypeValues).lookupValue : randomChoice(PROPERTY_TYPES);
    const propertySubTypeValues = lookups['PropertySubType'];
    record.PropertySubType = propertySubTypeValues?.length
      ? randomChoice(propertySubTypeValues).lookupValue
      : randomChoice(PROPERTY_SUBTYPES);

    // Status — prefer Active for most generated listings
    const statusValues = lookups['StandardStatus'];
    if (statusValues && statusValues.length > 0) {
      const activeStatus = statusValues.find(s => s.lookupValue === 'Active');
      record.StandardStatus = activeStatus
        ? Math.random() > 0.3
          ? 'Active'
          : randomChoice(statusValues).lookupValue
        : randomChoice(statusValues).lookupValue;
    }

    // Taxes — calculated from ListPrice × state effective rate
    const taxRate = STATE_TAX_RATES[record.StateOrProvince as string] ?? 0.01;
    const listPrice = record.ListPrice as number;
    record.TaxAnnualAmount = Math.round(listPrice * taxRate * (0.9 + Math.random() * 0.2));
    record.TaxAssessedValue = Math.round(listPrice * (0.7 + Math.random() * 0.25));
    record.TaxYear = new Date().getFullYear() - randomInt(0, 1);

    // Unit counts (for multi-family / manufactured / mobile home)
    record.NumberOfUnitsTotal = randomInt(1, 75);
    record.NumberOfPads = randomInt(1, 10);
    const unitsTotal = record.NumberOfUnitsTotal as number;
    record.NumberOfUnitsLeased = randomInt(0, unitsTotal);
    record.NumberOfUnitsVacant = unitsTotal - (record.NumberOfUnitsLeased as number);
    record.NumberOfUnitsMonthToMonth = randomInt(0, record.NumberOfUnitsLeased as number);

    // Expense fields (realistic monthly/annual amounts)
    // Use Math.round on all monetary fields — some DD implementations
    // type these as Edm.Int64 rather than Edm.Decimal.
    record.AssociationFee = Math.round(randomDecimal(50, 800, 2));
    record.AssociationFee2 = Math.random() > 0.7 ? Math.round(randomDecimal(25, 200, 2)) : 0;
    record.InsuranceExpense = Math.round(randomDecimal(50, 500, 2));
    record.ElectricExpense = Math.round(randomDecimal(50, 400, 2));
    record.WaterSewerExpense = Math.round(randomDecimal(20, 150, 2));
    record.TrashExpense = Math.round(randomDecimal(10, 75, 2));
    record.CableTvExpense = Math.round(randomDecimal(30, 200, 2));
    record.MaintenanceExpense = Math.round(randomDecimal(50, 500, 2));
    record.OperatingExpense = Math.round(randomDecimal(100, 2000, 2));
    record.OtherExpense = Math.round(randomDecimal(0, 300, 2));
    record.GardenerExpense = Math.round(randomDecimal(50, 500, 2));
    record.ManagerExpense = Math.round(randomDecimal(200, 3000, 2));
    record.PoolExpense = Math.round(randomDecimal(50, 400, 2));
    record.SuppliesExpense = Math.round(randomDecimal(25, 500, 2));
    record.ProfessionalManagementExpense = Math.round(randomDecimal(200, 5000, 2));
    record.FurnitureReplacementExpense = Math.round(randomDecimal(0, 2000, 2));
    record.NewTaxesExpense = Math.round(randomDecimal(500, 15000, 2));

    // Income — derive from units × realistic monthly rent
    const monthlyRent = Math.round(randomDecimal(800, 3500, 2));
    record.GrossScheduledIncome = Math.round(randomDecimal(
      monthlyRent * unitsTotal * 10,
      monthlyRent * unitsTotal * 12,
      0
    ));
    record.VacancyAllowance = Math.round(randomDecimal(1000, 15000, 2));

    // Cap rate (3%–12%) — this is genuinely a decimal field
    record.CapRate = randomDecimal(0.03, 0.12, 4);

    // Land / lot — these are genuinely decimal fields
    record.LotSizeAcres = randomDecimal(0.1, 500, 2);
    record.LandLeaseAmount = Math.round(randomDecimal(500, 5000, 2));
    record.LotSizeUnits = 'Square Feet';
    record.PastureArea = randomDecimal(0, 200, 2);

    // Dates
    const listDate = new Date(Date.now() - randomInt(1, 365) * 86400000);
    record.ListingContractDate = listDate.toISOString().split('T')[0];
    record.OnMarketDate = record.ListingContractDate;

    // Text fields
    record.PublicRemarks = `Beautiful ${record.BedroomsTotal}-bedroom home located at ${record.UnparsedAddress}, ${record.City}. Features ${record.LivingArea} sqft of living space built in ${record.YearBuilt}.`;

    // Flatten agent/office roles from pools when available.
    // Strategy: pick a Member, find their Office, fill co-agents
    // from the same office for relational integrity.
    if (memberPool && memberPool.length > 0 && officePool && officePool.length > 0) {
      const officeByKey = new Map(
        [...officePool].map(o => [o.OfficeKey as string, o])
      );

      // Group members by their office for co-agent selection
      const membersByOffice = new Map<string, Array<Record<string, unknown>>>();
      for (const m of memberPool) {
        const oKey = m.OfficeKey as string | undefined;
        if (oKey) {
          const list = membersByOffice.get(oKey) ?? [];
          list.push(m);
          membersByOffice.set(oKey, list);
        }
      }

      // Each agent role pair: pick a member, derive their office,
      // pick co-agent from same office
      const rolePairs: ReadonlyArray<readonly [string, string, string, string]> = [
        ['ListAgent', 'ListOffice', 'CoListAgent', 'CoListOffice'],
        ['BuyerAgent', 'BuyerOffice', 'CoBuyerAgent', 'CoBuyerOffice'],
        ['SellingAgent', 'SellingOffice', 'CoSellingAgent', 'CoSellingOffice'],
      ];

      for (const [agentPrefix, officePrefix, coAgentPrefix, coOfficePrefix] of rolePairs) {
        const isRequired = agentPrefix === 'ListAgent' || agentPrefix === 'BuyerAgent';
        if (!isRequired && Math.random() > 0.3) continue;

        const agent = randomChoice([...memberPool]);
        flattenMember(record, agent, agentPrefix);

        // Derive office from the agent's OfficeKey
        const agentOfficeKey = agent.OfficeKey as string | undefined;
        const office = agentOfficeKey ? officeByKey.get(agentOfficeKey) : undefined;
        if (office) {
          flattenOffice(record, office, officePrefix);
        }

        // Co-agent: pick a different member from the same office (~40% chance)
        if (Math.random() > 0.6 && agentOfficeKey) {
          const sameOfficeMembers = membersByOffice.get(agentOfficeKey) ?? [];
          const coAgentCandidates = sameOfficeMembers.filter(
            m => m.MemberKey !== agent.MemberKey
          );
          if (coAgentCandidates.length > 0) {
            const coAgent = randomChoice(coAgentCandidates);
            flattenMember(record, coAgent, coAgentPrefix);
            if (office) flattenOffice(record, office, coOfficePrefix);
          }
        }
      }

      // Clean up: null out any agent/office prefixed fields that still
      // have Sample placeholder values from the base generator. These
      // are fields not present on the real Member/Office records.
      const allPrefixes = [...AGENT_PREFIXES, ...OFFICE_PREFIXES];
      for (const key of Object.keys(record)) {
        if (allPrefixes.some(p => key.startsWith(p))) {
          const val = record[key];
          if (typeof val === 'string' && val.startsWith('Sample ')) {
            delete record[key];
          }
        }
      }
    }

    return record;
  });
};
